import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import {
  getPlayer,
  upsertPlayer,
  getLeaderboard,
  getRoundByKey,
  saveRound,
  getPlayerAnswer,
  submitAnswer,
} from '@/lib/db'
import { createHash } from 'crypto'
import { generateText } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

const COOKIE = 'aptitude_player'
const SECRET_KEY = process.env.AUTH_SECRET || process.env.DATABASE_URL || 'aptiquiz_session_secret_2026'

// Authentic Deloitte placement pattern question bank
const deloitteFallbackBank = [
  {
    question: 'A train running at 72 km/h crosses a platform of length 250 m in 20 seconds. What is the length of the train?',
    options: ['120 m', '150 m', '180 m', '200 m'],
    correct: 1,
    explanation: 'Speed = 72 × (5/18) = 20 m/s. Total distance covered = 20 m/s × 20 s = 400 m. Train length = 400 m - 250 m = 150 m.',
    category: 'Deloitte Quants',
    difficulty: 'Medium',
  },
  {
    question: 'Statements: All managers are leaders. Some leaders are innovators. Conclusions: I. Some managers are innovators. II. Some leaders are managers.',
    options: ['Only conclusion I follows', 'Only conclusion II follows', 'Both conclusions I and II follow', 'Neither conclusion follows'],
    correct: 1,
    explanation: 'Since all managers are leaders, the subset of leaders who are managers validates conclusion II. No direct relation is established between managers and innovators.',
    category: 'Deloitte Logical',
    difficulty: 'Medium',
  },
  {
    question: 'A can complete a project in 12 days and B can complete it in 18 days. If they work together for 4 days, what fraction of the work remains unfinished?',
    options: ['1/3', '4/9', '5/9', '2/3'],
    correct: 1,
    explanation: 'Combined 1-day work = 1/12 + 1/18 = 5/36. In 4 days, work done = 4 × (5/36) = 5/9. Remaining work = 1 - 5/9 = 4/9.',
    category: 'Deloitte Quants',
    difficulty: 'Medium',
  },
  {
    question: 'Pointing to a photograph, Rohit said, "She is the daughter of my grandfather\'s only son." How is the woman in the photograph related to Rohit?',
    options: ['Mother', 'Sister', 'Cousin', 'Niece'],
    correct: 1,
    explanation: "Rohit's grandfather's only son is Rohit's father. The daughter of Rohit's father is Rohit's sister.",
    category: 'Deloitte Logical',
    difficulty: 'Easy',
  },
  {
    question: 'Identify the segment with a grammatical error: "Neither the team lead (A) / nor the senior developers (B) / was available for (C) / the client demonstration (D)."',
    options: ['Segment A', 'Segment B', 'Segment C', 'Segment D'],
    correct: 2,
    explanation: 'When subjects are connected by "neither... nor", the verb agrees with the closer subject ("senior developers", plural). It should be "were available".',
    category: 'Deloitte Verbal',
    difficulty: 'Medium',
  },
  {
    question: 'In how many different ways can the letters of the word "DELOITTE" be arranged?',
    options: ['5,040', '10,080', '20,160', '40,320'],
    correct: 1,
    explanation: 'DELOITTE has 8 letters where E appears 2 times and T appears 2 times. Total permutations = 8! / (2! × 2!) = 40,320 / 4 = 10,080.',
    category: 'Deloitte Quants',
    difficulty: 'Medium',
  },
  {
    question: 'Five executives (P, Q, R, S, T) sit in a boardroom row facing North. S is between T and Q. Q is to the immediate left of R. P is to the immediate left of T. Who sits in the middle position?',
    options: ['P', 'T', 'S', 'Q'],
    correct: 2,
    explanation: 'From left to right, the seating sequence is P - T - S - Q - R. Therefore, S is seated in the exact middle.',
    category: 'Deloitte Logical',
    difficulty: 'Medium',
  },
  {
    question: 'A merchant buys goods at 6 items for ₹10 and sells them at 4 items for ₹8. What is the profit percentage?',
    options: ['15%', '20%', '25%', '30%'],
    correct: 1,
    explanation: 'Cost price per item = 10/6 = ₹5/3. Selling price per item = 8/4 = ₹2. Profit per item = 2 - 5/3 = ₹1/3. Profit % = ((1/3) / (5/3)) × 100 = 20%.',
    category: 'Deloitte Quants',
    difficulty: 'Medium',
  },
  {
    question: 'Select the word most nearly OPPOSITE in meaning to "PRAGMATIC":',
    options: ['Realistic', 'Idealistic', 'Rational', 'Prudent'],
    correct: 1,
    explanation: '"Pragmatic" means guided by practical considerations. "Idealistic" refers to pursuing noble principles rather than practicality, making it the antonym.',
    category: 'Deloitte Verbal',
    difficulty: 'Easy',
  },
  {
    question: 'A sum of money doubles itself at simple interest in 8 years. In how many years will it become 4 times the principal at the same rate of interest?',
    options: ['16 years', '20 years', '24 years', '32 years'],
    correct: 2,
    explanation: 'At SI, interest in 8 years = P (Rate = 100/8 = 12.5%). To become 4P, interest needed = 3P. Time required = 3 × 8 = 24 years.',
    category: 'Deloitte Quants',
    difficulty: 'Medium',
  },
  {
    question: 'If "DELHI" is coded as "CCIDD" by shifting letters back by 1, 2, 3, 4, and 5 positions respectively, how is "BOMBAY" coded?',
    options: ['AMJXVS', 'ALJXVS', 'AMKXVS', 'BMJXVT'],
    correct: 0,
    explanation: 'B(-1)=A, O(-2)=M, M(-3)=J, B(-4)=X, A(-5)=V, Y(-6)=S. The resulting code is AMJXVS.',
    category: 'Deloitte Logical',
    difficulty: 'Hard',
  },
  {
    question: 'Choose the most appropriate preposition: "The audit committee was satisfied _____ the explanations provided by the finance division."',
    options: ['with', 'at', 'by', 'for'],
    correct: 0,
    explanation: 'The adjective "satisfied" is conventionally paired with the preposition "with" when referring to content or explanations.',
    category: 'Deloitte Verbal',
    difficulty: 'Easy',
  },
]

