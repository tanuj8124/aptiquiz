import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import {
  getPlayer,
  getPlayerByNorm,
  upsertPlayer,
  deletePlayer,
  getPlayerAnswer,
  submitAnswer,
} from '@/lib/db'
import { broadcastLeaderboard, getCurrentRound } from '@/lib/broadcaster'
import { createHash } from 'crypto'

const COOKIE = 'aptitude_player'
const SECRET_KEY = process.env.AUTH_SECRET || process.env.DATABASE_URL || 'aptiquiz_session_secret_2026'

function sign(value: string) {
  return createHash('sha256').update(value + SECRET_KEY).digest('hex')
}

function makeToken(id: string, username: string) {
  const b64 = Buffer.from(username).toString('base64url')
  const payload = `${id}:${b64}`
  return `${payload}.${sign(payload)}`
}

export async function parsePlayer(cookieHeader?: string | null) {
  try {
    const token = cookieHeader?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1]
    if (!token) return null
    const dotIdx = token.lastIndexOf('.')
    if (dotIdx === -1) return null
    const payload = token.slice(0, dotIdx)
    const sig = token.slice(dotIdx + 1)
    if (sig !== sign(payload)) return null
    const colonIdx = payload.indexOf(':')
    const id = colonIdx === -1 ? payload : payload.slice(0, colonIdx)
    const p = await getPlayer(id)
    return p ? { id: p.id, username: p.username, score: p.score } : null
  } catch { return null }
}

async function player() {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE)?.value
    if (!token) return null
    const dotIdx = token.lastIndexOf('.')
    if (dotIdx === -1) return null
    const payload = token.slice(0, dotIdx)
    const sig = token.slice(dotIdx + 1)
    if (sig !== sign(payload)) return null
    const colonIdx = payload.indexOf(':')
    const id = colonIdx === -1 ? payload : payload.slice(0, colonIdx)
    const p = await getPlayer(id)
    return p ? { id: p.id, username: p.username, score: p.score } : null
  } catch { return null }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })
}

export async function GET() {
  const p = await player()
  if (!p) return NextResponse.json({ signedIn: false })
  const round = await getCurrentRound()
  const answer = await getPlayerAnswer(p.id, round.id)
  return NextResponse.json({
    signedIn: true,
    player: p,
    round: { ...round, answered: !!answer, result: answer ?? null },
  })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { username, answer } = body

    if (username !== undefined) {
      const clean = String(username).trim().replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 20)
      if (clean.length < 2) return NextResponse.json({ error: 'Use at least 2 characters' }, { status: 400 })
      const existingPlayer = await player()
      if (existingPlayer) {
        const token = makeToken(existingPlayer.id, existingPlayer.username)
        const res = NextResponse.json({ ok: true, player: existingPlayer })
        res.cookies.set(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 30, path: '/' })
        return res
      }
      let finalClean = clean, norm = clean.toLowerCase()
      const existingById = await getPlayerByNorm(norm)
      if (existingById) { const suffix = Math.floor(1000 + Math.random() * 9000); finalClean = clean.slice(0, 15) + '_' + suffix; norm = finalClean.toLowerCase() }
      const pl = await upsertPlayer(finalClean, norm)
      const token = makeToken(pl.id, pl.username)
      const res = NextResponse.json({ ok: true, player: { id: pl.id, username: pl.username, score: pl.score } })
      res.cookies.set(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 30, path: '/' })
      return res
    }

    const p = await player()
    if (!p) return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
    const round = await getCurrentRound()
    if (Date.now() >= new Date(round.ends_at).getTime()) return NextResponse.json({ error: 'Round is locked' }, { status: 400 })
    const idx = Number(answer)
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) return NextResponse.json({ error: 'Invalid answer' }, { status: 400 })
    const correct = idx === round.correct_index
    const saved = await submitAnswer(p.id, round.id, idx, correct)
    if (saved) {
      // Broadcast updated leaderboard to all SSE clients
      broadcastLeaderboard().catch(console.error)
    }
    return NextResponse.json({ ok: true, correct })
  } catch (err: any) {
    console.error('Error in POST /api/quiz:', err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}

export async function DELETE() {
  try {
    const p = await player()
    if (p) {
      await deletePlayer(p.id)
      broadcastLeaderboard().catch(console.error)
    }
  } catch (err) {
    console.error('Error deleting player on sign out:', err)
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(COOKIE)
  return res
}
