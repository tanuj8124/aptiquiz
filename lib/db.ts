import { MongoClient, ObjectId } from 'mongodb'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// MongoDB singleton (cached on globalThis for Next.js serverless warm reuse)
// ---------------------------------------------------------------------------

const MONGODB_URI = process.env.MONGODB_URI || ''

declare global {
  // eslint-disable-next-line no-var
  var __aptiquiz_mongo: { client: MongoClient; promise: Promise<MongoClient>; lastFailed?: number } | undefined
}

async function getMongoClient(): Promise<MongoClient | null> {
  if (!MONGODB_URI) return null

  // If connection failed recently, avoid stalling every subsequent request
  if (global.__aptiquiz_mongo?.lastFailed && Date.now() - global.__aptiquiz_mongo.lastFailed < 20000) {
    return null
  }

  if (!global.__aptiquiz_mongo || global.__aptiquiz_mongo.lastFailed) {
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 2000,
      connectTimeoutMS: 2000,
      socketTimeoutMS: 5000,
    })
    global.__aptiquiz_mongo = { client, promise: client.connect() }
  }

  try {
    await global.__aptiquiz_mongo.promise
    return global.__aptiquiz_mongo.client
  } catch (err) {
    console.warn('[MongoDB] Connection failed, using in-memory store for 20s:', err instanceof Error ? err.message : err)
    global.__aptiquiz_mongo = {
      client: global.__aptiquiz_mongo.client,
      promise: Promise.resolve(global.__aptiquiz_mongo.client),
      lastFailed: Date.now()
    }
    return null
  }
}

