/**
 * SSE Stream endpoint — /api/stream
 *
 * Each authenticated client opens one long-lived GET connection here.
 * The broadcaster singleton pushes events down this stream:
 *   - tick        { secondsLeft }          every second
 *   - new_round   { round }                when the minute flips
 *   - leaderboard { entries }              after any player answers
 *
 * On first connect we immediately send:
 *   - 'init'      full state: player, round, leaderboard, secondsLeft
 */

import { cookies } from 'next/headers'
import { getPlayer, getPlayerByNorm, upsertPlayer, getLeaderboard, getPlayerAnswer } from '@/lib/db'
import { subscribe, getCurrentRound, getSecondLeft } from '@/lib/broadcaster'
import { createHash } from 'crypto'

const COOKIE = 'aptitude_player'
const SECRET_KEY = process.env.AUTH_SECRET || process.env.DATABASE_URL || 'aptiquiz_session_secret_2026'

function sign(value: string) {
  return createHash('sha256').update(value + SECRET_KEY).digest('hex')
}

async function getPlayerFromCookies() {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE)?.value
    if (!token) return null
    const dotIdx = token.lastIndexOf('.')
    if (dotIdx === -1) return null
    const payload = token.slice(0, dotIdx)
    if (token.slice(dotIdx + 1) !== sign(payload)) return null
    const colonIdx = payload.indexOf(':')
    const id = colonIdx === -1 ? payload : payload.slice(0, colonIdx)
    const b64username = colonIdx === -1 ? '' : payload.slice(colonIdx + 1)
    let p = await getPlayer(id)
    if (!p && b64username) {
      const username = Buffer.from(b64username, 'base64url').toString('utf8')
      p = await upsertPlayer(username, username.toLowerCase())
    }
    return p ? { id: p.id, username: p.username, score: p.score } : null
  } catch { return null }
}

export const dynamic = 'force-dynamic'

export async function GET() {
  const p = await getPlayerFromCookies()
  if (!p) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Fetch initial state in parallel
  const [round, leaderboard] = await Promise.all([
    getCurrentRound(),
    getLeaderboard(),
  ])
  const answer = await getPlayerAnswer(p.id, round.id)

  let cleanup: (() => void) | null = null
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const encoder = new TextEncoder()

  function sendSSE(event: string, data: unknown) {
    try {
      const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      controller?.enqueue(encoder.encode(msg))
    } catch { /* stream closed */ }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl

      // Send full initial state immediately
      sendSSE('init', {
        player: p,
        round: { ...round, answered: !!answer, result: answer ?? null },
        leaderboard,
        secondsLeft: getSecondLeft(),
      })

      // Subscribe to the broadcaster game loop
      cleanup = subscribe((event) => {
        sendSSE(event.type, event)
      })
    },
    cancel() {
      cleanup?.()
      controller = null
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable Nginx buffering
    },
  })
}