function roundKey() {
  return Math.floor(Date.now() / 60000)
}

function sign(value: string) {
  return createHash('sha256').update(value + SECRET_KEY).digest('hex')
}

async function player() {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE)?.value
    if (!token) return null
    const [id, sig] = token.split('.')
    if (!id || sig !== sign(id)) return null
    const p = await getPlayer(id)
    return p ? { id: p.id, username: p.username, score: p.score } : null
  } catch {
    return null
  }
}

async function makeQuestion(key: number) {
  const base = deloitteFallbackBank[Math.abs(key) % deloitteFallbackBank.length]
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY

  if (!apiKey) return base

  try {
    const google = createGoogleGenerativeAI({ apiKey })
    const modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash'
    const { text } = await generateText({
      model: google(modelName),
      prompt: `You are an expert assessment designer creating aptitude test questions specifically tailored for the Deloitte Campus Placement & National Level Assessment (NLA / Deloitte Placement Rounds).

Generate one original, realistic question for assessment round #${key}.

Alternate across these core Deloitte testing pillars based on round number:
1. "Deloitte Quants": Time & Work, Time Speed Distance, Profit & Loss, Percentages, Simple & Compound Interest, Mixtures & Alligations, Permutations & Combinations, Probability, Number Properties.
2. "Deloitte Logical": Syllogisms, Blood Relations, Coding-Decoding, Linear/Circular Seating Arrangements, Direction Sense, Data Sufficiency, Statement & Assumptions.
3. "Deloitte Verbal": Sentence Correction, Spotting Errors, Vocabulary in Context (Synonyms/Antonyms), Para Jumbles, Prepositions, Subject-Verb Agreement.

Rules:
- Difficulty should match actual Deloitte hiring rounds (mostly Medium, occasionally Hard).
- Provide 4 distinct, plausible options.
- Give a concise, step-by-step mathematical/logical explanation.
- Return ONLY valid JSON with:
  - "question": string
  - "options": array of exactly 4 strings
  - "correct": integer 0-3
  - "explanation": string
  - "category": "Deloitte Quants" | "Deloitte Logical" | "Deloitte Verbal"
  - "difficulty": "Easy" | "Medium" | "Hard"
`,
      temperature: 0.85,
    })

    const cleanedText = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const parsed = JSON.parse(cleanedText)
    if (
      typeof parsed.question === 'string' &&
      Array.isArray(parsed.options) &&
      parsed.options.length === 4 &&
      Number.isInteger(parsed.correct)
    ) {
      return parsed
    }
  } catch (err) {
    console.error('[Quiz AI] Error generating question with Google Gemini:', err)
    /* fallback keeps rounds available */
  }
  return base
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Allow-Credentials': 'true',
    },
  })
}

export async function GET() {
  const p = await player()
  if (!p) {
    return NextResponse.json({ signedIn: false })
  }

  const key = roundKey()
  const start = new Date(key * 60000)
  const end = new Date((key + 1) * 60000)

  let r = await getRoundByKey(key)
  if (!r) {
    const q = await makeQuestion(key)
    r = await saveRound({
      round_key: key,
      starts_at: start,
      ends_at: end,
      question: q.question,
      options: q.options,
      correct_index: q.correct,
      explanation: q.explanation || '',
      category: q.category || 'Deloitte Quants',
      difficulty: q.difficulty || 'Medium',
    })
  }

  const answer = await getPlayerAnswer(p.id, r.id)
  const leaderboard = await getLeaderboard()

  return NextResponse.json({
    signedIn: true,
    player: p,
    round: {
      id: r.id,
      round_key: r.round_key,
      question: r.question,
      options: r.options,
      explanation: r.explanation,
      category: r.category,
      difficulty: r.difficulty,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      answered: !!answer,
      result: answer ?? null,
    },
    leaderboard,
    now: Date.now(),
  })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { username, answer } = body

    // Username entry / Sign in step
    if (username !== undefined) {
      const clean = String(username).trim().replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 20)
      if (clean.length < 2) {
        return NextResponse.json({ error: 'Use at least 2 characters' }, { status: 400 })
      }
      const norm = clean.toLowerCase()
      const pl = await upsertPlayer(clean, norm)
      const token = pl.id + '.' + sign(pl.id)
      const res = NextResponse.json({ ok: true, player: { id: pl.id, username: pl.username, score: pl.score } })
      res.cookies.set(COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
      })
      return res
    }

    const p = await player()
    if (!p) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
    }

    const key = roundKey()
    const r = await getRoundByKey(key)
    if (!r || Date.now() >= new Date(r.ends_at).getTime()) {
      return NextResponse.json({ error: 'Round is locked' }, { status: 400 })
    }

    const idx = Number(answer)
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) {
      return NextResponse.json({ error: 'Invalid answer' }, { status: 400 })
    }

    const correct = idx === r.correct_index
    await submitAnswer(p.id, r.id, idx, correct)

    return NextResponse.json({ ok: true, correct })
  } catch (err: any) {
    console.error('Error in POST /api/quiz:', err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(COOKIE)
  return res
}
