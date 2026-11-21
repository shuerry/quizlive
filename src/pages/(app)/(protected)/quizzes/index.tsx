/** Host: my quizzes + create a new one. */

import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { Button, Input } from '@/components/ui'
import { ErrorText, Page } from '../../../../components/quiz'
import type { Quiz } from '../../../../game/engine'
import { callQuizAction, useActionsReady } from '../../../../lib/quiz-client'

export default function QuizzesPage() {
  const { records: quizzes, status } = useQuery<Quiz>('quizzes', { orderBy: 'createdAt', orderDir: 'desc' })
  const ready = useActionsReady()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const r = await callQuizAction<{ quizId: string }>('createQuiz', { title })
    setBusy(false)
    if (!r.success) return setError(r.error)
    navigate(`/quizzes/${r.data.quizId}`)
  }

  return (
    <Page>
      <h1 className="text-2xl font-bold">My quizzes</h1>

      <form onSubmit={create} className="mt-6 flex gap-2">
        <Input
          aria-label="New quiz title"
          placeholder="New quiz title, e.g. Cell biology week 3"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
        />
        <Button type="submit" disabled={!ready || !title.trim()} loading={busy}>
          Create
        </Button>
      </form>
      <ErrorText>{error}</ErrorText>

      <div className="mt-6">
        {status === 'loading' ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : quizzes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No quizzes yet. Create one above.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {quizzes.map((q) => (
              <li key={q.recordId}>
                <Link to={`/quizzes/${q.recordId}`} className="flex items-center justify-between px-4 py-4 hover:bg-accent">
                  <span className="font-medium">{q.data.title}</span>
                  <span className="text-sm text-muted-foreground">Edit →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  )
}
