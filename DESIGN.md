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
| questions | quizId, order, prompt, choices[2–4], timeLimitSec | host; players only once the question is live |
| **answerKeys** | questionId, correctIndex | **host only, ever** |
| games | quizId, hostId, code, state (`lobby`/`question`/`reveal`/`ended`), currentIndex, startedAt, endsAt, revealedIndex | everyone in the game |
| players | gameId, userId, nickname, score | everyone in the game |
| answers | gameId, questionId, userId, choice, receivedAt, points | own answer only; totals for host |

The correct answer lives in a **separate host-only collection**. If it sat on the
question record, any player could find it in the network tab before answering.

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

## AI question drafting
- Input: pasted notes (capped at ~8k characters) and a number of questions (3–10).
- Output: strict JSON `[{prompt, choices[4], correctIndex}]`, checked before
  saving (4 non-empty, distinct choices; index between 0 and 3). Invalid items are dropped.
- Drafts land in the editor, **not** straight into a game. The host reviews them,
  because AI-written answer keys can be wrong.
- It runs in the worker with the key in `deepspace secrets`. If it fails, the host can still
  write questions by hand.

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
