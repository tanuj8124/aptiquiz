import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'

// In-memory types
export interface PlayerRecord {
  id: string
  username: string
  username_normalized: string
  score: number
  created_at: Date
  last_seen_at: Date
}

export interface RoundRecord {
  id: string
  round_key: number
  starts_at: Date
  ends_at: Date
  question: string
  options: string[]
  correct_index: number
  explanation: string
  category: string
  difficulty: string
}

export interface AnswerRecord {
  id: string
  player_id: string
  round_id: string
  selected_index: number
  is_correct: boolean
  created_at: Date
}

// In-memory state store for zero-config local development and fallbacks
interface StoreState {
  players: Map<string, PlayerRecord>
  playersByNorm: Map<string, string> // username_normalized -> id
  rounds: Map<number, RoundRecord>
  answers: Map<string, AnswerRecord> // `${player_id}:${round_id}` -> AnswerRecord
  nextPlayerId: number
  nextRoundId: number
  nextAnswerId: number
}

const globalStore = globalThis as unknown as { __aptiquiz_store?: StoreState }

if (!globalStore.__aptiquiz_store) {
  const store: StoreState = {
    players: new Map(),
    playersByNorm: new Map(),
    rounds: new Map(),
    answers: new Map(),
    nextPlayerId: 1,
    nextRoundId: 1,
    nextAnswerId: 1,
  }

  globalStore.__aptiquiz_store = store
} else {
  // Clean up any previously seeded dummy accounts if present
  const dummyUsernames = ['alex_pro', 'quantummind', 'logicmaster', 'speeddemon']
  for (const norm of dummyUsernames) {
    const id = globalStore.__aptiquiz_store.playersByNorm.get(norm)
    if (id) {
      globalStore.__aptiquiz_store.players.delete(id)
      globalStore.__aptiquiz_store.playersByNorm.delete(norm)
    }
  }
}

const memoryStore = globalStore.__aptiquiz_store

let poolInstance: Pool | null = null
let hasCheckedDb = false
let usePostgres = false

if (process.env.DATABASE_URL) {
  try {
    poolInstance = new Pool({ connectionString: process.env.DATABASE_URL })
  } catch (err) {
    console.warn('[DB] Could not initialize PostgreSQL Pool, using in-memory store:', err)
  }
}

export const pool = poolInstance || new Pool()
export const db = drizzle(pool)

