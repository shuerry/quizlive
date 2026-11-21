/** Host: quiz editor (questions + answer keys) and "Start game". */

import { useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { Button, Input, Textarea, cn } from '@/components/ui'
import { CHOICE_STYLES, ErrorText, Page } from '../../../../components/quiz'
import type { AnswerKey, Game, Question, Quiz } from '../../../../game/engine'
import { callQuizAction, useActionsReady } from '../../../../lib/quiz-client'

const TIME_OPTIONS = [10, 20, 30, 45, 60, 90]

interface Draft {
  questionId?: string
  prompt: string
  choices: string[]
  correctIndex: number
  timeLimitSec: number
}

const EMPTY: Draft = { prompt: '', choices: ['', ''], correctIndex: 0, timeLimitSec: 20 }

interface AiDraft {
  key: string
  prompt: string
  choices: string[]
  correctIndex: number
}

/**
 * "Draft with AI": paste notes → editable draft cards. Nothing is saved until
 * the host accepts a card (which calls saveQuestion, validated again on the
 * server). AI answer keys can be wrong, so each card must be reviewed.
 */
function AiDraftPanel({ quizId, ready }: { quizId: string; ready: boolean }) {
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const [count, setCount] = useState(5)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [drafts, setDrafts] = useState<AiDraft[]>([])

  async function draft(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setInfo('')
    const r = await callQuizAction<{ drafts: Omit<AiDraft, 'key'>[]; dropped: number; remaining: number }>(
      'draftQuestions',
      { quizId, notes, count },
    )
    setBusy(false)
    if (!r.success) return setError(r.error)
    const stamp = Date.now()
    setDrafts((prev) => [...prev, ...r.data.drafts.map((d, i) => ({ ...d, key: `${stamp}-${i}` }))])
    setInfo(
      `${r.data.drafts.length} draft${r.data.drafts.length === 1 ? '' : 's'} ready to review` +
        (r.data.dropped ? ` (${r.data.dropped} unusable one${r.data.dropped === 1 ? ' was' : 's were'} skipped)` : '') +
        `. ${r.data.remaining} AI draft${r.data.remaining === 1 ? '' : 's'} left this hour.`,
    )
  }

  const remove = (key: string) => setDrafts((ds) => ds.filter((d) => d.key !== key))

  if (!open) {
    return (
      <div className="mt-6">
        <Button data-testid="ai-open" variant="secondary" onClick={() => setOpen(true)}>
          ✨ Draft with AI
        </Button>
      </div>
    )
  }

  return (
    <section data-testid="ai-panel" className="mt-6 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Draft questions with AI</h2>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      <form onSubmit={draft} className="mt-3 space-y-3">
        <Textarea
          data-testid="ai-notes"
          aria-label="Lecture notes"
          placeholder="Paste your lecture notes here…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={8000}
          rows={6}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            Questions
            <select
              data-testid="ai-count"
              aria-label="Number of questions"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="h-9 rounded-md border border-input bg-background px-2"
            >
              {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="text-xs tabular-nums text-muted-foreground">{notes.length}/8000</span>
        </div>
        <Button data-testid="ai-submit" type="submit" disabled={!ready || !notes.trim() || busy} loading={busy}>
          {busy ? 'Drafting…' : 'Draft questions'}
        </Button>
      </form>
      <ErrorText>{error}</ErrorText>
      {info && <p className="mt-2 text-sm text-muted-foreground">{info}</p>}

      {drafts.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-muted-foreground">
            Check each draft. AI can get the answer wrong. Accept saves it to the quiz.
          </p>
          {drafts.map((d) => (
            <QuestionForm
              key={d.key}
              testId="ai-draft"
              quizId={quizId}
              initial={{ prompt: d.prompt, choices: d.choices, correctIndex: d.correctIndex, timeLimitSec: 20 }}
              ready={ready}
              saveLabel="Accept"
              cancelLabel="Discard"
              onDone={() => remove(d.key)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export default function QuizEditorPage() {
  const { quizId = '' } = useParams()
  const navigate = useNavigate()
  const ready = useActionsReady()

  const { records: quizzes, status: quizStatus } = useQuery<Quiz>('quizzes')
  const quiz = quizzes.find((q) => q.recordId === quizId)
  const { records: questionRecs } = useQuery<Question>('questions', { where: { quizId } })
  const { records: keyRecs } = useQuery<AnswerKey>('answerKeys')
  const { records: gameRecs } = useQuery<Game>('games', { where: { quizId } })

  const questions = useMemo(
    () => [...questionRecs].sort((a, b) => a.data.order - b.data.order || a.recordId.localeCompare(b.recordId)),
    [questionRecs],
  )
  const keyOf = useMemo(() => new Map(keyRecs.map((k) => [k.data.questionId, k.data.correctIndex])), [keyRecs])
  const liveGames = gameRecs.filter((g) => g.data.state !== 'ended')

  const [draft, setDraft] = useState<Draft | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  async function startGame() {
    setStarting(true)
    setError('')
    const r = await callQuizAction<{ gameId: string }>('createGame', { quizId })
    setStarting(false)
    if (!r.success) return setError(r.error)
    navigate(`/host/${r.data.gameId}`)
  }

  if (quizStatus !== 'loading' && !quiz) {
    return (
      <Page>
        <p>Quiz not found.</p>
        <Link to="/quizzes" className="text-sm underline">
          Back to my quizzes
        </Link>
      </Page>
    )
  }

  return (
    <Page>
      <Link to="/quizzes" className="text-sm text-muted-foreground hover:underline">
        ← My quizzes
      </Link>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{quiz?.data.title ?? '…'}</h1>
        <Button data-testid="start-game" size="lg" onClick={startGame} disabled={!ready || questions.length === 0} loading={starting}>
          Start game
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>

      {liveGames.length > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-card p-4 text-sm">
          <p className="font-medium">Game in progress</p>
          {liveGames.map((g) => (
            <Link key={g.recordId} to={`/host/${g.recordId}`} className="mt-1 block underline">
              Open game {g.data.code} ({g.data.state})
            </Link>
          ))}
        </div>
      )}

      <AiDraftPanel quizId={quizId} ready={ready} />

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Questions ({questions.length})</h2>
          {!draft && (
            <Button variant="outline" onClick={() => setDraft({ ...EMPTY, choices: ['', ''] })} disabled={!ready}>
              + Add question
            </Button>
          )}
        </div>

        {draft && !draft.questionId && (
          <QuestionForm quizId={quizId} initial={draft} onDone={() => setDraft(null)} ready={ready} />
        )}

        <ol className="mt-4 space-y-3">
          {questions.map((q, i) =>
            draft?.questionId === q.recordId ? (
              <li key={q.recordId}>
                <QuestionForm quizId={quizId} initial={draft} onDone={() => setDraft(null)} ready={ready} />
              </li>
            ) : (
              <li key={q.recordId} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">
                    {i + 1}. {q.data.prompt}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!ready || !!draft}
                    onClick={() =>
                      setDraft({
                        questionId: q.recordId,
                        prompt: q.data.prompt,
                        choices: [...q.data.choices],
                        correctIndex: keyOf.get(q.recordId) ?? 0,
                        timeLimitSec: q.data.timeLimitSec,
                      })
                    }
                  >
                    Edit
                  </Button>
                </div>
                <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                  {q.data.choices.map((c, ci) => (
                    <li key={ci} className={cn('rounded-md px-2 py-1', keyOf.get(q.recordId) === ci ? 'bg-emerald-600/15 font-semibold' : 'text-muted-foreground')}>
                      {CHOICE_STYLES[ci].letter}. {c} {keyOf.get(q.recordId) === ci && '✓'}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">{q.data.timeLimitSec}s</p>
              </li>
            ),
          )}
        </ol>
      </section>
    </Page>
  )
}

function QuestionForm({
  quizId,
  initial,
  onDone,
  onCancel,
  ready,
  saveLabel = 'Save question',
  cancelLabel = 'Cancel',
  testId = 'question-form',
}: {
  quizId: string
  initial: Draft
  /** Called after a successful save. */
  onDone: () => void
  /** Called on Cancel / Discard (defaults to onDone). */
  onCancel?: () => void
  ready: boolean
  saveLabel?: string
  cancelLabel?: string
  testId?: string
}) {
  const [d, setD] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const setChoice = (i: number, v: string) => setD({ ...d, choices: d.choices.map((c, j) => (j === i ? v : c)) })
  const removeChoice = (i: number) =>
    setD({
      ...d,
      choices: d.choices.filter((_, j) => j !== i),
      correctIndex: d.correctIndex === i ? 0 : d.correctIndex > i ? d.correctIndex - 1 : d.correctIndex,
    })

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const r = await callQuizAction('saveQuestion', { quizId, ...d })
    setBusy(false)
    if (!r.success) return setError(r.error)
    onDone()
  }

  return (
    <form data-testid={testId} onSubmit={save} className="mt-4 space-y-4 rounded-xl border-2 border-primary/40 bg-card p-4">
      <Textarea
        aria-label="Question"
        placeholder="Question"
        value={d.prompt}
        onChange={(e) => setD({ ...d, prompt: e.target.value })}
        maxLength={500}
        rows={2}
      />
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm text-muted-foreground">Choices: tap the circle to mark the correct one</legend>
        {d.choices.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="radio"
              name="correct"
              aria-label={`Choice ${CHOICE_STYLES[i].letter} is correct`}
              checked={d.correctIndex === i}
              onChange={() => setD({ ...d, correctIndex: i })}
              className="size-5 accent-emerald-600"
            />
            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-bold', CHOICE_STYLES[i].className)}>
              {CHOICE_STYLES[i].letter}
            </span>
            <Input aria-label={`Choice ${CHOICE_STYLES[i].letter}`} value={c} onChange={(e) => setChoice(i, e.target.value)} maxLength={200} />
            {d.choices.length > 2 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => removeChoice(i)} aria-label={`Remove choice ${CHOICE_STYLES[i].letter}`}>
                ✕
              </Button>
            )}
          </div>
        ))}
        {d.choices.length < 4 && (
          <Button type="button" variant="outline" size="sm" onClick={() => setD({ ...d, choices: [...d.choices, ''] })}>
            + Add choice
          </Button>
        )}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        Time limit
        <select
          aria-label="Time limit"
          value={d.timeLimitSec}
          onChange={(e) => setD({ ...d, timeLimitSec: Number(e.target.value) })}
          className="h-9 rounded-md border border-input bg-background px-2"
        >
          {TIME_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t} seconds
            </option>
          ))}
        </select>
      </label>
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" disabled={!ready} loading={busy}>
          {saveLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel ?? onDone}>
          {cancelLabel}
        </Button>
      </div>
    </form>
  )
}
