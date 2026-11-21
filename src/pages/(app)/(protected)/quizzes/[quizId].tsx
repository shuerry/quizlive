/** Host: quiz editor (questions + answer keys) and "Start game". */

import { useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { Button, Input, Textarea, cn } from '@/components/ui'
import { CHOICE_STYLES, ErrorText, Page } from '../../../../components/quiz'
import type { AnswerKey, Game, Question, Quiz } from '../../../../game/engine'
import { callQuizAction, draftFromFile, useActionsReady } from '../../../../lib/quiz-client'

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
  /** "Source: lecture3.pdf (first 8,000 characters used)" for file drafts. */
  source?: string
}

interface DraftResponse {
  drafts: Omit<AiDraft, 'key' | 'source'>[]
  dropped: number
  remaining: number
  source?: { name: string; truncated: boolean; pages?: number; pagesRead?: number }
}

const MAX_UPLOAD_MB = 10

function sourceLabel(src: NonNullable<DraftResponse['source']>): string {
  return `Source: ${src.name}${src.truncated ? ' (first 8,000 characters used)' : ''}`
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
  const [mode, setMode] = useState<'paste' | 'file'>('paste')
  const [file, setFile] = useState<File | null>(null)

  async function draft(e: FormEvent) {
    e.preventDefault()
    setError('')
    setInfo('')
    if (mode === 'file') {
      if (!file) return setError('Choose a PDF or .txt file first')
      // A quick hint only; the server checks the size and the real file type.
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        return setError(`That file is over ${MAX_UPLOAD_MB} MB. Upload a smaller PDF or paste the text.`)
      }
    }
    setBusy(true)
    const r =
      mode === 'file' && file
        ? await draftFromFile<DraftResponse>(file, quizId, count)
        : await callQuizAction<DraftResponse>('draftQuestions', { quizId, notes, count })
    setBusy(false)
    if (!r.success) return setError(r.error)
    const stamp = Date.now()
    const source = r.data.source ? sourceLabel(r.data.source) : undefined
    setDrafts((prev) => [...prev, ...r.data.drafts.map((d, i) => ({ ...d, source, key: `${stamp}-${i}` }))])
    setInfo(
      `${r.data.drafts.length} draft${r.data.drafts.length === 1 ? '' : 's'} ready to review` +
        (r.data.dropped ? ` (${r.data.dropped} unusable one${r.data.dropped === 1 ? ' was' : 's were'} skipped)` : '') +
        `. ${r.data.remaining} AI draft${r.data.remaining === 1 ? '' : 's'} left this hour.`,
    )
  }

  const canSubmit = mode === 'file' ? !!file : !!notes.trim()

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
      <div role="tablist" aria-label="Notes source" className="mt-3 inline-flex rounded-lg bg-muted p-1 text-sm">
        {(['paste', 'file'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            data-testid={`ai-mode-${m}`}
            aria-selected={mode === m}
            onClick={() => {
              setMode(m)
              setError('')
            }}
            className={cn('rounded-md px-3 py-1.5', mode === m ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}
          >
            {m === 'paste' ? 'Paste notes' : 'Upload a file'}
          </button>
        ))}
      </div>
      <form onSubmit={draft} className="mt-3 space-y-3">
        {mode === 'paste' ? (
          <Textarea
            data-testid="ai-notes"
            aria-label="Lecture notes"
            placeholder="Paste your lecture notes here…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={8000}
            rows={6}
          />
        ) : (
          <div className="rounded-lg border border-dashed border-border p-4">
            <input
              data-testid="ai-file"
              type="file"
              aria-label="Notes file"
              accept=".pdf,.txt,application/pdf,text/plain"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null)
                setError('')
              }}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              PDF or .txt, up to {MAX_UPLOAD_MB} MB. The first 8,000 characters are used. The file isn&apos;t stored.
              Word or PowerPoint? Export it as a PDF first.
            </p>
            {file && (
              <p data-testid="ai-file-name" className="mt-1 text-sm">
                {file.name} ({file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`})
              </p>
            )}
          </div>
        )}
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
          {mode === 'paste' && <span className="text-xs tabular-nums text-muted-foreground">{notes.length}/8000</span>}
        </div>
        <Button data-testid="ai-submit" type="submit" disabled={!ready || !canSubmit || busy} loading={busy}>
          {busy ? (mode === 'file' ? 'Reading file and drafting…' : 'Drafting…') : 'Draft questions'}
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
            <div key={d.key} data-testid="ai-draft-card">
              {d.source && (
                <p data-testid="ai-draft-source" className="mt-4 text-xs font-medium text-muted-foreground">
                  {d.source}
                </p>
              )}
              <QuestionForm
                testId="ai-draft"
                quizId={quizId}
                initial={{ prompt: d.prompt, choices: d.choices, correctIndex: d.correctIndex, timeLimitSec: 20 }}
                ready={ready}
                saveLabel="Accept"
                cancelLabel="Discard"
                onDone={() => remove(d.key)}
              />
            </div>
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
