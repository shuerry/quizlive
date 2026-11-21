/** Home: host a quiz or join one. */

import { Link } from 'react-router-dom'
import { Page } from '../../components/quiz'

export default function HomePage() {
  return (
    <Page className="max-w-md">
      <h1 className="text-3xl font-black">QuizLive</h1>
      <p className="mt-2 text-muted-foreground">Live class quizzes. Answer on your phone, watch the leaderboard move.</p>
      <div className="mt-8 grid gap-4">
        <Link
          to="/play"
          data-testid="home-join"
          className="rounded-xl bg-primary p-6 text-primary-foreground shadow-sm transition hover:opacity-90"
        >
          <span className="block text-xl font-bold">Join a game</span>
          <span className="text-sm opacity-80">Got a 6-character code? Start here.</span>
        </Link>
        <Link to="/quizzes" data-testid="home-host" className="rounded-xl border border-border bg-card p-6 shadow-sm transition hover:bg-accent">
          <span className="block text-xl font-bold">Host a quiz</span>
          <span className="text-sm text-muted-foreground">Write questions, start a game, run it live.</span>
        </Link>
      </div>
    </Page>
  )
}
