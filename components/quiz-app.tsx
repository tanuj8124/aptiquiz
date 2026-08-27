"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Clock3, Trophy, Zap, LogOut, LockKeyhole, Loader2, CheckCircle2, XCircle } from "lucide-react"
import { deloitteFallbackBank } from "@/app/api/quiz/question-bank"

// ---------------------------------------------------------------------------
// Types & Helpers
// ---------------------------------------------------------------------------

interface Player { id: string; username: string; score: number }

interface Round {
  id?: string
  round_key: number
  question: string
  options: string[]
  correct_index: number
  explanation?: string
  category: string
  difficulty: string
  starts_at: string
  ends_at: string
  answered: boolean
  result: { selected_index: number; is_correct: boolean } | null
}

interface LeaderboardEntry { username: string; score: number }

function getRoundKey() {
  return Math.floor(Date.now() / 60000)
}

function getSecondsLeft() {
  const secs = Math.floor(Date.now() / 1000) % 60
  return secs === 0 ? 0 : 60 - secs
}

function getLocalRound(key: number): Round {
  const q = deloitteFallbackBank[key % deloitteFallbackBank.length]
  const starts = new Date(key * 60000).toISOString()
  const ends = new Date((key + 1) * 60000).toISOString()
  return {
    round_key: key,
    question: q.question,
    options: q.options,
    correct_index: q.correct,
    explanation: q.explanation || "",
    category: q.category || "Deloitte Quants",
    difficulty: q.difficulty || "Medium",
    starts_at: starts,
    ends_at: ends,
    answered: false,
    result: null,
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuizApp() {
  const [status, setStatus] = useState<"connecting" | "unauthenticated" | "playing">("connecting")
  const [name, setName] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const [busy, setBusy] = useState(false)

  const [player, setPlayer] = useState<Player | null>(null)
  const [roundKey, setRoundKey] = useState<number>(getRoundKey)
  const [round, setRound] = useState<Round>(() => getLocalRound(getRoundKey()))
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [secondsLeft, setSecondsLeft] = useState<number>(getSecondsLeft)

  // Local answer selection & feedback
  const [selected, setSelected] = useState<number | null>(null)
  const [localResult, setLocalResult] = useState<{ selected_index: number; is_correct: boolean } | null>(null)
  const answerLockRef = useRef(false)

  const esRef = useRef<EventSource | null>(null)
  const roundKeyRef = useRef<number>(getRoundKey())

  // ---------------------------------------------------------------------------
  // Instant Client-side Clock & Transition Loop (0ms Latency)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const timer = setInterval(() => {
      const remaining = getSecondsLeft()
      setSecondsLeft(remaining)

      const currKey = getRoundKey()
      if (currKey !== roundKeyRef.current) {
        // Instant 0ms transition right as the second hits 00
        roundKeyRef.current = currKey
        setRoundKey(currKey)
        setRound(getLocalRound(currKey))
        setSelected(null)
        setLocalResult(null)
        answerLockRef.current = false
      }
    }, 200)

    return () => clearInterval(timer)
  }, [])

  // ---------------------------------------------------------------------------
  // Real-time SSE Stream for Live Leaderboard & Player Sync
  // ---------------------------------------------------------------------------
  const connectSSE = useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }

    const es = new EventSource("/api/stream")
    esRef.current = es

    es.addEventListener("init", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.player) setPlayer(data.player)
        if (data.leaderboard) setLeaderboard(data.leaderboard)

        // Sync if already answered on server for this round
        if (data.round?.answered && data.round?.result && data.round.round_key === roundKeyRef.current) {
          setSelected(data.round.result.selected_index)
          setLocalResult({
            selected_index: data.round.result.selected_index,
            is_correct: data.round.result.is_correct,
          })
          answerLockRef.current = true
        }
      } catch (err) {
        console.error("Failed to parse init:", err)
      }
    })

    es.addEventListener("leaderboard", (e) => {
      try {
        const { entries } = JSON.parse(e.data)
        if (entries) setLeaderboard(entries)
      } catch {}
    })

    es.onerror = () => {
      // If disconnected, don't block gameplay
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Fast Initial Auth Check (Instantaneous, avoids SSE 401 timeout)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Check saved username preference if any
    const savedName = localStorage.getItem("aptiquiz_name")
    if (savedName) setName(savedName)

    fetch("/api/quiz", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (data.signedIn && data.player) {
          setPlayer(data.player)
          setStatus("playing")
          connectSSE()
        } else {
          setStatus("unauthenticated")
        }
      })
      .catch(() => {
        setStatus("unauthenticated")
      })

    return () => {
      esRef.current?.close()
      esRef.current = null
    }
  }, [connectSSE])

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------
  async function join(e: React.FormEvent) {
    e.preventDefault()
    const clean = name.trim()
    if (clean.length < 2) {
      setErrorMsg("Please enter at least 2 characters")
      return
    }
    setErrorMsg("")
    setBusy(true)
    try {
      localStorage.setItem("aptiquiz_name", clean)
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: clean }),
      })
      const result = await res.json()
      if (!res.ok) {
        setErrorMsg(result.error || "Failed to enter quiz")
      } else {
        if (result.player) setPlayer(result.player)
        setStatus("playing")
        connectSSE()
      }
    } catch {
      setErrorMsg("Network error. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Answer — Instant zero-latency verification & background sync
  // ---------------------------------------------------------------------------
  function answer(idx: number) {
    if (answerLockRef.current || !round || secondsLeft === 0) return
    if (selected !== null || round.answered) return
    answerLockRef.current = true

    // 100% Instant local checking
    const isCorrect = idx === round.correct_index
    setSelected(idx)
    setLocalResult({ selected_index: idx, is_correct: isCorrect })

    if (isCorrect) {
      setPlayer((prev) => (prev ? { ...prev, score: prev.score + 1 } : prev))
    }

    // Submit to server in background for persistent DB score and friend leaderboard
    fetch("/api/quiz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: idx }),
    }).catch(() => {
      // Background sync error - local progress is preserved
    })
  }

  // ---------------------------------------------------------------------------
  // Sign Out (Deletes user and session)
  // ---------------------------------------------------------------------------
  async function signOut() {
    try {
      esRef.current?.close()
      esRef.current = null
      localStorage.removeItem("aptiquiz_name")
      setName("")
      await fetch("/api/quiz", { method: "DELETE" })
      setStatus("unauthenticated")
      setPlayer(null)
      setSelected(null)
      setLocalResult(null)
      answerLockRef.current = false
    } catch (err) {
      console.error("Sign out error:", err)
    }
  }

  // ---------------------------------------------------------------------------
  // Render: Loading
  // ---------------------------------------------------------------------------
  if (status === "connecting") {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-muted-foreground">
        <div className="flex items-center gap-3">
          <Loader2 className="size-6 animate-spin text-primary" />
          <span className="text-base font-medium">Starting challenges...</span>
        </div>
      </main>
    )
  }

  // ---------------------------------------------------------------------------
  // Render: Sign-in
  // ---------------------------------------------------------------------------
  if (status === "unauthenticated") {
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
            Crack Deloitte.<br /><span className="text-primary">Master Aptitude.</span>
          </h1>
          <p className="mt-5 text-lg leading-7 text-muted-foreground">
            Fast-paced questions directly focused on Deloitte Placement Rounds. Compete with your friends in real-time!
          </p>
          <form onSubmit={join} className="mt-10 flex flex-col gap-3">
            <div className="flex gap-3">
              <input
                id="username-input"
                type="text"
                value={name}
                autoFocus
                maxLength={20}
                onChange={(e) => {
                  setName(e.target.value)
                  if (errorMsg) setErrorMsg("")
                }}
                placeholder="Enter nickname"
                className="min-w-0 flex-1 rounded-xl border bg-card px-4 py-3 text-foreground placeholder:text-muted-foreground outline-none ring-primary transition focus:ring-2 focus:border-transparent"
              />
              <button
                id="enter-button"
                type="submit"
                disabled={busy}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-primary-foreground shadow-md shadow-primary/20 transition hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? <Loader2 size={18} className="animate-spin" /> : "Enter"}
              </button>
            </div>
            {errorMsg && <p className="text-sm font-medium text-destructive animate-in fade-in">{errorMsg}</p>}
          </form>
        </section>
      </main>
    )
  }

  const effectiveResult = localResult ?? round.result
  const answered = round.answered || !!localResult
  const locked = secondsLeft === 0 || answered
  const isCorrect = effectiveResult?.is_correct

  // ---------------------------------------------------------------------------
  // Render: Quiz Game UI
  // ---------------------------------------------------------------------------
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
            <span className="font-medium text-foreground">{player?.username || "Player"}</span>
            <span className="text-xs text-muted-foreground font-mono">({player?.score ?? 0} pts)</span>
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
        {/* Question Area */}
        <section>
          <div className="mb-6 flex items-center justify-between">
            <div>
              <p className="font-mono text-xs font-semibold uppercase tracking-[.2em] text-primary">
                {round.category} / {round.difficulty}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">Round #{roundKey}</p>
            </div>
            <div
              className={`flex items-center gap-2 rounded-full border px-4 py-2 font-mono text-sm font-semibold transition ${
                secondsLeft < 10
                  ? "border-destructive bg-destructive/10 text-destructive animate-pulse"
                  : "border-primary/30 bg-primary/5 text-primary"
              }`}
            >
              <Clock3 size={16} />
              {String(secondsLeft).padStart(2, "0")}s
            </div>
          </div>

          <article className="rounded-2xl border bg-card p-6 shadow-sm md:p-10">
            <h1 className="max-w-3xl text-2xl md:text-3xl lg:text-4xl font-semibold leading-tight text-balance">
              {round.question}
            </h1>

            <div className="mt-8 grid gap-3">
              {round.options.map((option, idx) => {
                const isSelected = selected === idx || effectiveResult?.selected_index === idx
                return (
                  <button
                    key={idx}
                    disabled={locked}
                    onClick={() => answer(idx)}
                    className={`group flex items-center gap-4 rounded-xl border p-4 text-left transition-all duration-100 ${
                      isSelected
                        ? isCorrect
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-950 dark:text-emerald-200"
                          : answered
                          ? "border-rose-500 bg-rose-500/10 text-rose-950 dark:text-rose-200"
                          : "border-primary bg-primary/10"
                        : ""
                    } ${
                      locked
                        ? "cursor-not-allowed opacity-75"
                        : "hover:border-primary hover:bg-primary/5 active:scale-[0.99] cursor-pointer"
                    }`}
                  >
                    <span
                      className={`grid size-8 shrink-0 place-items-center rounded-lg font-mono text-sm font-bold transition-colors duration-100 ${
                        isSelected
                          ? isCorrect
                            ? "bg-emerald-500 text-white"
                            : answered
                            ? "bg-rose-500 text-white"
                            : "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground group-hover:bg-primary group-hover:text-primary-foreground"
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
                {effectiveResult ? (
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
                    {effectiveResult
                      ? isCorrect
                        ? "Correct! +1 point added."
                        : "Not quite right this time."
                      : "Round locked - time is up!"}
                  </p>
                  {effectiveResult && round.explanation && (
                    <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                      {round.explanation}
                    </p>
                  )}
                  <p className="mt-2 text-xs font-mono text-primary">
                    Next challenge starts automatically when the timer reaches 00s.
                  </p>
                </div>
              </div>
            )}
          </article>
        </section>

        {/* Live Friends Leaderboard */}
        <aside className="h-fit rounded-2xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-foreground">Live Leaderboard</h2>
            <Trophy size={18} className="text-primary" />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Top scores</p>
          <div className="mt-5 space-y-1.5">
            {leaderboard.length > 0 ? (
              leaderboard.map((entry, idx) => (
                <div
                  key={entry.username}
                  className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm transition ${
                    entry.username === player?.username
                      ? "bg-primary/10 border border-primary/20 font-medium"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <b className="font-mono text-xs text-muted-foreground w-5">
                      {String(idx + 1).padStart(2, "0")}
                    </b>
                    <span className="truncate max-w-[140px]">{entry.username}</span>
                  </span>
                  <b className="font-mono text-xs">{entry.score} pts</b>
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
