/**
 * broadcaster.ts — Server-side SSE game loop singleton
 * Pre-warms the next round at <=10s remaining so the flip is instant.
 */

import { getRoundByKey, saveRound, getLeaderboard } from "./db"
import { deloitteFallbackBank } from "../app/api/quiz/question-bank"

export interface RoundPayload {
  id: string
  round_key: number
  question: string
  options: string[]
  correct_index: number
  explanation: string
  category: string
  difficulty: string
  starts_at: string
  ends_at: string
}

export interface LeaderboardEntry {
  username: string
  score: number
}

export type SSEEvent =
  | { type: "tick"; secondsLeft: number }
  | { type: "new_round"; round: RoundPayload }
  | { type: "leaderboard"; entries: LeaderboardEntry[] }

interface BroadcasterState {
  clients: Set<(event: SSEEvent) => void>
  currentRoundKey: number
  currentRound: RoundPayload | null
  // Pre-warmed next round — ready before the minute flips
  nextRoundKey: number
  nextRound: RoundPayload | null
  prewarming: boolean
  intervalId: ReturnType<typeof setInterval> | null
}

declare global {
  // eslint-disable-next-line no-var
  var __aptiquiz_broadcaster: BroadcasterState | undefined
}

function getState(): BroadcasterState {
  if (!global.__aptiquiz_broadcaster) {
    global.__aptiquiz_broadcaster = {
      clients: new Set(),
      currentRoundKey: -1,
      currentRound: null,
      nextRoundKey: -1,
      nextRound: null,
      prewarming: false,
      intervalId: null,
    }
  }
  return global.__aptiquiz_broadcaster
}

function roundKey() { return Math.floor(Date.now() / 60000) }

export function getSecondLeft() {
  const secs = Math.floor(Date.now() / 1000) % 60
  return secs === 0 ? 0 : 60 - secs
}

function makeQuestion(key: number) {
  const idx = key % deloitteFallbackBank.length
  return deloitteFallbackBank[idx]
}

// Create or fetch a round record and return a RoundPayload
async function fetchRound(key: number): Promise<RoundPayload> {
  let r = await getRoundByKey(key)
  if (!r) {
    const q = makeQuestion(key)
    r = await saveRound({
      round_key: key,
      starts_at: new Date(key * 60000),
      ends_at: new Date((key + 1) * 60000),
      question: q.question,
      options: q.options,
      correct_index: q.correct,
      explanation: q.explanation || "",
      category: q.category || "Deloitte Quants",
      difficulty: q.difficulty || "Medium",
    })
  }
  return {
    id: r.id,
    round_key: r.round_key,
    question: r.question,
    options: r.options,
    correct_index: r.correct_index,
    explanation: r.explanation,
    category: r.category,
    difficulty: r.difficulty,
    starts_at: r.starts_at.toISOString(),
    ends_at: r.ends_at.toISOString(),
  }
}

// Ensure current round is in memory (used on subscribe for new clients)
async function ensureCurrentRound(key: number): Promise<RoundPayload> {
  const state = getState()
  if (state.currentRoundKey === key && state.currentRound) return state.currentRound
  // Check if pre-warmed round matches current key (edge case: client connects just as round flips)
  if (state.nextRoundKey === key && state.nextRound) {
    state.currentRound = state.nextRound
    state.currentRoundKey = key
    state.nextRound = null
    state.nextRoundKey = -1
    return state.currentRound
  }
  const payload = await fetchRound(key)
  state.currentRoundKey = key
  state.currentRound = payload
  return payload
}

// Silently pre-warm the next round into memory
async function prewarm(nextKey: number) {
  const state = getState()
  if (state.prewarming || state.nextRoundKey === nextKey) return
  state.prewarming = true
  try {
    const payload = await fetchRound(nextKey)
    state.nextRound = payload
    state.nextRoundKey = nextKey
    console.log(`[Broadcaster] Pre-warmed round ${nextKey}`)
  } catch (err) {
    console.error("[Broadcaster] Prewarm error:", err)
  } finally {
    state.prewarming = false
  }
}

function broadcast(state: BroadcasterState, event: SSEEvent) {
  for (const send of state.clients) {
    try { send(event) } catch { /* client disconnected */ }
  }
}

async function tick() {
  const state = getState()
  const sl = getSecondLeft()
  const key = roundKey()

  // Always push the server-authoritative timer
  broadcast(state, { type: "tick", secondsLeft: sl })

  // Pre-warm next round when <=10s remain so the flip is instant
  if (sl <= 10 && sl > 0) {
    prewarm(key + 1) // fire-and-forget, guards against double-prewarm internally
  }

  // Round flipped
  if (key !== state.currentRoundKey) {
    let round: RoundPayload

    if (state.nextRound && state.nextRoundKey === key) {
      // ✅ Instant: use pre-warmed round — zero DB latency at flip time
      round = state.nextRound
      state.currentRound = round
      state.currentRoundKey = key
      state.nextRound = null
      state.nextRoundKey = -1
      console.log(`[Broadcaster] Round ${key} flipped instantly from cache`)
    } else {
      // Fallback: fetch now (first boot or prewarm missed)
      console.log(`[Broadcaster] Round ${key} — no cache, fetching...`)
      round = await fetchRound(key)
      state.currentRound = round
      state.currentRoundKey = key
    }

    broadcast(state, { type: "new_round", round })

    // Broadcast fresh leaderboard at each new round
    try {
      const entries = await getLeaderboard()
      broadcast(state, { type: "leaderboard", entries })
    } catch (err) {
      console.error("[Broadcaster] Leaderboard error:", err)
    }
  }
}

function startLoop() {
  const state = getState()
  if (state.intervalId !== null) return
  // Align to next whole second for a clean tick cadence
  const msToNext = 1000 - (Date.now() % 1000)
  setTimeout(() => {
    tick()
    state.intervalId = setInterval(tick, 1000)
  }, msToNext)
}

export function subscribe(send: (event: SSEEvent) => void): () => void {
  const state = getState()
  state.clients.add(send)
  startLoop()
  return () => state.clients.delete(send)
}

export async function getCurrentRound(): Promise<RoundPayload> {
  return ensureCurrentRound(roundKey())
}

export async function broadcastLeaderboard() {
  const state = getState()
  try {
    const entries = await getLeaderboard()
    broadcast(state, { type: "leaderboard", entries })
  } catch (err) {
    console.error("[Broadcaster] Error broadcasting leaderboard:", err)
  }
}
