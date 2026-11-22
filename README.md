# QuizLive

QuizLive is a live multiple-choice quiz for classrooms, built on [DeepSpace](https://docs.deep.space).
A host writes questions, or has AI draft them from pasted notes or an uploaded PDF, then starts a game.
Students join on their phones with a 6-character code and answer timed questions. Everyone watches the
leaderboard update after each reveal. The server owns the clock, the answer keys and the scoring, so the
results can be trusted. When the game ends, the host gets a results summary by email.

**Live:** https://quizlive.app.space (sign in with GitHub or Google; hosts start at `/quizzes`, players at `/play`)

Design decisions and their rationale are in [DESIGN.md](./DESIGN.md).

## Run locally

Requires Node 22.15+, 24 or 26, and npm 11.6+.

```bash
npm install
npx deepspace auth login      # once, opens a browser
npx deepspace dev start       # http://localhost:5173
```

## Tests

```bash
npm run test:unit             # Vitest: engine, permissions, scoring, AI parsing, uploads, email
npx deepspace test run        # Playwright smoke + API suites (starts its own server)
npx tsc --noEmit && npx eslint .
```

`deepspace test run` uses port 5173 by default. If the dev server is already running, add `--port 5180`.
`tests/live/` holds opt-in scripts that drive real browsers against a running server, including two
scripted players for a hosted game. See the header of each file for how to run it.

## Architecture

- **Schemas and permissions** (`src/schemas/quiz-schemas.ts`)
  - Every collection's read rule is declared in the schema and enforced by the Durable Object (DO)
    before any data is sent to a client.
  - `answerKeys` and `questions` are readable only by the host. Players see the live question through
    `games.currentQuestion`, which never contains the answer. The correct choice appears only in
    `games.revealedIndex`, at reveal.
  - "Everyone in the game" uses the SDK's `team` level backed by `team_members` (teamId = game id).
  - Identity columns are `userBound` + `immutable`, so the DO stamps the verified caller.
  - `admin` gets the same rules as `member`, so the app owner can't read other hosts' keys.
- **Game ops inside the DO** (`src/game/engine.ts`, `AppRecordRoom` in `worker.ts`)
  - Worker actions verify the JWT, then forward each op to the record DO. There it runs under
    `state.blockConcurrencyWhile`, so every check-and-write is atomic.
  - Deadlines and `receivedAt` use the server clock, and the first answer wins: two simultaneous
    submits can't both count.
  - Every response includes `serverNow`, so clients can correct their countdown for clock skew.
  - Nothing slow runs inside the lock (`src/game/lock-guard.ts`).
- **AI question drafting** (`src/actions/draft.ts`, `src/game/drafts.ts`)
  - An internal op checks quiz ownership and the 10-per-hour limit inside the DO.
  - `claude-haiku-5-5` runs in the worker, outside the lock, with a 20 s timeout. The notes are
    treated as untrusted data.
  - Output is parsed leniently and validated strictly. Each item's `answer` text must match
    `choices[correctIndex]`, or the item is dropped.
  - Drafts come back for the host to review; nothing is saved until the host accepts it.
- **PDF/TXT upload** (`src/server/upload-routes.ts`, `src/game/file-text.ts`)
  - Up to 10 MB. The type is taken from the file's bytes, not its name.
  - Text is extracted in memory with `unpdf`, stopping at 8,000 characters and after at most 60 pages.
    The file is never stored.
  - Extraction happens before the rate-limit slot is reserved. Scanned, empty and corrupt files get
    clear messages.
- **Results email** (`src/actions/results-email.ts`, `src/game/results-email.ts`)
  - When a game ends, the host gets the final ranking and % correct per question, with questions
    under 50% flagged.
  - It goes only to the host's email from their verified JWT, and is sent at most once per game: the
    ending op claims it inside the lock.
  - It's sent from the worker, outside the lock. If sending fails, the game still ends normally.
