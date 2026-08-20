// Rebuilds data/tickets.json from Re:amaze: every conversation whose newest
// public message came from the customer, i.e. the ball is with us.
//
// Credentials come from the environment so they are never committed:
//   REAMAZE_EMAIL / REAMAZE_TOKEN   (optional: REAMAZE_BRAND, BOARD_URL)
//
// Tickets already carrying a board status are KEPT even when they drop out of
// the fresh queue, so nothing you have worked on ever silently disappears.
import fs from 'fs'
import path from 'path'

const EMAIL = process.env.REAMAZE_EMAIL || ''
const TOKEN = process.env.REAMAZE_TOKEN || ''
const BRAND = process.env.REAMAZE_BRAND || 'serentia-shop'
const BOARD = process.env.BOARD_URL || ''
if (!EMAIL || !TOKEN) { console.error('FATAL: set REAMAZE_EMAIL and REAMAZE_TOKEN'); process.exit(2) }

const AUTH = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function get(url, headers = { Accept: 'application/json', Authorization: AUTH }) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(url, { headers })
      if (r.ok) return r.json()
      if ([429, 502, 503, 504].includes(r.status)) { await sleep(2500 * (a + 1)); continue }
      return null
    } catch { await sleep(2000 * (a + 1)) }
  }
  return null
}

// --- 1. every conversation. The `filter` query param is broken upstream and
// returns the whole set whatever you pass, so we filter by status ourselves.
const first = await get(`https://${BRAND}.reamaze.io/api/v1/conversations?page=1`)
if (!first) { console.error('FATAL: cannot reach Re:amaze'); process.exit(2) }
const convs = [...first.conversations]
const pages = []
for (let p = 2; p <= first.page_count; p++) pages.push(p)
for (let i = 0; i < pages.length; i += 8) {
  const batch = await Promise.all(pages.slice(i, i + 8).map((p) =>
    get(`https://${BRAND}.reamaze.io/api/v1/conversations?page=${p}`)))
  for (const j of batch) if (j?.conversations) convs.push(...j.conversations)
}

// --- 2. drop noise. Status 2/6/8 are done, 3/9 spam, 4 archived.
const NOISE = /trustpilot|facebookmail|out of office|automatic reply|automatische antwort|réponse automatique|risposta automatica|automatisch antwoord|răspuns automat/i
const BOT = /noreply|no-reply|zapier|workspace-noreply|@google\.com|@openai|chatgpt|postmaster|tickets\.helpdesk/i
const OURS = /support@serentia-shop\.com/i

const GROUPS = [
  ['cancel',   /cancel|unsubscrib|stop (the )?(order|subscription)|abbonamento|annullamento/i],
  ['refund',   /refund|charge|chargeback|dispute|money back|reimburs|payment/i],
  ['delivery', /deliver|shipping|track|not received|never received|lost|parcel|package|arriv/i],
  ['shade',    /shade|colour|color|wrong (item|product|order)|exchange|return|too light|too dark/i],
  ['question', /how (do|can|long)|question|advice|help|which|recommend/i],
]
const classify = (subject, body) => {
  const s = `${subject || ''} ${body || ''}`
  for (const [key, re] of GROUPS) if (re.test(s)) return key
  return 'other'
}

// Awaiting a reply means the customer spoke last: Re:amaze status 0 (Open),
// 5 (On Hold) or 7 (AI assigned). Status 1 is "Responded" - we already answered,
// so it does NOT belong in the queue.
const AWAITING = new Set([0, 5, 7])
let spamSkipped = 0, doneSkipped = 0
const fresh = []
for (const c of convs) {
  if ([3, 9, 4].includes(c.status)) { spamSkipped++; continue }
  if (!AWAITING.has(c.status)) { doneSkipped++; continue }
  const author = `${c.author?.email || ''} ${c.author?.name || ''}`
  if (NOISE.test(`${c.subject || ''} ${author}`) || BOT.test(author) || OURS.test(author)) { spamSkipped++; continue }
  const lcm = c.last_customer_message
  if (!lcm?.created_at) continue
  const body = (lcm.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  fresh.push({
    g: classify(c.subject, body),
    c: c.author?.name || c.followers?.[0]?.name || c.followers?.[0]?.email || '(unknown)',
    s: c.subject || '(no subject)',
    l: c.slug,
    d: c.created_at,
    ld: lcm.created_at,
  })
}

// --- 3. keep anything already carrying a status, so worked tickets persist.
let statuses = {}
if (BOARD) {
  const st = await get(`${BOARD.replace(/\/$/, '')}/api/status`,
    { Accept: 'application/json', Authorization: AUTH, 'x-reamaze-brand': BRAND })
  if (st?.statuses) statuses = st.statuses
  else console.error('WARN: could not read board statuses - previously worked tickets may drop out')
}

const file = path.join(process.cwd(), 'data', 'tickets.json')
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
const seen = new Set(fresh.map((t) => t.l))
const kept = prev.filter((t) => !seen.has(t.l) && statuses[t.l])

const out = [...fresh, ...kept]
fs.writeFileSync(file, JSON.stringify(out))

const missing = prev.filter((t) => statuses[t.l] && !out.some((x) => x.l === t.l))
console.log(JSON.stringify({
  total: out.length, freshQueue: fresh.length, kept: kept.length,
  brandNew: fresh.filter((t) => !prev.some((p) => p.l === t.l)).length,
  spamSkipped, doneSkipped,
  newSubjects: fresh.filter((t) => !prev.some((p) => p.l === t.l)).slice(0, 12).map((t) => `${t.c} | ${t.s.slice(0, 46)}`),
}, null, 1))
if (missing.length) console.error(`WARN: ${missing.length} statused tickets are no longer in the file`)
