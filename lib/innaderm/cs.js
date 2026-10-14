import { q } from '../db'
import { ensureInnaderm, cacheGet, cacheSet } from './db'
import { sha256 } from './auth'

// Customer service metrics for Innaderm. Support runs on Gmail, not Re:amaze,
// so a Google Apps Script inside the support mailbox (scripts/innaderm-gmail-
// sync.gs) posts thread metadata to /api/innaderm/cs/ingest every 15 minutes.
// Stored per thread: subject, a short excerpt of the customer's first message
// (for categorising), a hash + masked form of the customer address, and the
// time, direction and replying agent of each message. No full bodies.
//
// Calvin's ask (12 Oct call): percentage of tickets by type, ageing buckets,
// average response time (to see how each agent is doing), spikes that look
// abnormal, and which ticket types are worth automating. Dispute rate is
// 0.9% with a hold at 1%.

let ready
export function ensureCs() {
  if (ready) return ready
  ready = (async () => {
    await ensureInnaderm()
    await q(`CREATE TABLE IF NOT EXISTS inn_cs_threads (
      id TEXT PRIMARY KEY,
      mailbox TEXT,
      subject TEXT,
      excerpt TEXT,
      customer_hash TEXT,
      customer_masked TEXT,
      category TEXT NOT NULL,
      flags TEXT[] NOT NULL DEFAULT '{}',
      first_in_at TIMESTAMPTZ NOT NULL,
      first_reply_at TIMESTAMPTZ,
      first_reply_agent TEXT,
      last_in_at TIMESTAMPTZ,
      last_out_at TIMESTAMPTZ,
      last_from TEXT NOT NULL,
      msgs_in INTEGER NOT NULL DEFAULT 0,
      msgs_out INTEGER NOT NULL DEFAULT 0,
      in_inbox BOOLEAN NOT NULL DEFAULT true,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    await q(`CREATE INDEX IF NOT EXISTS idx_inn_cs_threads_first ON inn_cs_threads (first_in_at)`)
    await q(`CREATE INDEX IF NOT EXISTS idx_inn_cs_threads_open ON inn_cs_threads (last_from, in_inbox)`)
    await q(`CREATE TABLE IF NOT EXISTS inn_cs_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL,
      dir TEXT NOT NULL,
      agent TEXT
    )`)
    await q(`CREATE INDEX IF NOT EXISTS idx_inn_cs_messages_thread ON inn_cs_messages (thread_id, at)`)
    await q(`CREATE INDEX IF NOT EXISTS idx_inn_cs_messages_at ON inn_cs_messages (at)`)
  })()
  ready.catch(() => { ready = null })
  return ready
}

// ---------- categories ----------
// First match wins, so escalation types come before the everyday ones.
// `auto` is how far the type can be automated; `play` is the suggested move.
export const CATEGORIES = [
  { name: 'Chargeback / dispute threat', auto: 'never', play: 'Escalate to the Founder the same day. Never automate.', re: /charge ?back|dispute|my bank|paypal (claim|case)|\bbbb\b|better business|fraud|scam|lawyer|attorney|legal action|report you/ },
  { name: 'Adverse reaction', auto: 'never', play: 'Escalate the same day with photos. Personal reply only.', re: /rash|allerg|reaction|hives|swelling|nause|vomit|stomach (pain|ache|upset)|diarrh|sick after|made me sick|side effect|itch(y|ing) (all|more|worse)|breakout|broke out|bloat/ },
  { name: 'Subscription', auto: 'high', play: 'Auto-reply with the Loop self-serve link (pause, skip, swap, cancel) and the retention offer.', re: /subscri|recurring|auto.?ship|renewal|charged again|another (order|charge|shipment)|didn.?t (order|sign up)|never (ordered|signed)|pause|skip (my|next|the)/ },
  { name: 'Cancel order', auto: 'medium', play: 'Auto-check fulfilment status: unfulfilled = cancel form, shipped = explain and offer return path.', re: /cancel/ },
  { name: 'Refund / return', auto: 'medium', play: 'Macro with the 90-day guarantee terms; refund itself stays with a person.', re: /refund|return|money back|guarantee|reimburs/ },
  { name: 'Damaged / wrong / missing item', auto: 'medium', play: 'Auto-reply asking for photos and order number, then a person decides.', re: /damag|broken|leak|wrong (item|product|order)|missing (item|bottle|capsule)|empty (box|bottle)|opened/ },
  { name: 'Marked delivered, not received', auto: 'medium', play: 'Macro asking neighbours/mailbox check, then request proof of delivery from the carrier.', re: /(says|shows|marked).{0,20}delivered|delivered.{0,30}(not|never|didn.?t) (receiv|get|arriv)|stolen|lost (package|parcel|order)/ },
  { name: 'Address change', auto: 'medium', play: 'Form link if unfulfilled. Time-critical: answer within 30 minutes.', re: /(change|update|wrong|correct|fix).{0,25}address|address.{0,20}(change|wrong|incorrect)|moved/ },
  { name: 'Where is my order', auto: 'high', play: 'Auto-reply with live tracking from Shopify and the delivery window. Biggest automation win if high.', re: /where.{0,15}(is|are) (my|the) (order|package|parcel)|track|tracking|not (arrived|received|here)|hasn.?t (arrived|come)|still waiting|shipping|shipped|delivery|deliver|when will|eta|status of (my )?order|order status/ },
  { name: 'Billing / payment', auto: 'medium', play: 'Macro explaining the charge with the order lookup; double charges go to a person.', re: /charged|charge|double|payment|card|invoice|receipt|price|overcharg|billing|bill/ },
  { name: 'Not working / results', auto: 'low', play: 'Retention reply: consistency and the 90-day timeline, then the guarantee. Personal tone.', re: /not working|isn.?t working|doesn.?t work|didn.?t work|no (results|difference|change|improvement)|worse|still (have|got) (dandruff|flakes|itch)/ },
  { name: 'Product question', auto: 'high', play: 'FAQ auto-reply: how to take it, ingredients, timeline to results, safe with other meds (with a disclaimer).', re: /how (do|should|to|many|long)|dosage|dose|take (it|them|the)|capsule|ingredient|pregnan|breastfeed|medication|safe (to|for|with)|vegan|gluten|results|work for|kids|children|shampoo/ },
  { name: 'Discount / offer', auto: 'high', play: 'Macro with the current offer and how codes work.', re: /discount|coupon|promo|code|offer|deal|sale|bundle|buy (one|two|2|3)/ },
]
export const OTHER = { name: 'Other', auto: 'low', play: 'Read a sample weekly; new patterns become a category.' }

export function classify(subject, excerpt) {
  const text = `${subject || ''} \n ${excerpt || ''}`.toLowerCase()
  for (const c of CATEGORIES) if (c.re.test(text)) return c.name
  return OTHER.name
}

const FLAG_RULES = [
  ['chargeback', /charge ?back|dispute|my bank|paypal (claim|case)/],
  ['legal', /\bbbb\b|better business|lawyer|attorney|legal action|sue\b|report you|ftc|attorney general/],
  ['reaction', /rash|allerg|reaction|hives|swelling|nause|vomit|made me sick|side effect/],
  ['angry', /scam|fraud|ridiculous|unacceptable|worst|terrible|disgust|never again|rip.?off/],
]
export function flagsFor(subject, excerpt) {
  const text = `${subject || ''} \n ${excerpt || ''}`.toLowerCase()
  return FLAG_RULES.filter(([, re]) => re.test(text)).map(([k]) => k)
}

function maskEmail(e) {
  const m = String(e || '').toLowerCase().match(/^([^@\s]+)@([^@\s]+)$/)
  if (!m) return null
  return `${m[1][0]}${'*'.repeat(Math.min(5, Math.max(2, m[1].length - 1)))}@${m[2]}`
}

const iso = (v) => { const d = new Date(v); return isNaN(d) ? null : d }

// ---------- ingest ----------
// Body: { mailbox, threads: [{ id, subject, inInbox, excerpt, customer,
//         messages: [{ id, at, dir: 'in'|'out', agent }] }], cursor? }
export async function ingest(body) {
  await ensureCs()
  const mailbox = String(body?.mailbox || '').slice(0, 120).toLowerCase() || null
  const threads = Array.isArray(body?.threads) ? body.threads.slice(0, 200) : []
  let saved = 0, skipped = 0
  for (const t of threads) {
    const id = String(t?.id || '').slice(0, 64)
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) { skipped++; continue }
    const msgs = (Array.isArray(t.messages) ? t.messages : [])
      .map((m) => ({ id: String(m?.id || '').slice(0, 64), at: iso(m?.at), dir: m?.dir === 'out' ? 'out' : m?.dir === 'in' ? 'in' : null, agent: m?.agent ? String(m.agent).slice(0, 40) : null }))
      .filter((m) => /^[A-Za-z0-9_-]{6,64}$/.test(m.id) && m.at && m.dir)
      .sort((a, b) => a.at - b.at)
    const ins = msgs.filter((m) => m.dir === 'in')
    // Threads the team started (outreach) or with no customer message are not tickets.
    if (!ins.length) { skipped++; continue }
    const firstIn = ins[0].at
    const firstReply = msgs.find((m) => m.dir === 'out' && m.at > firstIn) || null
    const outs = msgs.filter((m) => m.dir === 'out')
    const last = msgs[msgs.length - 1]
    const subject = String(t.subject || '').slice(0, 300)
    const excerpt = String(t.excerpt || '').replace(/\s+/g, ' ').slice(0, 600)
    const customer = String(t.customer || '').trim().toLowerCase()
    await q(
      `INSERT INTO inn_cs_threads (id, mailbox, subject, excerpt, customer_hash, customer_masked, category, flags,
         first_in_at, first_reply_at, first_reply_agent, last_in_at, last_out_at, last_from, msgs_in, msgs_out, in_inbox, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
       ON CONFLICT (id) DO UPDATE SET mailbox = EXCLUDED.mailbox, subject = EXCLUDED.subject, excerpt = EXCLUDED.excerpt,
         customer_hash = EXCLUDED.customer_hash, customer_masked = EXCLUDED.customer_masked, category = EXCLUDED.category,
         flags = EXCLUDED.flags, first_in_at = EXCLUDED.first_in_at, first_reply_at = EXCLUDED.first_reply_at,
         first_reply_agent = EXCLUDED.first_reply_agent, last_in_at = EXCLUDED.last_in_at, last_out_at = EXCLUDED.last_out_at,
         last_from = EXCLUDED.last_from, msgs_in = EXCLUDED.msgs_in, msgs_out = EXCLUDED.msgs_out, in_inbox = EXCLUDED.in_inbox, synced_at = now()`,
      [id, mailbox, subject, excerpt, customer ? sha256(customer) : null, maskEmail(customer), classify(subject, excerpt), flagsFor(subject, excerpt),
        firstIn, firstReply?.at || null, firstReply?.agent || null, ins[ins.length - 1].at, outs.length ? outs[outs.length - 1].at : null,
        last.dir, ins.length, outs.length, t.inInbox !== false],
    )
    for (const m of msgs) {
      await q(
        `INSERT INTO inn_cs_messages (id, thread_id, at, dir, agent) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET at = EXCLUDED.at, dir = EXCLUDED.dir, agent = EXCLUDED.agent`,
        [m.id, id, m.at, m.dir, m.agent],
      )
    }
    saved++
  }
  const state = { lastIngestAt: new Date().toISOString(), mailbox, lastBatch: { saved, skipped } }
  if (body?.backfillDone) state.backfillDone = true
  const prev = (await cacheGet('cs_ingest_state', 1e12))?.value || {}
  await cacheSet('cs_ingest_state', { ...prev, ...state })
  return { saved, skipped }
}

// ---------- metrics ----------
const H = 3600e3
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const AGE_BUCKETS = [['0-24 hours', 24], ['1-7 days', 168], ['7-14 days', 336], ['14-90 days', 2160], ['90+ days', Infinity]]
const FRT_BUCKETS = [['Under 1 h', 1], ['1-6 h', 6], ['6-24 h', 24], ['24-48 h', 48], ['48 h +', Infinity]]
const dayKey = (d) => new Date(d).toISOString().slice(0, 10)

function gmailLink(mailbox, id) {
  return `https://mail.google.com/mail/u/0/${mailbox ? `?authuser=${encodeURIComponent(mailbox)}` : ''}#all/${id}`
}

// Hour of day in the team's time zone (staffing view).
function hourIn(d, tz) {
  try { return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(d)) % 24 } catch { return new Date(d).getUTCHours() }
}

export async function csMetrics({ days, settings = {} }) {
  await ensureCs()
  const now = Date.now()
  const since = now - days * 86400e3
  const priorSince = now - 2 * days * 86400e3
  const tz = settings.cs_timezone || 'Africa/Johannesburg'
  const target = Number(settings.cs_response_target_hours || 24)

  const syncState = (await cacheGet('cs_ingest_state', 1e12))?.value || null
  const total = Number((await q('SELECT COUNT(*)::int AS n FROM inn_cs_threads'))[0].n)
  if (!total) return { connected: false, sync: syncState, days }

  const threads = await q(
    `SELECT id, mailbox, subject, customer_hash, customer_masked, category, flags, first_in_at, first_reply_at, first_reply_agent,
            last_in_at, last_out_at, last_from, msgs_in, msgs_out, in_inbox
     FROM inn_cs_threads WHERE first_in_at >= $1`, [new Date(priorSince)])
  const cur = threads.filter((t) => new Date(t.first_in_at).getTime() >= since)
  const prior = threads.filter((t) => new Date(t.first_in_at).getTime() < since)

  const msgs = await q(
    `SELECT thread_id, at, dir, agent FROM inn_cs_messages WHERE at >= $1 ORDER BY thread_id, at`,
    [new Date(priorSince - 14 * 86400e3)])

  // Every customer turn (first unanswered inbound message) paired with the
  // next team reply: "average response time" across the whole conversation,
  // not only the first answer.
  const turns = []
  const byThread = new Map()
  for (const m of msgs) {
    if (!byThread.has(m.thread_id)) byThread.set(m.thread_id, [])
    byThread.get(m.thread_id).push(m)
  }
  for (const list of byThread.values()) {
    let waitingSince = null
    for (const m of list) {
      const t = new Date(m.at).getTime()
      if (m.dir === 'in') { if (waitingSince == null) waitingSince = t }
      else if (waitingSince != null) { turns.push({ at: waitingSince, hrs: (t - waitingSince) / H, agent: m.agent || null }); waitingSince = null }
    }
  }
  const turnsCur = turns.filter((x) => x.at >= since)
  const turnsPrior = turns.filter((x) => x.at >= priorSince && x.at < since)

  const frt = (list) => list.filter((t) => t.first_reply_at).map((t) => (new Date(t.first_reply_at) - new Date(t.first_in_at)) / H)
  const frtCur = frt(cur), frtPrior = frt(prior)

  // Within-target rate: of tickets old enough to have been judged (answered,
  // or unanswered for longer than the target), how many got a first reply in time.
  function withinTarget(list) {
    let judged = 0, ok = 0
    for (const t of list) {
      const start = new Date(t.first_in_at).getTime()
      if (t.first_reply_at) { judged++; if ((new Date(t.first_reply_at) - start) / H <= target) ok++ }
      else if ((now - start) / H > target) judged++
    }
    return judged ? { pct: (ok / judged) * 100, ok, judged } : { pct: null, ok, judged }
  }

  // First contact resolution proxy: answered once and the customer did not write again.
  function fcr(list) {
    const answered = list.filter((t) => t.first_reply_at)
    if (!answered.length) return null
    let one = 0
    for (const t of answered) {
      const after = (byThread.get(t.id) || []).filter((m) => m.dir === 'in' && new Date(m.at) > new Date(t.first_reply_at)).length
      if (!after) one++
    }
    return (one / answered.length) * 100
  }

  // Daily series
  const series = []
  for (let i = days - 1; i >= 0; i--) series.push({ day: dayKey(now - i * 86400e3), tickets: 0, replies: 0, customerMsgs: 0 })
  const idx = new Map(series.map((r, i) => [r.day, i]))
  for (const t of cur) { const i = idx.get(dayKey(t.first_in_at)); if (i != null) series[i].tickets++ }
  for (const m of msgs) {
    const t = new Date(m.at).getTime(); if (t < since) continue
    const i = idx.get(dayKey(m.at)); if (i == null) continue
    if (m.dir === 'out') series[i].replies++; else series[i].customerMsgs++
  }
  const priorDaily = []
  for (let i = 2 * days - 1; i >= days; i--) {
    const day = dayKey(now - i * 86400e3)
    priorDaily.push(prior.filter((t) => dayKey(t.first_in_at) === day).length)
  }
  // Abnormal day: more than mean + 2 SD of the prior period (and at least 5).
  const pm = mean(priorDaily) || 0
  const psd = Math.sqrt(mean(priorDaily.map((v) => (v - pm) ** 2)) || 0)
  const spikeDays = series.filter((r) => priorDaily.length >= 7 && r.tickets >= 5 && r.tickets > pm + 2 * psd).map((r) => ({ day: r.day, tickets: r.tickets, normal: Math.round(pm) }))

  // Categories with prior share and spike flag
  const catDefs = [...CATEGORIES, OTHER]
  const count = (list) => { const o = {}; for (const t of list) o[t.category] = (o[t.category] || 0) + 1; return o }
  const cc = count(cur), cp = count(prior)
  const categories = catDefs.map((c) => {
    const n = cc[c.name] || 0, p = cp[c.name] || 0
    const share = cur.length ? (n / cur.length) * 100 : 0
    const priorShare = prior.length ? (p / prior.length) * 100 : null
    const spike = priorShare != null && n >= 5 && share - priorShare >= 5 && share >= priorShare * 1.5
    const catFrt = frt(cur.filter((t) => t.category === c.name))
    return { name: c.name, count: n, prior: p, share, priorShare, spike, auto: c.auto, play: c.play, avgFrtHours: mean(catFrt) }
  }).filter((c) => c.count || c.prior).sort((a, b) => b.count - a.count)

  // Awaiting a reply now (customer spoke last, still in the inbox), any age.
  const open = await q(
    `SELECT id, mailbox, subject, customer_masked, category, flags, first_in_at, last_in_at, msgs_in, msgs_out
     FROM inn_cs_threads WHERE last_from = 'in' AND in_inbox = true ORDER BY last_in_at ASC`)
  const ageing = Object.fromEntries(AGE_BUCKETS.map(([k]) => [k, 0]))
  const ageingByCat = {}
  for (const t of open) {
    const hrs = (now - new Date(t.last_in_at).getTime()) / H
    const b = AGE_BUCKETS.find(([, max]) => hrs <= max)[0]
    ageing[b]++
    ageingByCat[t.category] = ageingByCat[t.category] || Object.fromEntries(AGE_BUCKETS.map(([k]) => [k, 0]))
    ageingByCat[t.category][b]++
  }
  const oldest = open.slice(0, 25).map((t) => ({
    id: t.id, subject: t.subject || '(no subject)', customer: t.customer_masked, category: t.category, flags: t.flags || [],
    waitingHours: (now - new Date(t.last_in_at).getTime()) / H, firstContact: t.first_in_at, followUps: Math.max(0, t.msgs_in - 1), link: gmailLink(t.mailbox, t.id),
  }))

  // First response distribution
  const frtBuckets = Object.fromEntries([...FRT_BUCKETS.map(([k]) => [k, 0]), ['No reply yet', 0]])
  for (const t of cur) {
    if (!t.first_reply_at) { frtBuckets['No reply yet']++; continue }
    const hrs = (new Date(t.first_reply_at) - new Date(t.first_in_at)) / H
    frtBuckets[FRT_BUCKETS.find(([, max]) => hrs <= max)[0]]++
  }

  // Agents (from the signature on each reply)
  const agents = {}
  for (const x of turnsCur) {
    const a = x.agent || 'Unattributed'
    agents[a] = agents[a] || { agent: a, replies: 0, resp: [], first: [] }
    agents[a].replies++; agents[a].resp.push(x.hrs)
  }
  for (const t of cur) {
    if (!t.first_reply_at) continue
    const a = t.first_reply_agent || 'Unattributed'
    agents[a] = agents[a] || { agent: a, replies: 0, resp: [], first: [] }
    agents[a].first.push((new Date(t.first_reply_at) - new Date(t.first_in_at)) / H)
  }
  const agentRows = Object.values(agents).map((a) => ({
    agent: a.agent, replies: a.replies, avgResponseHours: mean(a.resp), medResponseHours: median(a.resp),
    firstReplies: a.first.length, avgFrtHours: mean(a.first), withinTargetPct: a.first.length ? (a.first.filter((v) => v <= target).length / a.first.length) * 100 : null,
  })).sort((a, b) => b.replies - a.replies)

  // When customers write (team time zone)
  const byHour = Array(24).fill(0)
  for (const m of msgs) if (m.dir === 'in' && new Date(m.at).getTime() >= since) byHour[hourIn(new Date(m.at), tz)]++

  // Repeat contacts: customers who opened more than one ticket in the period
  const perCustomer = {}
  for (const t of cur) if (t.customer_hash) perCustomer[t.customer_hash] = (perCustomer[t.customer_hash] || 0) + 1
  const repeatCustomers = Object.values(perCustomer).filter((n) => n > 1).length
  const uniqueCustomers = Object.keys(perCustomer).length

  // Risk: flagged tickets in the period plus any still waiting
  const riskIds = new Set()
  const risk = []
  for (const t of [...open, ...cur]) {
    if (!t.flags?.length || riskIds.has(t.id)) continue
    riskIds.add(t.id)
    const waiting = open.some((o) => o.id === t.id)
    risk.push({ id: t.id, subject: t.subject || '(no subject)', customer: t.customer_masked, category: t.category, flags: t.flags, waiting, at: t.last_in_at || t.first_in_at, link: gmailLink(t.mailbox, t.id) })
  }
  risk.sort((a, b) => (b.waiting - a.waiting) || (new Date(b.at) - new Date(a.at)))

  const wt = withinTarget(cur), wtPrior = withinTarget(prior)
  return {
    connected: true,
    days,
    target,
    timezone: tz,
    sync: syncState,
    totals: {
      tickets: cur.length, ticketsPrior: prior.length,
      perDay: cur.length / days, perDayPrior: prior.length / days,
      avgFrtHours: mean(frtCur), medFrtHours: median(frtCur), avgFrtHoursPrior: mean(frtPrior),
      avgResponseHours: mean(turnsCur.map((x) => x.hrs)), medResponseHours: median(turnsCur.map((x) => x.hrs)), avgResponseHoursPrior: mean(turnsPrior.map((x) => x.hrs)),
      withinTargetPct: wt.pct, withinTargetOk: wt.ok, withinTargetJudged: wt.judged, withinTargetPctPrior: wtPrior.pct,
      awaiting: open.length, overTarget: open.filter((t) => (now - new Date(t.last_in_at).getTime()) / H > target).length,
      replies: turnsCur.length, repliesPrior: turnsPrior.length,
      fcrPct: fcr(cur), fcrPctPrior: fcr(prior),
      repeatCustomers, uniqueCustomers,
      flagged: risk.length, flaggedWaiting: risk.filter((r) => r.waiting).length,
    },
    series, spikeDays,
    categories,
    ageing, ageingByCat,
    oldest,
    frtBuckets,
    agents: agentRows,
    byHour,
    risk: risk.slice(0, 25),
    dispute: { ratePct: settings.dispute_rate_pct ?? null, thresholdPct: settings.dispute_threshold_pct ?? 1, at: settings.dispute_rate_at || null },
    totalThreads: total,
  }
}

// Re-run the categoriser over stored threads (after the rules change).
export async function reclassifyAll() {
  await ensureCs()
  const rows = await q('SELECT id, subject, excerpt FROM inn_cs_threads')
  let changed = 0
  for (const r of rows) {
    const cat = classify(r.subject, r.excerpt), flags = flagsFor(r.subject, r.excerpt)
    const res = await q('UPDATE inn_cs_threads SET category = $2, flags = $3 WHERE id = $1 AND (category <> $2 OR flags <> $3) RETURNING id', [r.id, cat, flags])
    changed += res.length
  }
  return { threads: rows.length, changed }
}