function db(client: MongoClient) {
  const database = client.db('aptiquiz')
  return {
    players: database.collection('players'),
    rounds: database.collection('rounds'),
    answers: database.collection('answers'),
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback (used when MONGODB_URI is not set)
// ---------------------------------------------------------------------------

interface StoreState {
  players: Map<string, PlayerRecord>
  playersByNorm: Map<string, string>
  rounds: Map<number, RoundRecord>
  answers: Map<string, AnswerRecord>
  nextPlayerId: number
  nextRoundId: number
  nextAnswerId: number
}

const globalStore = globalThis as unknown as { __aptiquiz_store?: StoreState }

if (!globalStore.__aptiquiz_store) {
  globalStore.__aptiquiz_store = {
    players: new Map(),
    playersByNorm: new Map(),
    rounds: new Map(),
    answers: new Map(),
    nextPlayerId: 1,
    nextRoundId: 1,
    nextAnswerId: 1,
  }
}

const mem = globalStore.__aptiquiz_store!

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function docToPlayer(doc: any): PlayerRecord {
  return {
    id: String(doc._id),
    username: doc.username,
    username_normalized: doc.username_normalized,
    score: Number(doc.score) || 0,
    created_at: doc.created_at ? new Date(doc.created_at) : new Date(),
    last_seen_at: doc.last_seen_at ? new Date(doc.last_seen_at) : new Date(),
  }
}

function docToRound(doc: any): RoundRecord {
  return {
    id: String(doc._id),
    round_key: Number(doc.round_key),
    starts_at: new Date(doc.starts_at),
    ends_at: new Date(doc.ends_at),
    question: doc.question,
    options: Array.isArray(doc.options) ? doc.options : JSON.parse(doc.options),
    correct_index: Number(doc.correct_index),
    explanation: doc.explanation,
    category: doc.category,
    difficulty: doc.difficulty,
  }
}

// ---------------------------------------------------------------------------
// getPlayer
// ---------------------------------------------------------------------------

export async function getPlayer(id: string): Promise<PlayerRecord | null> {
  const client = await getMongoClient()
  if (client) {
    try {
      const { players } = db(client)
      let doc: any = null
      // Support both ObjectId and plain string ids
      try { doc = await players.findOne({ _id: new ObjectId(id) }) } catch {}
      if (!doc) doc = await players.findOne({ _id: id as any })
      return doc ? docToPlayer(doc) : null
    } catch (err) {
      console.error('[MongoDB] getPlayer error:', err)
    }
  }
  return mem.players.get(id) ?? null
}

// ---------------------------------------------------------------------------
// getPlayerByNorm
// ---------------------------------------------------------------------------

export async function getPlayerByNorm(norm: string): Promise<PlayerRecord | null> {
  const client = await getMongoClient()
  if (client) {
    try {
      const { players } = db(client)
      const doc = await players.findOne({ username_normalized: norm })
      return doc ? docToPlayer(doc) : null
    } catch (err) {
      console.error('[MongoDB] getPlayerByNorm error:', err)
    }
  }
  const existingId = mem.playersByNorm.get(norm)
  if (!existingId) return null
  return mem.players.get(existingId) ?? null
}

// ---------------------------------------------------------------------------
// upsertPlayer
// ---------------------------------------------------------------------------

export async function upsertPlayer(clean: string, norm: string): Promise<PlayerRecord> {
  const client = await getMongoClient()
  if (client) {
    try {
      const { players } = db(client)
      const now = new Date()
      const result = await players.findOneAndUpdate(
        { username_normalized: norm },
        {
          $setOnInsert: { username: clean, username_normalized: norm, score: 0, created_at: now },
          $set: { last_seen_at: now },
        },
        { upsert: true, returnDocument: 'after' }
      )
      return docToPlayer(result!)
    } catch (err) {
      console.error('[MongoDB] upsertPlayer error:', err)
    }
  }

  // In-memory fallback
  const existingId = mem.playersByNorm.get(norm)
  if (existingId && mem.players.has(existingId)) {
    const p = mem.players.get(existingId)!
    p.last_seen_at = new Date()
    p.username = clean
    return p
  }
  const newId = String(mem.nextPlayerId++)
  const newPlayer: PlayerRecord = {
    id: newId,
    username: clean,
    username_normalized: norm,
    score: 0,
    created_at: new Date(),
    last_seen_at: new Date(),
  }
  mem.players.set(newId, newPlayer)
  mem.playersByNorm.set(norm, newId)
  return newPlayer
}

// ---------------------------------------------------------------------------
// deletePlayer
// ---------------------------------------------------------------------------

export async function deletePlayer(id: string): Promise<boolean> {
  const client = await getMongoClient()
  if (client) {
    try {
      const { players, answers } = db(client)
      try {
        await players.deleteOne({ _id: new ObjectId(id) })
      } catch {}
      await players.deleteOne({ _id: id as any })
      await answers.deleteMany({ player_id: id })
      return true
    } catch (err) {
      console.error('[MongoDB] deletePlayer error:', err)
    }
  }

  // In-memory fallback
  const player = mem.players.get(id)
  if (player) {
    mem.playersByNorm.delete(player.username_normalized)
    mem.players.delete(id)
    for (const [key, ans] of mem.answers.entries()) {
      if (ans.player_id === id) {
        mem.answers.delete(key)
      }
    }
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// getLeaderboard
// ---------------------------------------------------------------------------

export async function getLeaderboard(): Promise<Array<{ username: string; score: number }>> {
  const client = await getMongoClient()
  if (client) {
    try {
      const { players } = db(client)
      const docs = await players
        .find({}, { projection: { username: 1, score: 1 } })
        .sort({ score: -1, created_at: 1 })
        .limit(10)
        .toArray()
      return docs.map((d) => ({ username: d.username, score: Number(d.score) || 0 }))
    } catch (err) {
      console.error('[MongoDB] getLeaderboard error:', err)
    }
  }

  const list = Array.from(mem.players.values())
  list.sort((a, b) => b.score - a.score || a.created_at.getTime() - b.created_at.getTime())
  return list.slice(0, 10).map((p) => ({ username: p.username, score: p.score }))
}

// ---------------------------------------------------------------------------
// getRoundByKey
// ---------------------------------------------------------------------------

export async function getRoundByKey(key: number): Promise<RoundRecord | null> {
  const client = await getMongoClient()
  if (client) {
    try {
      const { rounds } = db(client)
      const doc = await rounds.findOne({ round_key: key })
      return doc ? docToRound(doc) : null
    } catch (err) {
      console.error('[MongoDB] getRoundByKey error:', err)
    }
  }
  return mem.rounds.get(key) ?? null
}

// ---------------------------------------------------------------------------
// saveRound
// ---------------------------------------------------------------------------

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
  const client = await getMongoClient()
  if (client) {
    try {
      const { rounds } = db(client)
      const result = await rounds.findOneAndUpdate(
        { round_key: data.round_key },
        { $setOnInsert: { ...data } },
        { upsert: true, returnDocument: 'after' }
      )
      return docToRound(result!)
    } catch (err) {
      console.error('[MongoDB] saveRound error:', err)
    }
  }

  if (mem.rounds.has(data.round_key)) return mem.rounds.get(data.round_key)!
  const roundRecord: RoundRecord = { id: String(mem.nextRoundId++), ...data }
  mem.rounds.set(data.round_key, roundRecord)
  return roundRecord
}

// ---------------------------------------------------------------------------
// getPlayerAnswer
// ---------------------------------------------------------------------------

export async function getPlayerAnswer(
  playerId: string,
  roundId: string
): Promise<{ selected_index: number; is_correct: boolean } | null> {
  const client = await getMongoClient()
  if (client) {
    try {
      const { answers } = db(client)
      const doc = await answers.findOne({ player_id: playerId, round_id: roundId })
      if (doc) return { selected_index: Number(doc.selected_index), is_correct: Boolean(doc.is_correct) }
      return null
    } catch (err) {
      console.error('[MongoDB] getPlayerAnswer error:', err)
    }
  }

  const key = `${playerId}:${roundId}`
  const a = mem.answers.get(key)
  return a ? { selected_index: a.selected_index, is_correct: a.is_correct } : null
}

// ---------------------------------------------------------------------------
// submitAnswer
// ---------------------------------------------------------------------------

export async function submitAnswer(
  playerId: string,
  roundId: string,
  selectedIndex: number,
  isCorrect: boolean
): Promise<boolean> {
  const client = await getMongoClient()
  if (client) {
    try {
      const { answers, players } = db(client)

      // Insert answer — ignore if already answered (unique index on player_id + round_id)
      const existing = await answers.findOne({ player_id: playerId, round_id: roundId })
      if (existing) return false

      await answers.insertOne({
        player_id: playerId,
        round_id: roundId,
        selected_index: selectedIndex,
        is_correct: isCorrect,
        created_at: new Date(),
      })

      if (isCorrect) {
        // Increment score — try ObjectId first, then string id
        let updated = false
        try {
          const r = await players.updateOne(
            { _id: new ObjectId(playerId) },
            { $inc: { score: 1 }, $set: { last_seen_at: new Date() } }
          )
          updated = r.modifiedCount > 0
        } catch {}
        if (!updated) {
          await players.updateOne(
            { _id: playerId as any },
            { $inc: { score: 1 }, $set: { last_seen_at: new Date() } }
          )
        }
      }

      return true
    } catch (err) {
      console.error('[MongoDB] submitAnswer error:', err)
    }
  }

  // In-memory fallback
  const key = `${playerId}:${roundId}`
  if (mem.answers.has(key)) return false
  mem.answers.set(key, {
    id: String(mem.nextAnswerId++),
    player_id: playerId,
    round_id: roundId,
    selected_index: selectedIndex,
    is_correct: isCorrect,
    created_at: new Date(),
  })
  if (isCorrect) {
    const player = mem.players.get(String(playerId))
    if (player) { player.score += 1; player.last_seen_at = new Date() }
  }
  return true
}
