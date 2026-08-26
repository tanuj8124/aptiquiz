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
    question: 'A can complete a project in 12 days and B can complete it in 18 days. If they work together for 4 days, what fraction of the work remains unfinished?',
    options: ['1/3', '4/9', '5/9', '2/3'],
    correct: 1,
    explanation: 'Combined 1-day work = 1/12 + 1/18 = 5/36. In 4 days, work done = 4 × (5/36) = 5/9. Remaining work = 1 - 5/9 = 4/9.',
    category: 'Deloitte Quants',
    difficulty: 'Medium',
  },
  {
    question: 'A sum of money becomes ₹7,350 in 2 years and ₹8,575 in 3 years at simple interest. What is the principal amount?',
    options: ['₹4,900', '₹5,000', '₹5,100', '₹4,700'],
    correct: 0,
    explanation: 'Interest for 1 year = 8575 - 7350 = 1225. So interest for 2 years = 2450. Principal = 7350 - 2450 = ₹4,900.',
    category: 'Deloitte Quants',
    difficulty: 'Medium',
  },
  {
    question: 'The average of 5 consecutive odd numbers is 61. What is the largest number?',
    options: ['61', '63', '65', '67'],
    correct: 2,
    explanation: 'For 5 consecutive odd numbers, the average equals the middle (3rd) number, so middle = 61. Numbers are 57, 59, 61, 63, 65. Largest = 65.',
    category: 'Deloitte Quants',
    difficulty: 'Easy',
  },
  {
    question: 'A train 150 m long crosses a platform 250 m long in 20 seconds. What is the speed of the train in km/hr?',
    options: ['54 km/hr', '60 km/hr', '72 km/hr', '80 km/hr',],
    correct: 2,
    explanation: 'Total distance = 150 + 250 = 400 m. Speed = 400/20 = 20 m/s = 20 × 18/5 = 72 km/hr.',
    category: 'Deloitte Quants',
    difficulty: 'Easy',
  },
  {
    question: 'The ratio of the ages of A and B is 3:5. After 9 years, the ratio becomes 3:4. What is the present age of B?',
    options: ['15 years', '20 years', '25 years', '30 years'],
    correct: 0,
    explanation: 'Let ages be 3x and 5x. (3x+9)/(5x+9) = 3/4 → 4(3x+9) = 3(5x+9) → 12x+36 = 15x+27 → 9 = 3x → x = 3. B\'s present age = 5x = 15 years.',
    category: 'Deloitte Quants',
    difficulty: 'Hard',
  },
  {
    question: 'If the price of sugar increases by 25%, by what percentage should a family reduce its consumption to keep the expenditure unchanged?',
    options: ['15%', '20%', '25%', '30%'],
    correct: 1,
    explanation: 'Reduction % = (increase / (100 + increase)) × 100 = (25/125) × 100 = 20%.',
    category: 'Deloitte Quants',
    difficulty: 'Easy',
  },
  {
    question: 'A shopkeeper marks his goods 40% above cost price and allows a discount of 15%. What is his profit percentage?',
    options: ['16%', '18%', '19%', '21%'],
    correct: 2,
    explanation: 'Let CP = 100. Marked price = 140. Selling price = 140 × 0.85 = 119. Profit = 19%.',
    category: 'Deloitte Quants',
    difficulty: 'Medium',
  },
  {
    question: 'Two pipes A and B can fill a tank in 24 minutes and 32 minutes respectively. A third pipe C can empty it in 48 minutes. If all three pipes are opened together, how long will it take to fill the tank?',
    options: ['16 min', '18 min', '19.2 min', '20 min'],
    correct: 2,
    explanation: 'Rate = 1/24 + 1/32 - 1/48 = (4+3-2)/96 = 5/96. Time = 96/5 = 19.2 minutes.',
    category: 'Deloitte Quants',
    difficulty: 'Hard',
  },
  {
    question: 'The compound interest on ₹10,000 for 2 years at 10% per annum, compounded annually, is:',
    options: ['₹2,000', '₹2,100', '₹2,200', '₹2,500'],
    correct: 1,
    explanation: 'Amount = 10000 × (1.1)^2 = 12100. CI = 12100 - 10000 = ₹2,100.',
    category: 'Deloitte Quants',
    difficulty: 'Easy',
  },
  {
    question: 'A boat travels 30 km upstream in 6 hours and returns downstream in 3 hours. What is the speed of the boat in still water?',
    options: ['5 km/hr', '6 km/hr', '7.5 km/hr', '10 km/hr'],
    correct: 2,
    explanation: 'Upstream speed = 30/6 = 5 km/hr. Downstream speed = 30/3 = 10 km/hr. Speed in still water = (5+10)/2 = 7.5 km/hr.',
    category: 'Deloitte Quants',
    difficulty: 'Medium',
  },

  // ---------------- LOGICAL REASONING (10) ----------------
  {
    question: 'In a certain code, "TRAIN" is written as "USBJO". How is "PLANE" written in that code?',
    options: ['QMBOF', 'QNBOF', 'QMBPF', 'RMBOF'],
    correct: 0,
    explanation: 'Each letter is shifted forward by 1: P→Q, L→M, A→B, N→O, E→F, giving QMBOF.',
    category: 'Deloitte Logical Reasoning',
    difficulty: 'Easy',
  },
  {
    question: 'Look at this series: 2, 6, 18, 54, ... What number should come next?',
    options: ['108', '148', '162', '216'],
    correct: 2,
    explanation: 'Each term is multiplied by 3: 2×3=6, 6×3=18, 18×3=54, 54×3=162.',
    category: 'Deloitte Logical Reasoning',
    difficulty: 'Easy',
  },
  {
    question: 'Five friends P, Q, R, S, and T are sitting in a row facing north. Q is to the immediate right of P. R is to the immediate left of S. T is at the left end, and Q is in the middle (3rd position). Which of the following is definitely true?',
    options: ['T is adjacent to P', 'S is at the right end', 'R is in the middle', 'P is at the right end'],
    correct: 0,
    explanation: 'Q is in position 3, and P is immediately left of Q, so P is in position 2. T is fixed at the left end (position 1), which is adjacent to P (position 2). The remaining friends R and S (with R immediately left of S) occupy positions 4 and 5, so S is at the right end (position 5) as well — but only "T is adjacent to P" is guaranteed directly from the given clues without needing to place R and S, making it the safest definite conclusion.',
    category: 'Deloitte Logical Reasoning',
    difficulty: 'Hard',
  },
  {
    question: 'If "CAT" is coded as 3120 and "DOG" is coded as 4157, what is the code for "BAT"?',
    options: ['2120', '2130', '2140', '2110'],
    correct: 0,
    explanation: 'Each letter is coded by its position in the alphabet: B=2, A=1, T=20, giving 2120.',
    category: 'Deloitte Logical Reasoning',
    difficulty: 'Medium',
  },
  {
    question: 'Pointing to a photograph, a man says, "This person is the son of the only son of my grandfather." How is the person in the photograph related to the man?',
    options: ['Father', 'Brother', 'Uncle', 'Cousin'],
    correct: 1,
    explanation: 'The only son of the man\'s grandfather is the man\'s father. So the person in the photograph is the father\'s son, i.e., the man\'s brother.',
    category: 'Deloitte Logical Reasoning',
    difficulty: 'Medium',
  },
  {
    question: 'Find the odd one out: 8, 27, 64, 100, 125, 216',
    options: ['27', '100', '125', '216'],
    correct: 1,
    explanation: 'All numbers except 100 are perfect cubes (2³, 3³, 4³, 5³, 6³). 100 is not a perfect cube.',
    category: 'Deloitte Logical Reasoning',
    difficulty: 'Easy',
  },
  {
    question: 'In a certain language, "MONEY" is written as "NPOFZ". How is "TIME" written in that language?',
    options: ['UJNF', 'UJMF', 'UJNE', 'VJNF'],
    correct: 0,
    explanation: 'Each letter is shifted forward by 1: T→U, I→J, M→N, E→F, giving UJNF.',
    category: 'Deloitte Logical Reasoning',
    difficulty: 'Easy',
  },
  {
    question: 'Statements: All pens are pencils. Some pencils are erasers. Conclusions: I. Some pens are erasers. II. Some erasers are pens. Which conclusion(s) logically follow?',
    options: ['Only I follows', 'Only II follows', 'Neither follows', 'Both follow'],
    correct: 2,
    explanation: 'Since only "some" pencils are erasers, and we don\'t know if those pencils overlap with pens, neither conclusion can be definitely drawn.',
    category: 'Deloitte Logical Reasoning',
    difficulty: 'Hard',
  },
  {
    question: 'A is the brother of B. C is the mother of A. D is the brother of E. E is the daughter of B. How is D related to C?',
    options: ['Grandson', 'Son', 'Nephew', 'Grandnephew'],
    correct: 0,
    explanation: 'C is the mother of A, and A is the brother of B, so C is also B\'s mother. E is B\'s daughter, so C is E\'s grandmother. D is E\'s brother, so D is also C\'s grandson.',
    category: 'Deloitte Logical Reasoning',
    difficulty: 'Hard',
  },
  {
    question: 'Complete the series: A(1), D(4), I(9), P(16), Y(25), ? — where each letter\'s position number is shown in brackets.',
    options: ['30', '32', '34', '36'],
    correct: 3,
    explanation: 'The position numbers are perfect squares: 1², 2², 3², 4², 5² = 1, 4, 9, 16, 25. The next term is 6² = 36.',
    category: 'Deloitte Logical Reasoning',
    difficulty: 'Medium',
  },

  // ---------------- VERBAL ABILITY (5) ----------------
  {
    question: 'Choose the word that is most nearly OPPOSITE in meaning to "AUSTERE":',
    options: ['Strict', 'Lavish', 'Simple', 'Harsh'],
    correct: 1,
    explanation: '"Austere" means severe or plain in manner; "Lavish" (extravagant, luxurious) is its opposite.',
    category: 'Deloitte Verbal Ability',
    difficulty: 'Medium',
  },
  {
    question: 'Fill in the blank: Despite the heavy rainfall, the match was not _______ and continued as scheduled.',
    options: ['postponed', 'abandoned', 'canceled', 'delayed'],
    correct: 2,
    explanation: '"Canceled" fits best in context as it implies the match still went on despite conditions, unlike "postponed/delayed" which implies a later resumption.',
    category: 'Deloitte Verbal Ability',
    difficulty: 'Easy',
  },
  {
    question: 'Identify the correctly punctuated sentence:',
    options: [
      'She said, "I will be there by 5 pm."',
      'She said "I will be there by 5 pm".',
      'She said, I will be there by 5 pm.',
      'She said "I will be there by 5 pm."',
    ],
    correct: 0,
    explanation: 'Direct speech requires a comma before the quotation and the closing punctuation inside the quotation marks.',
    category: 'Deloitte Verbal Ability',
    difficulty: 'Easy',
  },
  {
    question: 'Choose the correctly spelled word:',
    options: ['Occassion', 'Ocasion', 'Occasion', 'Occasoin'],
    correct: 2,
    explanation: '"Occasion" is the correct spelling, with double "c" and single "s".',
    category: 'Deloitte Verbal Ability',
    difficulty: 'Easy',
  },
  {
    question: 'Read the passage and answer: "Automation is transforming industries at a rapid pace, raising concerns about job displacement even as it creates new categories of employment." What is the author\'s main point?',
    options: [
      'Automation only destroys jobs',
      'Automation has mixed effects on employment',
      'Automation is slowing down',
      'Automation has no impact on jobs',
    ],
    correct: 1,
    explanation: 'The passage highlights both job displacement and creation of new jobs, indicating a mixed impact.',
    category: 'Deloitte Verbal Ability',
    difficulty: 'Medium',
  },

  // ---------------- DATA INTERPRETATION (5) ----------------
  {
    question: 'A company\'s revenue grew from ₹80 lakh to ₹100 lakh in one year. What is the percentage growth in revenue?',
    options: ['20%', '25%', '22.5%', '18%'],
    correct: 1,
    explanation: 'Growth % = ((100-80)/80) × 100 = 25%.',
    category: 'Deloitte Data Interpretation',
    difficulty: 'Easy',
  },
  {
    question: 'In a survey of 500 employees, 60% preferred remote work, 25% preferred hybrid, and the rest preferred in-office. How many employees preferred in-office work?',
    options: ['50', '75', '100', '125'],
    correct: 1,
    explanation: 'In-office % = 100 - 60 - 25 = 15%. Number = 15% of 500 = 75.',
    category: 'Deloitte Data Interpretation',
    difficulty: 'Easy',
  },
  {
    question: 'A pie chart shows a company\'s expenses: Salaries 40%, Rent 20%, Marketing 15%, Utilities 10%, Others 15%. If total expenses are ₹50 lakh, how much is spent on Marketing and Utilities combined?',
    options: ['₹10 lakh', '₹12.5 lakh', '₹15 lakh', '₹17.5 lakh'],
    correct: 1,
    explanation: 'Marketing + Utilities = 15% + 10% = 25% of 50 lakh = ₹12.5 lakh.',
    category: 'Deloitte Data Interpretation',
    difficulty: 'Medium',
  },
  {
    question: 'The bar graph shows quarterly sales (in ₹lakh): Q1=40, Q2=55, Q3=45, Q4=60. What is the average quarterly sales for the year?',
    options: ['45 lakh', '48 lakh', '50 lakh', '52 lakh'],
    correct: 2,
    explanation: 'Average = (40+55+45+60)/4 = 200/4 = ₹50 lakh.',
    category: 'Deloitte Data Interpretation',
    difficulty: 'Easy',
  },
  {
    question: 'A line graph shows a company\'s profit (in ₹crore): 2019: 10, 2020: 8, 2021: 12, 2022: 15, 2023: 18. What is the percentage increase in profit from 2020 to 2023?',
    options: ['100%', '112.5%', '125%', '150%'],
    correct: 2,
    explanation: 'Increase % = ((18-8)/8) × 100 = (10/8) × 100 = 125%.',
    category: 'Deloitte Data Interpretation',
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
