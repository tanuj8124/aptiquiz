'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { Clock3, Trophy, Zap, LogOut, LockKeyhole, Loader2, CheckCircle2, XCircle } from 'lucide-react'

interface Player {
  id: string
  username: string
  score: number
}

interface Round {
  id: string
  round_key: number
  question: string
  options: string[]
  explanation?: string
  category: string
  difficulty: string
  starts_at: string
  ends_at: string
  answered: boolean
  result: { selected_index: number; is_correct: boolean } | null
}

interface LeaderboardEntry {
  username: string
  score: number
}

interface QuizData {
  signedIn: boolean
  player?: Player
  round?: Round
  leaderboard?: LeaderboardEntry[]
  now?: number
}

export function QuizApp() {
  const [data, setData] = useState<QuizData | null>(null)
  const [name, setName] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [left, setLeft] = useState(60)

  const signedOutRetryRef = useRef(0)
  const dataRef = useRef<QuizData | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/quiz', { cache: 'no-store' })
      if (!res.ok) throw new Error('Failed to fetch data')
      const json: QuizData = await res.json()

      // Guard: if we were previously signed in and the server suddenly returns
      // signedIn:false, retry up to 2 times (handles HMR in-memory store resets
      // and transient network blips) before accepting it as a real sign-out.
      if (!json.signedIn && dataRef.current?.signedIn) {
        if (signedOutRetryRef.current < 2) {
          signedOutRetryRef.current += 1
          setTimeout(load, 800)
          return
        }
      }
      signedOutRetryRef.current = 0

      dataRef.current = json
      setData(json)
      if (json.round?.answered && json.round.result) {
        setSelected(json.round.result.selected_index)
      }
    } catch (err) {
      console.error('Failed to load quiz state:', err)
    }
  }, []) // stable — reads data via ref

  useEffect(() => {
    load()
  }, []) // run only on mount

  useEffect(() => {
    const interval = setInterval(() => {
      const remainingSeconds = 60 - Math.floor((Date.now() / 1000) % 60)
      setLeft(remainingSeconds)

      const currentKey = Math.floor(Date.now() / 60000)
      if (dataRef.current?.round && currentKey !== dataRef.current.round.round_key) {
        setSelected(null)
        load()
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [load]) // load is stable; dataRef reads are safe inside the interval


  async function join(e: React.FormEvent) {
    e.preventDefault()
    const clean = name.trim()
    if (clean.length < 2) {
      setErrorMsg('Please enter at least 2 characters')
      return
    }
    setErrorMsg('')
    setBusy(true)
    try {
      const res = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: clean }),
      })
      const result = await res.json()
      if (!res.ok) {
        setErrorMsg(result.error || 'Failed to enter quiz')
      } else {
        await load()
      }
    } catch {
      setErrorMsg('Network error. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function answer(idx: number) {
    if (!data?.round || selected !== null || data.round.answered || left === 0 || answering) return
    setSelected(idx)
    setAnswering(true)
    try {
      const res = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: idx }),
      })
      if (res.ok) {
        await load()
      }
    } catch (err) {
      console.error('Failed to submit answer:', err)
    } finally {
      setAnswering(false)
    }
  }

  async function signOut() {
    try {
      await fetch('/api/quiz', { method: 'DELETE' })
      setData({ signedIn: false })
      setName('')
      setSelected(null)
    } catch (err) {
      console.error('Sign out error:', err)
    }
  }

  if (!data) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-muted-foreground">
        <div className="flex items-center gap-3">
          <Loader2 className="size-6 animate-spin text-primary" />
          <span className="text-base font-medium">Loading challenge…</span>
        </div>
      </main>
    )
  }

  if (data.signedIn === false) {
    return (
      <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-b from-background via-background to-muted/20">
        <section className="w-full max-w-md">
          <div className="mb-10 flex items-center gap-3 text-primary">
            <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/25">
              <Zap size={20} fill="currentColor" />
            </span>
            <span className="font-mono text-sm font-semibold tracking-[.25em]">DELOITTE APTIQUIZ</span>
          </div>

          <h1 className="text-5xl md:text-6xl font-bold tracking-tight text-balance">
            Crack Deloitte.<br />
            <span className="text-primary">Master Aptitude.</span>
          </h1>

          <p className="mt-5 text-lg leading-7 text-muted-foreground">
            Fast-paced questions directly focused on Deloitte Placement Rounds (Quants, Logical Reasoning & Verbal Ability). A new challenge every minute!
          </p>

          <form onSubmit={join} className="mt-10 flex flex-col gap-3">
            <div className="flex gap-3">
              <input
                id="username-input"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (errorMsg) setErrorMsg('')
                }}
                placeholder="Choose a nickname"
                maxLength={20}
                autoFocus
                className="min-w-0 flex-1 rounded-xl border bg-card px-4 py-3 text-foreground placeholder:text-muted-foreground outline-none ring-primary transition focus:ring-2 focus:border-transparent"
              />
              <button
                id="enter-button"
                type="submit"
                disabled={busy}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-primary-foreground shadow-md shadow-primary/20 transition hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? <Loader2 size={18} className="animate-spin" /> : 'Enter'}
              </button>
            </div>
            {errorMsg && (
              <p className="text-sm font-medium text-destructive animate-in fade-in">
                {errorMsg}
              </p>
            )}
          </form>
        </section>
      </main>
    )
  }

  const r = data.round
  if (!r) {
    return (
      <main className="grid min-h-screen place-items-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin text-primary" />
      </main>
    )
  }

  const locked = left === 0 || r.answered
  const isCorrect = r.result?.is_correct

  return (
    <main className="min-h-screen px-5 py-8 md:px-10 bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Zap size={18} fill="currentColor" />
          </span>
          <span className="font-mono text-sm font-semibold tracking-[.2em]">ONE MINUTE</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2 rounded-full border bg-card/60 px-3.5 py-1.5 backdrop-blur-sm">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-medium text-foreground">{data.player?.username}</span>
            <span className="text-xs text-muted-foreground font-mono">({data.player?.score} pts)</span>
          </div>
          <button
            onClick={signOut}
            className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-muted transition"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>

      <div className="mx-auto mt-12 grid max-w-6xl gap-6 lg:grid-cols-[1fr_320px]">
        {/* Question Section */}
        <section>
          <div className="mb-6 flex items-center justify-between">
            <div>
              <p className="font-mono text-xs font-semibold uppercase tracking-[.2em] text-primary">
                {r.category} / {r.difficulty}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">Round #{r.round_key}</p>
            </div>
            <div
              className={`flex items-center gap-2 rounded-full border px-4 py-2 font-mono text-sm font-semibold transition ${
                left < 10
                  ? 'border-destructive bg-destructive/10 text-destructive animate-pulse'
                  : 'border-primary/30 bg-primary/5 text-primary'
              }`}
            >
              <Clock3 size={16} />
              {String(left).padStart(2, '0')}s
            </div>
          </div>

          <article className="rounded-2xl border bg-card p-6 shadow-sm md:p-10">
            <h1 className="max-w-3xl text-2xl md:text-3xl lg:text-4xl font-semibold leading-tight text-balance">
              {r.question}
            </h1>

            <div className="mt-8 grid gap-3">
              {r.options.map((option: string, idx: number) => {
                const isSelected = selected === idx || r.result?.selected_index === idx
                return (
                  <button
                    key={idx}
                    disabled={locked || answering}
                    onClick={() => answer(idx)}
                    className={`group flex items-center gap-4 rounded-xl border p-4 text-left transition ${
                      isSelected
                        ? isCorrect
                          ? 'border-emerald-500 bg-emerald-500/10 text-emerald-950 dark:text-emerald-200'
                          : r.answered
                          ? 'border-rose-500 bg-rose-500/10 text-rose-950 dark:text-rose-200'
                          : 'border-primary bg-primary/10'
                        : ''
                    } ${
                      locked
                        ? 'cursor-not-allowed opacity-75'
                        : 'hover:border-primary hover:bg-primary/5 active:scale-[0.99]'
                    }`}
                  >
                    <span
                      className={`grid size-8 shrink-0 place-items-center rounded-lg font-mono text-sm font-bold transition ${
                        isSelected
                          ? isCorrect
                            ? 'bg-emerald-500 text-white'
                            : r.answered
                            ? 'bg-rose-500 text-white'
                            : 'bg-primary text-primary-foreground'
                          : 'bg-muted text-foreground group-hover:bg-primary group-hover:text-primary-foreground'
                      }`}
                    >
                      {String.fromCharCode(65 + idx)}
                    </span>
                    <span className="font-medium">{option}</span>
                  </button>
                )
              })}
            </div>

            {locked && (
              <div className="mt-6 flex items-start gap-3 rounded-xl bg-muted/60 border p-4 text-sm">
                {r.result ? (
                  isCorrect ? (
                    <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle size={18} className="mt-0.5 shrink-0 text-rose-500" />
                  )
                ) : (
                  <LockKeyhole size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
                )}
                <div>
                  <p className="font-semibold">
                    {r.result
                      ? isCorrect
                        ? 'Correct! +1 point added.'
                        : 'Not quite right this time.'
                      : 'Round locked.'}
                  </p>
                  {r.explanation && (
                    <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                      {r.explanation}
                    </p>
                  )}
                  <p className="mt-2 text-xs font-mono text-primary">
                    Next challenge starts when the timer reaches 00s.
                  </p>
                </div>
              </div>
            )}
          </article>
        </section>

        {/* Leaderboard Section */}
        <aside className="h-fit rounded-2xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-foreground">Leaderboard</h2>
            <Trophy size={18} className="text-primary" />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Top players today</p>
          <div className="mt-5 space-y-1.5">
            {data.leaderboard && data.leaderboard.length > 0 ? (
              data.leaderboard.map((player, idx) => (
                <div
                  key={player.username}
                  className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm transition ${
                    player.username === data.player?.username
                      ? 'bg-primary/10 border border-primary/20 font-medium'
                      : 'hover:bg-muted/50'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <b className="font-mono text-xs text-muted-foreground w-5">{String(idx + 1).padStart(2, '0')}</b>
                    <span className="truncate max-w-[140px]">{player.username}</span>
                  </span>
                  <b className="font-mono text-xs">{player.score} pts</b>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground py-4 text-center">No scores yet today</p>
            )}
          </div>
        </aside>
      </div>
    </main>
  )
}
