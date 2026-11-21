/**
 * Shared QuizLive UI pieces used by both the host and player screens.
 */

import type { ReactNode } from 'react'
import { cn } from '@/components/ui'
import type { Player } from '../game/engine'

/** One color + letter per choice slot, so "B" means the same on every screen. */
export const CHOICE_STYLES = [
  { letter: 'A', className: 'bg-rose-600 text-white' },
  { letter: 'B', className: 'bg-sky-600 text-white' },
  { letter: 'C', className: 'bg-amber-500 text-black' },
  { letter: 'D', className: 'bg-emerald-600 text-white' },
] as const

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-2xl px-4 py-6 sm:py-10', className)}>{children}</div>
}

export function Countdown({ msLeft, totalSec }: { msLeft: number; totalSec: number }) {
  const sec = Math.ceil(msLeft / 1000)
  const pct = totalSec > 0 ? Math.min(100, (msLeft / (totalSec * 1000)) * 100) : 0
  return (
    <div className="w-full" aria-live="off">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-muted-foreground">{sec > 0 ? 'Time left' : "Time's up"}</span>
        <span data-testid="countdown" className={cn('text-3xl font-bold tabular-nums', sec <= 5 && sec > 0 && 'text-destructive')}>
          {sec}s
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width] duration-100 ease-linear" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function ChoiceButton({
  index,
  label,
  onClick,
  disabled,
  state = 'idle',
}: {
  index: number
  label: string
  onClick?: () => void
  disabled?: boolean
  /** idle | chosen (my pick) | correct | wrong | dim */
  state?: 'idle' | 'chosen' | 'correct' | 'wrong' | 'dim'
}) {
  const s = CHOICE_STYLES[index % CHOICE_STYLES.length]
  return (
    <button
      type="button"
      data-testid={`choice-${index}`}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex min-h-20 w-full items-center gap-3 rounded-xl px-4 py-4 text-left text-lg font-semibold shadow-sm transition',
        'disabled:cursor-not-allowed enabled:active:scale-[0.98]',
        s.className,
        state === 'dim' && 'opacity-35',
        state === 'chosen' && 'ring-4 ring-foreground ring-offset-2 ring-offset-background',
        state === 'correct' && 'ring-4 ring-emerald-400 ring-offset-2 ring-offset-background',
        state === 'wrong' && 'opacity-35 line-through',
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-black/20 text-base">{s.letter}</span>
      <span className="break-words">{label}</span>
    </button>
  )
}

export function rankPlayers(players: { data: Player }[]) {
  return [...players]
    .map((p) => p.data)
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname))
}

/** Standard competition ranking: ties share a rank (1, 2, 2, 4). */
export function rankOf(sorted: Player[], userId: string): number | null {
  const i = sorted.findIndex((p) => p.userId === userId)
  if (i < 0) return null
  return sorted.findIndex((p) => p.score === sorted[i].score) + 1
}

export function Leaderboard({ players, highlightUserId, limit = 10 }: { players: Player[]; highlightUserId?: string; limit?: number }) {
  if (players.length === 0) return <p className="text-sm text-muted-foreground">No players yet.</p>
  return (
    <ol data-testid="leaderboard" className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {players.slice(0, limit).map((p) => (
        <li
          key={p.userId}
          className={cn('flex items-center justify-between px-4 py-3', p.userId === highlightUserId && 'bg-accent font-semibold')}
        >
          <span className="flex items-center gap-3">
            <span className="w-6 text-right text-sm tabular-nums text-muted-foreground">{rankOf(players, p.userId)}</span>
            <span>{p.nickname}</span>
          </span>
          <span className="tabular-nums">{p.score}</span>
        </li>
      ))}
    </ol>
  )
}

export function Podium({ players }: { players: Player[] }) {
  const top = players.slice(0, 3)
  const order = [top[1], top[0], top[2]] // 2nd, 1st, 3rd
  const heights = ['h-24', 'h-32', 'h-16']
  const places = [2, 1, 3]
  return (
    <div data-testid="podium" className="flex items-end justify-center gap-3">
      {order.map((p, i) =>
        p ? (
          <div key={p.userId} className="flex w-28 flex-col items-center gap-2">
            <span className="max-w-full truncate text-center font-semibold">{p.nickname}</span>
            <span className="text-sm tabular-nums text-muted-foreground">{p.score}</span>
            <div className={cn('flex w-full items-start justify-center rounded-t-lg bg-primary pt-2 text-2xl font-bold text-primary-foreground', heights[i])}>
              {places[i]}
            </div>
          </div>
        ) : (
          <div key={`empty-${i}`} className="w-28" />
        ),
      )}
    </div>
  )
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  )
}