async function ensureTables() {
  if (hasCheckedDb || !poolInstance) return
  try {
    const client = await poolInstance.connect()
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS quiz_players (
          id SERIAL PRIMARY KEY,
          username VARCHAR(255) NOT NULL,
          username_normalized VARCHAR(255) UNIQUE NOT NULL,
          score INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS quiz_rounds (
          id SERIAL PRIMARY KEY,
          round_key BIGINT UNIQUE NOT NULL,
          starts_at TIMESTAMP NOT NULL,
          ends_at TIMESTAMP NOT NULL,
          question TEXT NOT NULL,
          options JSONB NOT NULL,
          correct_index INT NOT NULL,
          explanation TEXT NOT NULL,
          category VARCHAR(100) NOT NULL,
          difficulty VARCHAR(50) NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quiz_answers (
          id SERIAL PRIMARY KEY,
          player_id INT NOT NULL,
          round_id INT NOT NULL,
          selected_index INT NOT NULL,
          is_correct BOOLEAN NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(player_id, round_id)
        );
      `)
      usePostgres = true
    } finally {
      client.release()
    }
  } catch (err) {
    console.warn('[DB] PostgreSQL table verification failed, falling back to memory store:', err)
    usePostgres = false
  }
  hasCheckedDb = true
}

export async function getPlayer(id: string): Promise<PlayerRecord | null> {
  if (poolInstance && !hasCheckedDb) await ensureTables()

  if (usePostgres && poolInstance) {
    try {
      const rows = await db.execute(sql`select id, username, score from quiz_players where id = ${id} limit 1`)
      const row = rows.rows[0] as any
      if (!row) return null
      return {
        id: String(row.id),
        username: row.username,
        username_normalized: row.username_normalized || row.username.toLowerCase(),
        score: Number(row.score) || 0,
        created_at: new Date(row.created_at || Date.now()),
        last_seen_at: new Date(row.last_seen_at || Date.now()),
      }
    } catch {
      // Fallback to memory
    }
  }

  return memoryStore.players.get(String(id)) || null
}

export async function getPlayerByNorm(norm: string): Promise<PlayerRecord | null> {
  if (poolInstance && !hasCheckedDb) await ensureTables()

  if (usePostgres && poolInstance) {
    try {
      const rows = await db.execute(sql`select id, username, username_normalized, score from quiz_players where username_normalized = ${norm} limit 1`)
      const row = rows.rows[0] as any
      if (!row) return null
      return {
        id: String(row.id),
        username: row.username,
        username_normalized: row.username_normalized,
        score: Number(row.score) || 0,
        created_at: new Date(row.created_at || Date.now()),
        last_seen_at: new Date(row.last_seen_at || Date.now()),
      }
    } catch {
      // Fallback to memory
    }
  }

  const existingId = memoryStore.playersByNorm.get(norm)
  if (!existingId) return null
  return memoryStore.players.get(existingId) || null
}


export async function upsertPlayer(clean: string, norm: string): Promise<PlayerRecord> {
  if (poolInstance && !hasCheckedDb) await ensureTables()

  if (usePostgres && poolInstance) {
    try {
      const rows = await db.execute(
        sql`insert into quiz_players (username, username_normalized) values (${clean}, ${norm}) on conflict (username_normalized) do update set last_seen_at=now() returning id, username, score`
      )
      const pl = rows.rows[0] as any
      return {
        id: String(pl.id),
        username: pl.username,
        username_normalized: norm,
        score: Number(pl.score) || 0,
        created_at: new Date(),
        last_seen_at: new Date(),
      }
    } catch {
      // Fallback to memory
    }
  }

  const existingId = memoryStore.playersByNorm.get(norm)
  if (existingId && memoryStore.players.has(existingId)) {
    const p = memoryStore.players.get(existingId)!
    p.last_seen_at = new Date()
    p.username = clean // update casing if changed
    return p
  }

  const newId = String(memoryStore.nextPlayerId++)
  const newPlayer: PlayerRecord = {
    id: newId,
    username: clean,
    username_normalized: norm,
    score: 0,
    created_at: new Date(),
    last_seen_at: new Date(),
  }
  memoryStore.players.set(newId, newPlayer)
  memoryStore.playersByNorm.set(norm, newId)
  return newPlayer
}

export async function getLeaderboard(): Promise<Array<{ username: string; score: number }>> {
  if (poolInstance && !hasCheckedDb) await ensureTables()

  if (usePostgres && poolInstance) {
    try {
      const board = await db.execute(sql`select username, score from quiz_players order by score desc, created_at asc limit 10`)
      return board.rows as Array<{ username: string; score: number }>
    } catch {
      // Fallback to memory
    }
  }

  const list = Array.from(memoryStore.players.values())
  list.sort((a, b) => b.score - a.score || a.created_at.getTime() - b.created_at.getTime())
  return list.slice(0, 10).map((p) => ({ username: p.username, score: p.score }))
}

export async function getRoundByKey(key: number): Promise<RoundRecord | null> {
  if (poolInstance && !hasCheckedDb) await ensureTables()

  if (usePostgres && poolInstance) {
    try {
      const rows = await db.execute(
        sql`select id, round_key, question, options, correct_index, explanation, category, difficulty, starts_at, ends_at from quiz_rounds where round_key = ${key} limit 1`
      )
      const r = rows.rows[0] as any
      if (!r) return null
      return {
        id: String(r.id),
        round_key: Number(r.round_key),
        starts_at: new Date(r.starts_at),
        ends_at: new Date(r.ends_at),
        question: r.question,
        options: typeof r.options === 'string' ? JSON.parse(r.options) : r.options,
        correct_index: Number(r.correct_index),
        explanation: r.explanation,
        category: r.category,
        difficulty: r.difficulty,
      }
    } catch {
      // Fallback to memory
    }
  }

  return memoryStore.rounds.get(key) || null
}

export async function saveRound(data: {
  round_key: number
  starts_at: Date
  ends_at: Date
  question: string
  options: string[]
  correct_index: number
  explanation: string
  category: string
  difficulty: string
}): Promise<RoundRecord> {
  if (poolInstance && !hasCheckedDb) await ensureTables()

  if (usePostgres && poolInstance) {
    try {
      await db.execute(
        sql`insert into quiz_rounds (round_key, starts_at, ends_at, question, options, correct_index, explanation, category, difficulty) values (${data.round_key}, ${data.starts_at}, ${data.ends_at}, ${data.question}, ${JSON.stringify(data.options)}::jsonb, ${data.correct_index}, ${data.explanation}, ${data.category}, ${data.difficulty}) on conflict (round_key) do nothing`
      )
      const found = await getRoundByKey(data.round_key)
      if (found) return found
    } catch {
      // Fallback to memory
    }
  }

  if (memoryStore.rounds.has(data.round_key)) {
    return memoryStore.rounds.get(data.round_key)!
  }

  const roundRecord: RoundRecord = {
    id: String(memoryStore.nextRoundId++),
    ...data,
  }
  memoryStore.rounds.set(data.round_key, roundRecord)
  return roundRecord
}

export async function getPlayerAnswer(
  playerId: string,
  roundId: string
): Promise<{ selected_index: number; is_correct: boolean } | null> {
  if (poolInstance && !hasCheckedDb) await ensureTables()

  if (usePostgres && poolInstance) {
    try {
      const answer = await db.execute(
        sql`select selected_index, is_correct from quiz_answers where player_id = ${playerId} and round_id = ${roundId} limit 1`
      )
      const a = answer.rows[0] as any
      if (a) return { selected_index: Number(a.selected_index), is_correct: Boolean(a.is_correct) }
      return null
    } catch {
      // Fallback
    }
  }

  const key = `${playerId}:${roundId}`
  const a = memoryStore.answers.get(key)
  if (a) return { selected_index: a.selected_index, is_correct: a.is_correct }
  return null
}

export async function submitAnswer(
  playerId: string,
  roundId: string,
  selectedIndex: number,
  isCorrect: boolean
): Promise<boolean> {
  if (poolInstance && !hasCheckedDb) await ensureTables()

  if (usePostgres && poolInstance) {
    try {
      await db.execute(
        sql`insert into quiz_answers (player_id, round_id, selected_index, is_correct) values (${playerId}, ${roundId}, ${selectedIndex}, ${isCorrect}) on conflict (player_id, round_id) do nothing`
      )
      if (isCorrect) {
        await db.execute(
          sql`update quiz_players set score=score+1, last_seen_at=now() where id=${playerId} and not exists (select 1 from quiz_answers where player_id=${playerId} and round_id=${roundId} and id <> (select max(id) from quiz_answers where player_id=${playerId} and round_id=${roundId}))`
        )
      }
      return true
    } catch {
      // Fallback
    }
  }

  const key = `${playerId}:${roundId}`
  if (memoryStore.answers.has(key)) {
    return false // Already answered
  }

  memoryStore.answers.set(key, {
    id: String(memoryStore.nextAnswerId++),
    player_id: playerId,
    round_id: roundId,
    selected_index: selectedIndex,
    is_correct: isCorrect,
    created_at: new Date(),
  })

  if (isCorrect) {
    const player = memoryStore.players.get(String(playerId))
    if (player) {
      player.score += 1
      player.last_seen_at = new Date()
    }
  }

  return true
}
