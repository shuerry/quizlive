# QuizLive: live class quiz with AI-drafted questions

A host pastes lecture notes, and AI drafts multiple-choice questions, which the host edits.
The host then starts a live game. Players join on their phones with a 6-character code,
answer timed questions, and watch the leaderboard update after each one.

> Built in one evening. Exact SDK calls and integration names are checked
> against `npx deepspace integrations list` and the scaffold, and this doc is
> updated to match the code.

## Core path (must work on the deployed URL)
1. The host signs in, creates a quiz and adds questions. AI can draft them from pasted notes.
2. The host starts a game, and a join code appears.
3. Players sign in, enter the code and pick a nickname. The lobby shows who's in, live.
4. The host shows question 1, and every phone shows it with a countdown.
5. Players tap an answer. The host sees "12/15 answered" live.
6. Time runs out or the host reveals the answer. Players see whether they were right, and the leaderboard updates.
7. Repeat until the last question, then the final podium.

## Data (`src/schemas.ts`, keep `users`)
| collection | fields | who can read |
|---|---|---|
| quizzes | title, hostId | host |
| questions | quizId, order, prompt, choices[2–4], timeLimitSec, hostId | host; players see the live one via `games.currentQuestion` |
| **answerKeys** | questionId, correctIndex, hostId | **host only, ever** |
| games | quizId, hostId, code, state (`lobby`/`question`/`reveal`/`ended`), currentIndex, startedAt, endsAt, revealedIndex (correct choice, -1 until reveal), teamId, currentQuestion (never the answer), answeredCount | everyone in the game |
| players | gameId, userId, nickname, score | everyone in the game |
| answers | gameId, questionId, userId, choice, receivedAt, points | own answer only; totals for host via `games.answeredCount` |
| team_members | teamId (= game id), userId, status | own rows; written by the server on create/join |

The correct answer lives in a **separate host-only collection**. If it sat on the
question record, any player could find it in the network tab before answering.

How the table maps onto the SDK (`src/schemas/quiz-schemas.ts`):
- Only `quizzes` takes client writes. Everything else is written by server actions.
  `hostId`/`userId` are `userBound` + `immutable`, so the Durable Object stamps the
  verified caller on create. `admin` gets exactly the `member` rules, because the app
  owner is automatically an admin and would otherwise see every answer key.
- **Live question:** the SDK can't gate one collection's reads on another's state, so
  `questions` is host-only. When a question starts, the worker copies its prompt, choices and
  time limit (never `correctIndex`) into `games.currentQuestion`. The correct choice reaches players only through `games.revealedIndex`, which is set at reveal.
- **Answer totals:** answers are own-only, so the worker keeps `games.answeredCount`.
  Players in the game can see the count too (never the choices). This is intentional.
- **"Everyone in the game"** uses the SDK's `team` level, which reads a
  `team_members` collection (teamId = game id). The SDK's "membership changed"
  refresh hook doesn't fire (in deepspace 0.44.2 it reads `data.UserId`), so player screens
  open their game subscriptions only after the join action returns.

## Server-side rules (the technical depth)
- **The server owns the clock.** Starting a question sets `startedAt` and `endsAt` from
  server time. Clients draw the countdown from those timestamps, correcting for
  the gap between their clock and the server's. They never decide when time is up.
- **Answers are timestamped by the worker.** An answer is accepted only if it arrives before `endsAt`
  and the game state is `question`. One answer per player per question: the first one
  stands, and later ones are rejected.
- **Scoring happens at reveal, on the server:** correct = `500 + 500 × (time left / limit)`,
  wrong or missing = 0. The worker sets `revealedIndex` and updates `players.score` in
  one step, so every screen sees the same leaderboard.
- Only the host can move the game forward (start, reveal, next, end). Player and host IDs
  always come from the verified JWT.
- Join codes are random, and a code stops working after the game ends.
- **Every game op is atomic.** A worker action verifies the JWT and forwards the op
  to the record Durable Object. The engine (`src/game/engine.ts`) runs there inside
  `state.blockConcurrencyWhile`, so no other request is handled until the op finishes.
  Without it, each `tools.*` call would be a separate request, and two submits could
  interleave between the check and the write. `uniqueOn [gameId, questionId, userId]`
  on `answers` is a second guard. Every response includes `serverNow` for clock-offset correction.

## AI question drafting
- Input: pasted notes (capped at ~8k characters) and a number of questions (3–10).
- Output: strict JSON `[{prompt, choices[4], correctIndex, answer}]`, checked before
  it reaches the editor: prompt of 300 characters or fewer; 4 non-empty, distinct choices; index between 0 and 3; and
  `answer` (the correct choice's text) must equal `choices[correctIndex]`. That last check exists because a
  real test draft put the key on "Hemoglobin" for a chlorophyll question. Invalid items are dropped;
  `answer` is only a check and is not kept.
- Drafts land in the editor, **not** straight into a game. The host reviews them,
  because AI-written answer keys can be wrong.
- It runs in the worker, outside the DO lock, using `anthropic/chat-completion` with
  `claude-haiku-5-5`. That integration is billed through DeepSpace to the app owner, so there's no API
  key. Limit: 10 drafts per user per hour. If it fails, the host can still write questions by hand.
- **From a file:** the host can upload a PDF or .txt (max 10 MB) instead of pasting notes.
  - The type is taken from the file's bytes, not its name. Word and PowerPoint files are told to export as a PDF.
  - The text is extracted in the worker (`unpdf` for PDFs), stopping at 8,000 characters and after at
    most 60 pages. It then goes through the same drafting pipeline, and each draft shows "Source: <file>".
  - Extraction happens before the rate-limit slot is reserved, so an unreadable file costs nothing.
    Scanned, empty and corrupt files get specific messages.
  - The file is never stored. On the deployed worker, a 10 MB, 2,252-page PDF took about 1 s round trip
    (stopping early); reading all of it took about 6 s.

## Integrations
- **Auth + real-time records:** the whole game
- **AI:** drafting questions, which removes the slowest part of hosting a quiz

Left out on purpose: payments (nothing to sell), maps (no location), email
(everyone is in the room at once).

## Main tradeoff
The server owns time and scoring. This adds a round-trip to every tap and needs
clock-offset handling. But it's the only way the leaderboard can be trusted, since a
client-side timer or score could be edited in devtools.

## Verification (done by me)
- [ ] Three browsers (host and two players): lobby, live answer count, reveal and leaderboard all update live
- [ ] As a player, `correctIndex` can't be read before reveal, checked in the network tab and by querying directly
- [ ] An answer sent after `endsAt` is rejected; a second answer to the same question is rejected
- [ ] A forged userId or a player calling "next question" is rejected
- [ ] The AI tool returns malformed JSON or a bad index → those items are dropped, and nothing crashes
- [ ] No keys in the repo or built JS
- [ ] Full game runs on the deployed URL from a phone

## Agent prompts (one at a time, review each diff)
1. "Read DESIGN.md and the deepspace skill. Scaffold, set up auth, deploy the empty app."
2. "Add the schemas with exactly the read rules in the table. Show me how answerKeys is kept host-only."
3. "Implement the server actions: start, answer, reveal, next, end, with the timing and scoring rules. Unit-test the scoring."
4. "Build the host screens (quiz editor, lobby, question/answer count, reveal, podium)."
5. "Build the player screens (join, lobby, question with countdown, result)."
6. "Add AI drafting in the worker with the validation described."

## Next, if I had more time
Streak bonuses, question images, a CSV export of results for the host,
rejoining after a dropped connection mid-game, and a per-question accuracy
chart so the instructor can see which concept didn't land.
