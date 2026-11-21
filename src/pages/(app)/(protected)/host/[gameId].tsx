/**
 * Host: live game control. Big join code → lobby → question with countdown and
 * live answer count → reveal + leaderboard → next / end → podium.
 */

import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { Button } from '@/components/ui'
import { ChoiceButton, Countdown, ErrorText, Leaderboard, Page, Podium, rankPlayers } from '../../../../components/quiz'
import type { Game, OpName, Player } from '../../../../game/engine'
import { callQuizAction, useActionsReady, useCountdown, useServerClockSync } from '../../../../lib/quiz-client'

export default function HostGamePage() {
  const { gameId = '' } = useParams()
  const ready = useActionsReady()
  useServerClockSync(ready)

  const { records: games, status } = useQuery<Game>('games', { where: { teamId: gameId } })
  const { records: playerRecs } = useQuery<Player>('players', { where: { gameId } })
  const game = games[0]?.data
  const players = rankPlayers(playerRecs)

  const [busy, setBusy] = useState<OpName | null>(null)
  const [error, setError] = useState('')

  const live = game?.currentQuestion ?? null
  const msLeft = useCountdown(game?.endsAt, game?.state === 'question')

  async function act(op: OpName) {
    if (op === 'endGame' && !window.confirm('End the game for everyone?')) return
    setBusy(op)
    setError('')
    const r = await callQuizAction(op, { gameId })
    setBusy(null)
    if (!r.success) setError(r.error)
  }

  if (!game) {
    return (
      <Page>
        <p className="text-muted-foreground">{status === 'loading' ? 'Loading game…' : 'Game not found.'}</p>
      </Page>
    )
  }

  const everyoneAnswered = players.length > 0 && game.answeredCount >= players.length
  const canReveal = msLeft <= 0 || everyoneAnswered
  const isLast = live ? live.index + 1 >= live.total : false

  return (
    <Page className="max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {game.state === 'lobby' && 'Lobby'}
          {live && game.state !== 'lobby' && game.state !== 'ended' && `Question ${live.index + 1} of ${live.total}`}
          {game.state === 'ended' && 'Final results'}
        </p>
        {game.state !== 'ended' && (
          <Button variant="ghost" size="sm" onClick={() => act('endGame')} disabled={!ready || !!busy}>
            End game
          </Button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>

      {game.state === 'lobby' && (
        <section className="mt-4 text-center">
          <p className="text-muted-foreground">
            Join at <span className="font-medium text-foreground">{window.location.host}/play</span> with code
          </p>
          <p data-testid="join-code" className="mt-2 font-mono text-6xl font-black tracking-[0.2em] sm:text-7xl">
            {game.code}
          </p>
          <p className="mt-8 text-left text-sm font-medium">
            Players ({players.length})
          </p>
          <ul data-testid="lobby-players" className="mt-2 flex min-h-12 flex-wrap gap-2">
            {players.length === 0 && <li className="text-sm text-muted-foreground">Waiting for players to join…</li>}
            {players.map((p) => (
              <li key={p.userId} className="rounded-full bg-secondary px-3 py-1 text-sm font-medium">
                {p.nickname}
              </li>
            ))}
          </ul>
          <Button
            data-testid="host-start"
            size="lg"
            className="mt-8 w-full"
            onClick={() => act('startQuestion')}
            disabled={!ready || players.length === 0 || !!busy}
            loading={busy === 'startQuestion'}
          >
            Start first question
          </Button>
        </section>
      )}

      {live && (game.state === 'question' || game.state === 'reveal') && (
        <section className="mt-4 space-y-5">
          <h1 data-testid="host-prompt" className="text-2xl font-bold sm:text-3xl">
            {live.prompt}
          </h1>

          {game.state === 'question' && (
            <>
              <Countdown msLeft={msLeft} totalSec={live.timeLimitSec} />
              <p data-testid="answered-count" className="text-center text-xl font-semibold tabular-nums">
                {game.answeredCount}/{players.length} answered
              </p>
            </>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {live.choices.map((c, i) => (
              <ChoiceButton
                key={i}
                index={i}
                label={c}
                disabled
                state={game.state === 'reveal' ? (i === game.revealedIndex ? 'correct' : 'dim') : 'idle'}
              />
            ))}
          </div>

          {game.state === 'question' && (
            <Button
              data-testid="host-reveal"
              size="lg"
              className="w-full"
              onClick={() => act('reveal')}
              disabled={!ready || !canReveal || !!busy}
              loading={busy === 'reveal'}
            >
              {canReveal ? 'Reveal answer' : 'Reveal (when time is up or everyone answered)'}
            </Button>
          )}

          {game.state === 'reveal' && (
            <>
              <h2 className="text-lg font-semibold">Leaderboard</h2>
              <Leaderboard players={players} />
              <Button
                data-testid="host-next"
                size="lg"
                className="w-full"
                onClick={() => act('nextQuestion')}
                disabled={!ready || !!busy}
                loading={busy === 'nextQuestion'}
              >
                {isLast ? 'Show final podium' : 'Next question'}
              </Button>
            </>
          )}
        </section>
      )}

      {game.state === 'ended' && (
        <section className="mt-6 space-y-8">
          <Podium players={players} />
          <Leaderboard players={players} limit={50} />
          <Link to="/quizzes" className="block text-center text-sm underline">
            Back to my quizzes
          </Link>
        </section>
      )}
    </Page>
  )
}
