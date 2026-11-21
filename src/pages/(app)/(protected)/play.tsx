/**
 * Player: join with code + nickname, then play.
 *
 * <PlayerGame> (which subscribes to games/players/answers) is mounted ONLY
 * after joinGame succeeds. The server adds the player to team_members during
 * the join, and the SDK's 'team' read rule computes a subscription's rows
 * when it starts. In deepspace 0.44.2 the "membership changed → resubscribe"
 * hook never fires (it reads data.UserId), so a subscription opened before
 * joining would stay empty.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth, useQuery } from 'deepspace'
import { Button, Input } from '@/components/ui'
import {
  ChoiceButton,
  Countdown,
  ErrorText,
  Leaderboard,
  Page,
  Podium,
  rankOf,
  rankPlayers,
} from '../../../components/quiz'
import type { Answer, Game, Player } from '../../../game/engine'
import { callQuizAction, useActionsReady, useCountdown } from '../../../lib/quiz-client'

const SESSION_KEY = 'quizlive:lastJoin'

interface Joined {
  gameId: string
  code: string
  nickname: string
}

function loadLastJoin(): { code: string; nickname: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as { code: string; nickname: string }) : null
  } catch {
    return null
  }
}
function saveLastJoin(v: { code: string; nickname: string } | null) {
  try {
    if (v) sessionStorage.setItem(SESSION_KEY, JSON.stringify(v))
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // storage unavailable: rejoin-on-reload just won't happen
  }
}

export default function PlayPage() {
  const [params] = useSearchParams()
  const ready = useActionsReady()
  const last = useRef(loadLastJoin())
  const [code, setCode] = useState(params.get('code') ?? last.current?.code ?? '')
  const [nickname, setNickname] = useState(last.current?.nickname ?? '')
  const [joined, setJoined] = useState<Joined | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const autoTried = useRef(false)

  async function join(c: string, n: string) {
    setBusy(true)
    setError('')
    const r = await callQuizAction<{ gameId: string; nickname: string }>('joinGame', { code: c, nickname: n })
    setBusy(false)
    if (!r.success) {
      setError(r.error)
      if (r.code === 'game_ended' || r.code === 'not_found') saveLastJoin(null)
      return
    }
    saveLastJoin({ code: c, nickname: r.data.nickname })
    setJoined({ gameId: r.data.gameId, code: c, nickname: r.data.nickname })
  }

  // After a reload mid-game, rejoin silently (joinGame is idempotent).
  useEffect(() => {
    if (ready && !autoTried.current && last.current && !params.get('code')) {
      autoTried.current = true
      void join(last.current.code, last.current.nickname)
    }
     
  }, [ready])

  if (joined) {
    return (
      <PlayerGame
        {...joined}
        onLeave={() => {
          saveLastJoin(null)
          setJoined(null)
          setCode('')
        }}
      />
    )
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void join(code, nickname)
  }

  return (
    <Page className="max-w-md">
      <h1 className="text-2xl font-bold">Join a game</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm text-muted-foreground">Game code</span>
          <Input
            data-testid="join-code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC123"
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={6}
            className="mt-1 h-14 text-center font-mono text-3xl tracking-[0.3em]"
          />
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">Nickname</span>
          <Input
            data-testid="nickname-input"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={24}
            className="mt-1 h-12 text-lg"
          />
        </label>
        <ErrorText>{error}</ErrorText>
        <Button
          data-testid="join-submit"
          type="submit"
          size="lg"
          className="w-full"
          disabled={!ready || code.trim().length !== 6 || !nickname.trim()}
          loading={busy}
        >
          Join
        </Button>
      </form>
    </Page>
  )
}

function PlayerGame({ gameId, nickname, onLeave }: Joined & { onLeave: () => void }) {
  const { userId } = useAuth()
  const ready = useActionsReady()
  const { records: games } = useQuery<Game>('games', { where: { teamId: gameId } })
  const { records: playerRecs } = useQuery<Player>('players', { where: { gameId } })
  // Read rule is 'own': this only ever returns my answers.
  const { records: myAnswers } = useQuery<Answer>('answers', { where: { gameId } })

  const game = games[0]?.data
  const live = game?.currentQuestion ?? null
  const players = rankPlayers(playerRecs)
  const myRank = userId ? rankOf(players, userId) : null
  const me = players.find((p) => p.userId === userId)

  const myAnswer = live ? myAnswers.find((a) => a.data.questionId === live.questionId)?.data : undefined
  const [pending, setPending] = useState<{ questionId: string; choice: number } | null>(null)
  const [error, setError] = useState('')
  const myChoice = myAnswer?.choice ?? (pending && pending.questionId === live?.questionId ? pending.choice : undefined)

  const msLeft = useCountdown(game?.endsAt, game?.state === 'question')

  async function answer(choice: number) {
    if (!live || myChoice !== undefined) return
    setPending({ questionId: live.questionId, choice })
    setError('')
    const r = await callQuizAction('submitAnswer', { gameId, choice })
    if (!r.success) {
      // 'already_answered' means an earlier tap counted; keep showing it.
      if (r.code !== 'already_answered') setPending(null)
      setError(r.error)
    }
  }

  if (!game) {
    return (
      <Page className="max-w-md">
        <p className="text-muted-foreground">Connecting to the game…</p>
      </Page>
    )
  }

  return (
    <Page className="max-w-md">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span data-testid="my-nickname">{nickname}</span>
        <span className="tabular-nums">{me?.score ?? 0} pts</span>
      </div>

      {game.state === 'lobby' && (
        <section className="mt-10 text-center">
          <p className="text-2xl font-bold">You're in!</p>
          <p data-testid="player-waiting" className="mt-2 text-muted-foreground">
            Waiting for the host to start…
          </p>
          <ul className="mt-8 flex flex-wrap justify-center gap-2">
            {players.map((p) => (
              <li key={p.userId} className="rounded-full bg-secondary px-3 py-1 text-sm">
                {p.nickname}
              </li>
            ))}
          </ul>
        </section>
      )}

      {game.state === 'question' && live && (
        <section className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Question {live.index + 1} of {live.total}
          </p>
          <h1 data-testid="player-prompt" className="text-xl font-bold">
            {live.prompt}
          </h1>
          <Countdown msLeft={msLeft} totalSec={live.timeLimitSec} />
          {myChoice !== undefined ? (
            <div data-testid="locked-in" className="rounded-xl border border-border bg-card p-6 text-center">
              <p className="text-xl font-bold">Answer locked in</p>
              <p className="mt-1 text-muted-foreground">
                You picked {String.fromCharCode(65 + myChoice)}: {live.choices[myChoice]}
              </p>
            </div>
          ) : (
            <div className="grid gap-3">
              {live.choices.map((c, i) => (
                <ChoiceButton key={i} index={i} label={c} onClick={() => answer(i)}
                  disabled={!ready || msLeft <= 0}
                  state={msLeft <= 0 ? 'dim' : 'idle'}
                />
              ))}
            </div>
          )}
          {myChoice === undefined && msLeft <= 0 && <p className="text-center font-semibold">Time's up!</p>}
          <ErrorText>{error}</ErrorText>
        </section>
      )}

      {game.state === 'reveal' && live && (
        <section className="mt-4 space-y-5">
          <ResultCard answer={myAnswer} revealedIndex={game.revealedIndex} choices={live.choices} />
          <p className="text-center text-muted-foreground">
            {myRank ? `You're #${myRank} of ${players.length}` : ''}
          </p>
          <Leaderboard players={players} highlightUserId={userId ?? undefined} limit={5} />
        </section>
      )}

      {game.state === 'ended' && (
        <section className="mt-6 space-y-6 text-center">
          <p data-testid="final-rank" className="text-3xl font-black">
            {myRank ? `You finished #${myRank}` : 'Game over'}
          </p>
          <p className="text-muted-foreground">{me?.score ?? 0} points</p>
          <Podium players={players} />
          <Button variant="outline" onClick={onLeave}>
            Join another game
          </Button>
        </section>
      )}
    </Page>
  )
}

function ResultCard({ answer, revealedIndex, choices }: { answer?: Answer; revealedIndex: number; choices: string[] }) {
  const correctText = `${String.fromCharCode(65 + revealedIndex)}: ${choices[revealedIndex] ?? ''}`
  if (!answer) {
    return (
      <div data-testid="result" data-result="none" className="rounded-xl bg-muted p-6 text-center">
        <p className="text-2xl font-bold">No answer</p>
        <p className="mt-1 text-muted-foreground">Correct answer: {correctText}</p>
      </div>
    )
  }
  const correct = answer.choice === revealedIndex
  return (
    <div
      data-testid="result"
      data-result={correct ? 'correct' : 'wrong'}
      className={correct ? 'rounded-xl bg-emerald-600 p-6 text-center text-white' : 'rounded-xl bg-rose-600 p-6 text-center text-white'}
    >
      <p className="text-3xl font-black">{correct ? 'Correct!' : 'Wrong'}</p>
      <p className="mt-1 text-lg">+{answer.points ?? 0} points</p>
      {!correct && <p className="mt-2 text-sm opacity-90">Correct answer: {correctText}</p>}
    </div>
  )
}
