import { timingSafeEqual } from 'node:crypto'
import { q } from '../db'
import { cacheGet, cacheSet, logEvent } from './db'
import { sha256 } from './auth'
import { ensureCs, CATEGORIES, OTHER } from './cs'
import * as shopify from './shopify'

// Innaderm support board: the Serentia board's working view, fed by the
// support Gmail instead of Re:amaze. Tickets come from inn_cs_threads (the
// Apps Script keeps them current); this module adds the team's working state
// (status, note, owner), reply templates filled with live Shopify order data,
// a queue of replies the Apps Script turns into Gmail drafts, escalations to
// Calvin as ClickUp tasks, and the automation tracker.

export const STATUSES = ['New', 'Drafted', 'Replied', 'Waiting on customer', 'With Calvin', 'With Zendrop', 'Done', 'Skip']
const CLOSED = new Set(['Done', 'Skip'])

// Automation ladder per ticket type. `save` is the share of handling time an
// agent no longer spends at that stage (assumptions, shown on the board).
export const STAGES = [
  { key: 'manual', label: 'Manual', save: 0, help: 'Written from scratch each time.' },
  { key: 'template', label: 'Approved template', save: 0.4, help: 'Agent picks the template; name, order and tracking fill in.' },
  { key: 'autodraft', label: 'Auto-drafted in Gmail', save: 0.7, help: 'A filled draft is waiting in the Gmail thread when the ticket arrives. Agent checks and sends.' },
  { key: 'autosend', label: 'Auto-send', save: 0.95, help: 'Sent without a person. Next step: Claude-written replies with a review sample. Not switched on yet.' },
]

let ready
export function ensureBoard() {
  if (ready) return ready
  ready = (async () => {
    await ensureCs()
    await q(`CREATE TABLE IF NOT EXISTS inn_cs_board (
      thread_id TEXT PRIMARY KEY,
      status TEXT,
      note TEXT,
      category_override TEXT,
      owner TEXT,
      clickup_task_id TEXT,
      escalated_at TIMESTAMPTZ,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    await q(`CREATE TABLE IF NOT EXISTS inn_cs_templates (
      key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      categories TEXT[] NOT NULL DEFAULT '{}',
      body TEXT NOT NULL,
      checklist TEXT,
      approved BOOLEAN NOT NULL DEFAULT false,
      sort INTEGER NOT NULL DEFAULT 100,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    await q(`CREATE TABLE IF NOT EXISTS inn_cs_drafts (
      id BIGSERIAL PRIMARY KEY,
      thread_id TEXT NOT NULL,
      body TEXT NOT NULL,
      template_key TEXT,
      category TEXT,
      source TEXT NOT NULL DEFAULT 'agent',
      requested_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      gmail_draft_id TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ
    )`)
    await q(`CREATE INDEX IF NOT EXISTS idx_inn_cs_drafts_thread ON inn_cs_drafts (thread_id, created_at)`)
    await q(`CREATE INDEX IF NOT EXISTS idx_inn_cs_drafts_status ON inn_cs_drafts (status)`)
    await q(`CREATE TABLE IF NOT EXISTS inn_cs_automation (
      category TEXT PRIMARY KEY,
      stage TEXT NOT NULL DEFAULT 'manual',
      owner TEXT,
      next_step TEXT,
      stage_since TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    for (const t of DEFAULT_TEMPLATES) {
      await q(
        `INSERT INTO inn_cs_templates (key, title, categories, body, checklist, approved, sort, updated_by)
         VALUES ($1,$2,$3,$4,$5,false,$6,'default') ON CONFLICT (key) DO NOTHING`,
        [t.key, t.title, t.categories, t.body, t.checklist || null, t.sort])
    }
  })()
  ready.catch(() => { ready = null })
  return ready
}

// ---------- templates ----------
// Placeholders in {braces} are filled from the ticket and Shopify. Anything in
// [CAPITALS IN BRACKETS] is for the agent to replace; a draft that still has
// one is never put into Gmail.
export const AGENT_PLACEHOLDER = /\[[A-Z][A-Z0-9 ,.:;'’()/&+-]{2,}\]/
const SIGN = '\n\n{agent}\nInnaderm'
export const DEFAULT_TEMPLATES = [
  { key: 'wismo', sort: 10, title: 'Where is my order', categories: ['Where is my order'],
    body: `Hi {first_name},\n\nThank you for reaching out, and sorry for the wait.\n\n{order_status}\n\nIf anything looks off, just reply here and I'll chase it for you.${SIGN}`,
    checklist: 'Check the order line above matches Shopify. Never promise a ship date other than the one in Settings.' },
  { key: 'dnr', sort: 20, title: 'Marked delivered, not received', categories: ['Marked delivered, not received'],
    body: `Hi {first_name},\n\nI'm sorry your parcel hasn't turned up. {order_status}\n\nCould you please:\n1. Check your mailbox, porch and anywhere a parcel could be left\n2. Ask neighbours or anyone at your address if they took it in\n3. Confirm the shipping address on your order is correct\n\nIf it still hasn't appeared after that, reply here and I'll open a claim with the carrier for you.${SIGN}`,
    checklist: 'Check tracking says delivered. No replacement or refund without Calvin.' },
  { key: 'sub_change', sort: 30, title: 'Subscription: wants to cancel or pause', categories: ['Subscription'],
    body: `Hi {first_name},\n\nThanks for letting me know. Before I make any changes, may I ask what prompted this? If it's timing or having too many on hand, I can pause your subscription or move your next delivery back instead, so nothing ships until you're ready.\n\nJust reply with what works best for you and I'll take care of it.${SIGN}`,
    checklist: 'If they confirm cancel or pause: send to Calvin (Loop). Never say it is done until Calvin confirms.' },
  { key: 'sub_charge', sort: 35, title: 'Subscription: unexpected charge', categories: ['Subscription', 'Billing / payment'],
    body: `Hi {first_name},\n\nThank you for reaching out, and I understand an unexpected charge is frustrating. {order_status}\n\n[CONFIRM IN SHOPIFY THAT THIS WAS A SUBSCRIPTION RENEWAL AND SAY SO]\n\nI can pause or adjust your subscription so nothing else ships until you're ready. Would you like me to do that?${SIGN}`,
    checklist: 'Check the order is a renewal. Refunds and Loop changes go to Calvin first.' },
  { key: 'refund', sort: 40, title: 'Refund request (first reply)', categories: ['Refund / return'],
    body: `Hi {first_name},\n\nThank you for getting in touch, and I'm sorry it hasn't been what you hoped for. So I can help properly, could you tell me a little more:\n1. How long have you been taking it, and how many capsules a day?\n2. What were you hoping to see, and what have you noticed so far?\n\nI'll look at the best option for you as soon as I hear back.${SIGN}`,
    checklist: 'Never promise or mention a refund amount. Any refund needs Calvin: use Send to Calvin.' },
  { key: 'results', sort: 45, title: 'Not working / no results yet', categories: ['Not working / results'],
    body: `Hi {first_name},\n\nThank you for being honest with us, I really appreciate it. Could you tell me:\n1. How long you have been taking it\n2. How many capsules a day, and whether you have missed any days\n3. What you were hoping to see, and anything you have noticed so far\n\nWith that I can give you proper advice on what to do next.${SIGN}`,
    checklist: 'No medical claims. If they ask for a refund, send to Calvin.' },
  { key: 'product_q', sort: 50, title: 'Product question', categories: ['Product question'],
    body: `Hi {first_name},\n\nThanks for your question!\n\n[ANSWER FROM THE PRODUCT PAGE OR CALVIN]\n\nIf you'd like to give it a try, here's 15% off your order: {discount_code}.${SIGN}`,
    checklist: 'Only answer from innaderm.com or what Calvin confirmed. No medical advice.' },
  { key: 'damaged', sort: 60, title: 'Damaged, wrong or missing item', categories: ['Damaged / wrong / missing item'],
    body: `Hi {first_name},\n\nI'm so sorry your order didn't arrive as it should. Could you send me:\n1. A photo of the item(s) and the packaging\n2. {order_or_ask}\n\nAs soon as I have these I'll sort out the next step for you.${SIGN}`,
    checklist: 'Replacements and refunds need Calvin.' },
  { key: 'address', sort: 70, title: 'Address change', categories: ['Address change'],
    body: `Hi {first_name},\n\nThanks for letting me know. {order_status}\n\nCould you reply with the full corrected address, including any apartment number and the ZIP code? If your order hasn't shipped yet I'll update it straight away.${SIGN}`,
    checklist: 'Time critical: answer within 30 minutes. Update the address in Shopify only if unfulfilled.' },
  { key: 'reaction', sort: 80, title: 'Adverse reaction', categories: ['Adverse reaction'],
    body: `Hi {first_name},\n\nI'm really sorry to hear this, and thank you for telling us. Please stop taking the capsules for now, and if the reaction is severe or doesn't settle, please speak to a doctor or pharmacist.\n\nTo help us look into it, could you share:\n1. What you noticed and when it started\n2. How many capsules a day you were taking\n3. A photo, if it's a skin reaction\n\nI've passed this to our team and will come back to you personally.${SIGN}`,
    checklist: 'Send to Calvin the same day. Personal reply only, never automated.' },
  { key: 'dispute', sort: 90, title: 'Chargeback or dispute threat', categories: ['Chargeback / dispute threat'],
    body: `Hi {first_name},\n\nI'm sorry this has been frustrating, and I want to put it right for you directly. {order_status}\n\nPlease give me the chance to resolve this with you here first, it's the fastest way to get it sorted. Could you tell me what outcome you'd like?${SIGN}`,
    checklist: 'Send to Calvin the same day. No refund promise. Never automated.' },
  { key: 'cancel', sort: 100, title: 'Cancel order', categories: ['Cancel order'],
    body: `Hi {first_name},\n\nThanks for reaching out. {order_status}\n\nCould you tell me what prompted the cancellation? If it's about delivery time or the quantity, I may be able to sort that out for you instead.${SIGN}`,
    checklist: 'Cancelling a paid order is a refund: Calvin approves first.' },
  { key: 'billing', sort: 110, title: 'Billing question', categories: ['Billing / payment'],
    body: `Hi {first_name},\n\nThanks for reaching out. {order_status}\n\n[EXPLAIN THE CHARGE FROM SHOPIFY]${SIGN}`,
    checklist: 'Double charges and refunds go to Calvin.' },
  { key: 'discount', sort: 120, title: 'Discount question', categories: ['Discount / offer'],
    body: `Hi {first_name},\n\nThanks for asking! You can use {discount_code} for 15% off at checkout on innaderm.com.${SIGN}`,
    checklist: 'Check there is no other live offer you should mention.' },
  { key: 'blank', sort: 130, title: 'Blank contact form', categories: [],
    body: `Hi {first_name},\n\nThanks for reaching out! It looks like your message came through blank. Could you reply with how I can help, and your order number if it's about an order?${SIGN}` },
  { key: 'general', sort: 200, title: 'General reply', categories: ['Other'],
    body: `Hi {first_name},\n\nThanks for getting in touch!\n\n[YOUR REPLY]${SIGN}` },
]

export function fill(body, vars) {
  return String(body).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m))
}

const firstName = (name, email) => {
  const n = String(name || '').trim().split(/\s+/)[0] || ''
  if (/^[A-Za-zÀ-ÿ'-]{2,}$/.test(n)) return n[0].toUpperCase() + n.slice(1).toLowerCase()
  return 'there'
}
// "brittany cole" -> "Brittany Cole"; mixed-case names are left alone.
const properName = (n) => { const v = String(n || '').trim(); return v && v === v.toLowerCase() ? v.replace(/(^|[\s'-])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase()) : v }
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : '')

function trackUrl(o) {
  if (o.trackingUrl) return o.trackingUrl
  if (!o.trackingNumber) return null
  return `https://t.17track.net/en#nums=${encodeURIComponent(o.trackingNumber)}`
}

// One paragraph about the most relevant order, written for the customer.
export function orderSentence(o, settings) {
  if (!o) return "Could you send me your order number (it starts with #INN) or the email you ordered with? I'll check it straight away."
  if (o.cancelledAt) return `Your order ${o.name} was cancelled on ${fmtDay(o.cancelledAt)}.`
  if (o.deliveredAt) return `Tracking shows your order ${o.name} was delivered on ${fmtDay(o.deliveredAt)}.`
  if (o.fulfilledAt || o.trackingNumber) {
    const url = trackUrl(o)
    return `Your order ${o.name} shipped on ${fmtDay(o.fulfilledAt)}${o.carrier ? ` with ${o.carrier}` : ''}.${o.trackingNumber ? ` Your tracking number is ${o.trackingNumber}${url ? ` and you can follow it here: ${url}` : ''}.` : ''}`
  }
  const eta = String(settings.cs_ship_eta_text || '').trim()
  return `Your order ${o.name} hasn't shipped yet. ${eta ? `It's due to ship by ${eta}, and you'll` : "[CONFIRM THE SHIP DATE WITH CALVIN]. You'll"} get your tracking link by email the day it goes out.`
}

export function templateVars(t, settings) {
  const o = t.orders?.[0] || null
  return {
    first_name: firstName(t.customerName, t.customerEmail),
    order_number: o?.name || '[ORDER NUMBER]',
    order_status: orderSentence(o, settings),
    order_or_ask: o ? `Confirmation that the order is ${o.name}` : 'Your order number (it starts with #INN)',
    discount_code: settings.cs_discount_code || 'WELCOME15',
  }
}

// ---------- orders ----------
function fromRow(r) {
  return {
    name: r.name, createdAt: r.created_at, cancelledAt: r.cancelled_at, financial: r.financial, status: r.fulfill_status,
    total: Number(r.total || 0), subscription: !!r.is_subscription, fulfilledAt: r.first_fulfilled_at, deliveredAt: r.delivered_at,
    display: r.display, carrier: r.tracking_company, trackingNumber: r.tracking_number, trackingUrl: null,
  }
}
function fromGql(n) {
  const fs = (n.fulfillments || []).filter((f) => !['CANCELLED', 'FAILURE', 'ERROR'].includes(f.status))
  const latest = fs[fs.length - 1]
  const tags = (n.tags || []).map((x) => String(x).toLowerCase())
  return {
    name: n.name, createdAt: n.createdAt, cancelledAt: n.cancelledAt, financial: n.displayFinancialStatus, status: n.displayFulfillmentStatus,
    total: Number(n.currentTotalPriceSet?.shopMoney?.amount || 0), subscription: tags.some((x) => /subscri|recurring|renewal/.test(x)),
    fulfilledAt: fs[0]?.createdAt || null, deliveredAt: fs.map((f) => f.deliveredAt).filter(Boolean).sort().pop() || null,
    display: latest?.displayStatus || null, carrier: latest?.trackingInfo?.[0]?.company || null,
    trackingNumber: latest?.trackingInfo?.[0]?.number || null, trackingUrl: latest?.trackingInfo?.[0]?.url || null,
  }
}

const SAFE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
const ORDER_FIELDS = `name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus tags
  currentTotalPriceSet { shopMoney { amount } }
  fulfillments(first: 3) { createdAt deliveredAt displayStatus status trackingInfo(first: 1) { company number url } }`

// Orders for each ticket: by #INN number from the synced table, then by the
// customer's email straight from Shopify (cached 30 minutes per address).
async function ordersFor(tickets) {
  const names = [...new Set(tickets.flatMap((t) => t.orderNumbers))]
  const byName = new Map()
  if (names.length) {
    for (const r of await q('SELECT * FROM inn_orders WHERE name = ANY($1)', [names])) byName.set(r.name, fromRow(r))
  }
  const byEmail = new Map()
  const emails = [...new Set(tickets.map((t) => t.customerEmail).filter((e) => e && SAFE_EMAIL.test(e)))]
  const missing = []
  for (const e of emails) {
    const hit = await cacheGet('cs_orders_' + e, 1800)
    if (hit?.fresh) byEmail.set(e, hit.value.orders || [])
    else missing.push(e)
  }
  if (shopify.configured() && missing.length) {
    for (let i = 0; i < Math.min(missing.length, 60); i += 20) {
      const chunk = missing.slice(i, i + 20)
      const query = `query { ${chunk.map((e, j) => `e${j}: orders(first: 10, sortKey: CREATED_AT, reverse: true, query: ${JSON.stringify('email:' + e)}) { nodes { ${ORDER_FIELDS} } }`).join('\n')} }`
      try {
        const json = await shopify.gql(query)
        for (let j = 0; j < chunk.length; j++) {
          const orders = (json.data?.[`e${j}`]?.nodes || []).map(fromGql)
          byEmail.set(chunk[j], orders)
          await cacheSet('cs_orders_' + chunk[j], { orders })
        }
      } catch { /* board still works without order data */ }
    }
  }
  for (const t of tickets) {
    const seen = new Map()
    for (const n of t.orderNumbers) if (byName.has(n)) seen.set(n, byName.get(n))
    for (const o of byEmail.get(t.customerEmail) || []) if (!seen.has(o.name)) seen.set(o.name, o)
    // Orders the customer named come first, then newest.
    t.orders = [...seen.values()].sort((a, b) => (t.orderNumbers.includes(b.name) - t.orderNumbers.includes(a.name)) || (new Date(b.createdAt) - new Date(a.createdAt))).slice(0, 5)
    const all = byEmail.get(t.customerEmail) || t.orders
    const spent = all.filter((o) => !o.cancelledAt).reduce((a, o) => a + o.total, 0)
    // SOP VIP rule: 2+ purchases or $100+ spent.
    t.vip = all.filter((o) => !o.cancelledAt).length >= 2 || spent >= 100
    t.spent = spent
    // Refund matrix: the guarantee covers the first order only.
    const live = all.filter((o) => !o.cancelledAt)
    t.orderCount = live.length
    t.firstOrder = live.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null
  }
}

// ---------- board ----------
function gmailLink(mailbox, id) {
  return `https://mail.google.com/mail/u/0/${mailbox ? `?authuser=${encodeURIComponent(mailbox)}` : ''}#all/${id}`
}

export async function boardData({ settings }) {
  await ensureBoard()
  const rows = await q(
    `SELECT t.*, b.status, b.note, b.category_override, b.owner, b.clickup_task_id, b.escalated_at, b.updated_by AS status_by, b.updated_at AS status_at
     FROM inn_cs_threads t LEFT JOIN inn_cs_board b ON b.thread_id = t.id
     WHERE (t.last_from = 'in' AND t.in_inbox)
        OR (b.status IS NOT NULL AND b.status NOT IN ('Done', 'Skip') AND b.updated_at > now() - interval '45 days')
        OR t.last_out_at > now() - interval '3 days'
        OR b.updated_at > now() - interval '3 days'
     ORDER BY t.last_in_at DESC LIMIT 800`)
  const ids = rows.map((r) => r.id)
  const drafts = ids.length ? await q(
    `SELECT id, thread_id, status, source, requested_by, template_key, error, created_at, processed_at FROM inn_cs_drafts
     WHERE thread_id = ANY($1) AND created_at > now() - interval '30 days' ORDER BY created_at DESC`, [ids]) : []
  const draftsBy = {}
  for (const d of drafts) (draftsBy[d.thread_id] ||= []).push({ id: Number(d.id), status: d.status, source: d.source, by: d.requested_by, template: d.template_key, error: d.error, at: d.created_at, done: d.processed_at })

  const now = Date.now()
  const tickets = rows.map((r) => {
    const category = r.category_override || r.category
    const lastIn = new Date(r.last_in_at).getTime()
    const statusAt = r.status_at ? new Date(r.status_at).getTime() : 0
    // A closed ticket the customer wrote to again is back on the list.
    const reopened = !!r.status && CLOSED.has(r.status) && r.last_from === 'in' && lastIn > statusAt
    const needsReply = r.last_from === 'in' && r.in_inbox && (!r.status || !CLOSED.has(r.status) || reopened)
    return {
      id: r.id, subject: r.subject || '(no subject)', customerName: r.customer_name, customerEmail: r.customer_email,
      category, autoCategory: r.category, flags: r.flags || [], excerpt: r.excerpt, lastExcerpt: r.last_excerpt,
      orderNumbers: r.order_numbers || [], firstIn: r.first_in_at, lastIn: r.last_in_at, lastOut: r.last_out_at, lastFrom: r.last_from,
      msgsIn: r.msgs_in, msgsOut: r.msgs_out, inInbox: r.in_inbox,
      waitingHours: r.last_from === 'in' ? (now - lastIn) / 3600e3 : null,
      status: r.status || (r.last_from === 'out' ? 'Replied' : 'New'), statusSet: !!r.status, statusBy: r.status_by, statusAt: r.status_at,
      note: r.note || '', owner: r.owner, reopened, needsReply,
      clickup: r.clickup_task_id ? { id: r.clickup_task_id, url: `https://app.clickup.com/t/${r.clickup_task_id}`, escalatedAt: r.escalated_at } : null,
      drafts: draftsBy[r.id] || [], link: gmailLink(r.mailbox, r.id),
      customerLink: r.customer_email ? `https://mail.google.com/mail/u/0/${r.mailbox ? `?authuser=${encodeURIComponent(r.mailbox)}` : ''}#search/${encodeURIComponent('from:' + r.customer_email)}` : null,
    }
  })
  await ordersFor(tickets)
  await attachClickup(tickets.filter((t) => t.clickup))
  for (const t of tickets) t.vars = templateVars(t, settings)

  const templates = await listTemplates()
  return {
    tickets, templates, statuses: STATUSES,
    defaults: defaultTemplateMap(templates),
    automation: await automationData(settings, templates),
    stages: STAGES,
    settings: { cs_ship_eta_text: settings.cs_ship_eta_text || '', cs_discount_code: settings.cs_discount_code || 'WELCOME15' },
    minutes: Number(settings.cs_minutes_per_ticket || 6),
    clickupReady: !!process.env.INNADERM_CLICKUP_TOKEN,
    shopifyReady: shopify.configured(),
    sync: (await cacheGet('cs_ingest_state', 1e12))?.value || null,
    draftScript: (await cacheGet('cs_drafts_poll', 1e12))?.value || null,
  }
}

export async function listTemplates() {
  await ensureBoard()
  return (await q('SELECT key, title, categories, body, checklist, approved, sort, updated_by, updated_at FROM inn_cs_templates ORDER BY sort, title'))
    .map((r) => ({ key: r.key, title: r.title, categories: r.categories || [], body: r.body, checklist: r.checklist || '', approved: r.approved, sort: r.sort, updatedBy: r.updated_by, updatedAt: r.updated_at }))
}
function defaultTemplateMap(templates) {
  const map = {}
  for (const c of [...CATEGORIES, OTHER]) {
    const t = templates.find((x) => x.categories.includes(c.name))
    map[c.name] = t?.key || 'general'
  }
  return map
}

export async function updateTicket(id, patch, actor) {
  await ensureBoard()
  const exists = await q('SELECT id FROM inn_cs_threads WHERE id = $1', [id])
  if (!exists.length) return { error: 'unknown ticket', status: 404 }
  const fields = {}
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) return { error: 'bad status', status: 400 }
    fields.status = patch.status
  }
  if (patch.note !== undefined) fields.note = String(patch.note || '').slice(0, 2000)
  if (patch.owner !== undefined) fields.owner = String(patch.owner || '').slice(0, 60) || null
  if (patch.category !== undefined) {
    const ok = [...CATEGORIES, OTHER].some((c) => c.name === patch.category)
    if (patch.category && !ok) return { error: 'bad category', status: 400 }
    fields.category_override = patch.category || null
  }
  const keys = Object.keys(fields)
  if (!keys.length) return { error: 'nothing to save', status: 400 }
  const cols = keys.join(', ')
  const vals = keys.map((_, i) => `$${i + 3}`).join(', ')
  const sets = keys.map((k) => `${k} = EXCLUDED.${k}`).join(', ')
  await q(
    `INSERT INTO inn_cs_board (thread_id, updated_by, ${cols}) VALUES ($1, $2, ${vals})
     ON CONFLICT (thread_id) DO UPDATE SET ${sets}, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [id, actor, ...keys.map((k) => fields[k])])
  await logEvent(actor, 'cs.ticket', { id, ...fields })
  return { ok: true }
}

// ---------- Gmail drafts (picked up by the Apps Script) ----------
export async function queueDraft(id, { body, template, category, source = 'agent' }, actor) {
  await ensureBoard()
  const text = String(body || '').replace(/\r\n/g, '\n').trim()
  if (!text) return { error: 'empty draft', status: 400 }
  if (text.length > 8000) return { error: 'draft too long', status: 400 }
  if (AGENT_PLACEHOLDER.test(text)) return { error: `Replace ${text.match(AGENT_PLACEHOLDER)[0]} before putting this in Gmail.`, status: 400 }
  if (/\{\w+\}/.test(text)) return { error: `Fill in ${text.match(/\{\w+\}/)[0]} first.`, status: 400 }
  const t = await q('SELECT id FROM inn_cs_threads WHERE id = $1', [id])
  if (!t.length) return { error: 'unknown ticket', status: 404 }
  const pending = await q(`SELECT id FROM inn_cs_drafts WHERE thread_id = $1 AND status = 'pending'`, [id])
  if (pending.length) await q(`UPDATE inn_cs_drafts SET status = 'replaced', processed_at = now() WHERE thread_id = $1 AND status = 'pending'`, [id])
  const r = await q(
    `INSERT INTO inn_cs_drafts (thread_id, body, template_key, category, source, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [id, text, template ? String(template).slice(0, 40) : null, category ? String(category).slice(0, 80) : null, source, actor])
  if (source !== 'auto') await updateTicket(id, { status: 'Drafted' }, actor)
  return { ok: true, id: Number(r[0].id) }
}

export function scriptAuthorised(request) {
  const want = String(process.env.INNADERM_CS_INGEST_KEY || '')
  if (want.length < 16) return false
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return timingSafeEqual(Buffer.from(sha256(got)), Buffer.from(sha256(want)))
}

export async function pendingDrafts() {
  await ensureBoard()
  await cacheSet('cs_drafts_poll', { at: new Date().toISOString() })
  return (await q(`SELECT id, thread_id, body FROM inn_cs_drafts WHERE status = 'pending' ORDER BY created_at LIMIT 25`))
    .map((r) => ({ id: Number(r.id), threadId: r.thread_id, body: r.body }))
}

export async function draftResults(results) {
  await ensureBoard()
  let n = 0
  for (const r of (Array.isArray(results) ? results : []).slice(0, 50)) {
    const id = Number(r?.id)
    if (!Number.isInteger(id)) continue
    await q(
      `UPDATE inn_cs_drafts SET status = $2, gmail_draft_id = $3, error = $4, processed_at = now() WHERE id = $1 AND status = 'pending'`,
      [id, r.ok ? 'created' : 'failed', r.draftId ? String(r.draftId).slice(0, 80) : null, r.error ? String(r.error).slice(0, 300) : null])
    n++
  }
  return { updated: n }
}

// New customer messages in a type set to "Auto-drafted in Gmail" get a filled
// draft queued straight away, using that type's approved template. Skipped
// when the template still needs a person (a [PLACEHOLDER] left after filling),
// when the ticket is flagged risky, or when a draft already covers this turn.
export async function autoDraft(ids, settings) {
  if (!ids?.length) return { queued: 0 }
  await ensureBoard()
  const auto = new Set((await q(`SELECT category FROM inn_cs_automation WHERE stage IN ('autodraft', 'autosend')`)).map((r) => r.category))
  if (!auto.size) return { queued: 0 }
  const rows = await q(
    `SELECT t.id, t.subject, t.customer_name, t.customer_email, t.order_numbers, t.flags, t.last_in_at, t.last_from, t.in_inbox,
            COALESCE(b.category_override, t.category) AS category, b.status
     FROM inn_cs_threads t LEFT JOIN inn_cs_board b ON b.thread_id = t.id WHERE t.id = ANY($1)`, [ids])
  const cand = rows.filter((r) => auto.has(r.category) && r.last_from === 'in' && r.in_inbox && !(r.flags || []).length && !CLOSED.has(r.status || ''))
  if (!cand.length) return { queued: 0 }
  const covered = new Set((await q(
    `SELECT DISTINCT d.thread_id FROM inn_cs_drafts d JOIN inn_cs_threads t ON t.id = d.thread_id
     WHERE d.thread_id = ANY($1) AND d.created_at >= t.last_in_at AND d.status <> 'replaced'`, [cand.map((r) => r.id)])).map((r) => r.thread_id))
  const templates = await listTemplates()
  const defaults = defaultTemplateMap(templates)
  const tickets = cand.filter((r) => !covered.has(r.id)).map((r) => ({ id: r.id, category: r.category, customerName: r.customer_name, customerEmail: r.customer_email, orderNumbers: r.order_numbers || [] }))
  if (!tickets.length) return { queued: 0 }
  await ordersFor(tickets)
  let queued = 0
  for (const t of tickets) {
    const tpl = templates.find((x) => x.key === defaults[t.category])
    if (!tpl?.approved) continue
    const body = fill(tpl.body, { ...templateVars(t, settings), agent: settings.cs_autodraft_signature || 'The Innaderm Team' })
    if (AGENT_PLACEHOLDER.test(body) || /\{\w+\}/.test(body)) continue
    const r = await queueDraft(t.id, { body, template: tpl.key, category: t.category, source: 'auto' }, 'auto-draft')
    if (r.ok) queued++
  }
  return { queued }
}

// ---------- templates & automation (admin) ----------
export async function saveTemplate(t, actor) {
  await ensureBoard()
  const key = String(t?.key || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40)
  if (!key) return { error: 'key required', status: 400 }
  const title = String(t.title || '').trim().slice(0, 80)
  const body = String(t.body || '').replace(/\r\n/g, '\n').trim().slice(0, 6000)
  if (!title || !body) return { error: 'title and body required', status: 400 }
  const names = new Set([...CATEGORIES, OTHER].map((c) => c.name))
  const categories = (Array.isArray(t.categories) ? t.categories : []).map(String).filter((c) => names.has(c))
  await q(
    `INSERT INTO inn_cs_templates (key, title, categories, body, checklist, approved, sort, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, 150),$8, now())
     ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title, categories = EXCLUDED.categories, body = EXCLUDED.body,
       checklist = EXCLUDED.checklist, approved = EXCLUDED.approved, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, title, categories, body, String(t.checklist || '').slice(0, 500) || null, !!t.approved, Number.isInteger(t.sort) ? t.sort : null, actor])
  await logEvent(actor, 'cs.template', { key, approved: !!t.approved })
  return { ok: true, key }
}

export async function saveAutomation(a, actor) {
  await ensureBoard()
  const names = new Set([...CATEGORIES, OTHER].map((c) => c.name))
  if (!names.has(a?.category)) return { error: 'unknown category', status: 400 }
  if (a.stage !== undefined && !STAGES.some((s) => s.key === a.stage)) return { error: 'bad stage', status: 400 }
  if (a.stage === 'autosend') return { error: 'Auto-send is not available yet. It needs the Claude reply step first.', status: 400 }
  const def = [...CATEGORIES, OTHER].find((c) => c.name === a.category)
  if ((a.stage === 'autodraft') && def.auto === 'never') return { error: `${a.category} is never automated. Keep it personal.`, status: 400 }
  const prev = (await q('SELECT stage FROM inn_cs_automation WHERE category = $1', [a.category]))[0]
  await q(
    `INSERT INTO inn_cs_automation (category, stage, owner, next_step, updated_by) VALUES ($1, COALESCE($2, 'manual'), $3, $4, $5)
     ON CONFLICT (category) DO UPDATE SET stage = COALESCE($2, inn_cs_automation.stage), owner = COALESCE($3, inn_cs_automation.owner),
       next_step = COALESCE($4, inn_cs_automation.next_step), updated_by = $5, updated_at = now(),
       stage_since = CASE WHEN $2 IS NOT NULL AND $2 <> inn_cs_automation.stage THEN now() ELSE inn_cs_automation.stage_since END`,
    [a.category, a.stage ?? null, a.owner !== undefined ? String(a.owner || '').slice(0, 60) : null, a.nextStep !== undefined ? String(a.nextStep || '').slice(0, 300) : null, actor])
  await logEvent(actor, 'cs.automation', { category: a.category, from: prev?.stage || 'manual', to: a.stage })
  return { ok: true }
}

async function automationData(settings, templates) {
  const rows = await q('SELECT category, stage, owner, next_step, stage_since, updated_by FROM inn_cs_automation')
  const by = Object.fromEntries(rows.map((r) => [r.category, r]))
  const counts = Object.fromEntries((await q(
    `SELECT COALESCE(b.category_override, t.category) AS category, COUNT(*)::int AS n FROM inn_cs_threads t
     LEFT JOIN inn_cs_board b ON b.thread_id = t.id WHERE t.first_in_at > now() - interval '28 days' GROUP BY 1`)).map((r) => [r.category, r.n]))
  const drafted = {}
  for (const r of await q(
    `SELECT category, source, COUNT(*)::int AS n FROM inn_cs_drafts WHERE created_at > now() - interval '28 days' AND status IN ('created', 'pending') GROUP BY 1, 2`)) {
    drafted[r.category] = drafted[r.category] || { agent: 0, auto: 0 }
    drafted[r.category][r.source === 'auto' ? 'auto' : 'agent'] += r.n
  }
  const minutes = Number(settings.cs_minutes_per_ticket || 6)
  const defaults = defaultTemplateMap(templates)
  return [...CATEGORIES, OTHER].map((c) => {
    const row = by[c.name]
    const stage = STAGES.find((s) => s.key === (row?.stage || 'manual'))
    const perWeek = ((counts[c.name] || 0) / 28) * 7
    const tpl = templates.find((x) => x.key === defaults[c.name])
    const d = drafted[c.name] || { agent: 0, auto: 0 }
    return {
      category: c.name, potential: c.auto, play: c.play, stage: stage.key, stageSince: row?.stage_since || null, owner: row?.owner || '', nextStep: row?.next_step || '',
      perWeek, hoursPerWeek: (perWeek * minutes) / 60, savedHoursPerWeek: (perWeek * minutes * stage.save) / 60,
      template: tpl ? { key: tpl.key, title: tpl.title, approved: tpl.approved } : null,
      draftsAgent28: d.agent, draftsAuto28: d.auto, tickets28: counts[c.name] || 0,
    }
  }).sort((a, b) => b.perWeek - a.perWeek)
}

// ---------- ClickUp: send to Calvin ----------
const CU = 'https://api.clickup.com/api/v2'
// Innaderm escalations have their own list (Operations > Innaderm > Founder
// Escalations), separate from Serentia's. Its fields are looked up by name, so
// the list can be swapped in Settings without code changes.
const CU_FIELD_NAMES = {
  customer: 'Customer', question: 'Question for Calvin', slug: 'Ticket slug', subject: 'Subject',
  escalated: 'Escalated', category: 'Category', position: 'Customer position', gmail: 'Gmail thread',
}
async function listFields(listId) {
  const key = 'cu_fields_' + listId
  const hit = await cacheGet(key, 3600)
  if (hit?.fresh) return hit.value
  const json = await cu(`/list/${listId}/field`)
  const byName = {}
  for (const f of json?.fields || []) byName[f.name] = { id: f.id, options: (f.type_config?.options || []).map((o) => ({ id: o.id, name: o.name })) }
  await cacheSet(key, byName)
  return byName
}
function cuCategoryName(cat) {
  if (/Refund|Billing|Chargeback/.test(cat)) return 'Refunds & charges'
  if (/order|delivered/i.test(cat) && !/Cancel/.test(cat)) return 'Not received'
  if (/Subscription|Cancel/.test(cat)) return 'Cancellations'
  if (/Damaged/.test(cat)) return 'Wrong shade / returns'
  if (/Product|working|reaction/i.test(cat)) return 'Product & help'
  return 'Other'
}
export const ESCALATION_REASONS = ['Refund approval', 'Pause or cancel subscription (Loop)', 'Replacement / reship', 'Adverse reaction', 'Chargeback or dispute', 'Not sure how to answer', 'Other']

async function cu(path, opts = {}) {
  const r = await fetch(CU + path, { ...opts, headers: { Authorization: process.env.INNADERM_CLICKUP_TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) } })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  if (!r.ok) throw new Error(`ClickUp ${r.status}: ${(json?.err || text).slice(0, 160)}`)
  return json
}

export async function escalate(id, { reason, question, customerPosition }, actor, settings) {
  await ensureBoard()
  if (!process.env.INNADERM_CLICKUP_TOKEN) return { error: 'Add INNADERM_CLICKUP_TOKEN in Vercel to send tickets to Calvin in ClickUp.', status: 400 }
  if (!ESCALATION_REASONS.includes(reason)) return { error: 'pick a reason', status: 400 }
  const ask = String(question || '').trim().slice(0, 1500)
  if (!ask) return { error: 'write the question for Calvin', status: 400 }
  const r = (await q(
    `SELECT t.*, COALESCE(b.category_override, t.category) AS cat, b.clickup_task_id FROM inn_cs_threads t LEFT JOIN inn_cs_board b ON b.thread_id = t.id WHERE t.id = $1`, [id]))[0]
  if (!r) return { error: 'unknown ticket', status: 404 }
  if (r.clickup_task_id) return { error: 'Already with Calvin. Add to the existing ClickUp task instead.', status: 409, url: `https://app.clickup.com/t/${r.clickup_task_id}` }
  const t = { id, customerName: r.customer_name, customerEmail: r.customer_email, orderNumbers: r.order_numbers || [] }
  await ordersFor([t])
  const who = properName(r.customer_name) || r.customer_email || 'Customer'
  const orderLine = t.orders?.length ? t.orders.map((o) => `${o.name}: ${o.financial || ''} ${o.status || ''}${o.subscription ? ', subscription' : ''}, $${o.total.toFixed(2)}${o.trackingNumber ? `, tracking ${o.trackingNumber}` : ''}`).join('\n') : 'No order found for this email'
  const description = [
    `Innaderm support ticket, sent from the CS board by ${actor}.`,
    '',
    `Reason: ${reason}`,
    `Question for Calvin: ${ask}`,
    '',
    `Customer: ${who}${r.customer_email ? ` <${r.customer_email}>` : ''}${t.vip ? ' (VIP)' : ''}`,
    `Subject: ${r.subject || ''}`,
    `Type: ${r.cat}`,
    `Gmail thread: ${gmailLink(r.mailbox, id)}`,
    '',
    'Orders:', orderLine,
    '',
    'Customer\'s latest message:', (r.last_excerpt || r.excerpt || '').slice(0, 1200),
    '',
    'Reply in the comments; your reply shows on the ticket in the CS board.',
    `innaderm-thread: ${id}`,
  ].join('\n')
  const listId = String(settings.cs_founder_list_id || '1500890000000464')
  const calvin = Number(settings.cs_founder_user_id || 278464620)
  // Only fields that exist on the list are sent; a missing one never blocks the escalation.
  let fields = {}
  try { fields = await listFields(listId) } catch { fields = {} }
  const fid = (k) => fields[CU_FIELD_NAMES[k]]?.id
  const catOpt = fields[CU_FIELD_NAMES.category]?.options.find((o) => o.name === cuCategoryName(r.cat))?.id
  const custom = [
    ['customer', who], ['subject', r.subject || ''], ['question', ask], ['slug', 'inn:' + id], ['escalated', Date.now()],
    ['category', catOpt], ['gmail', gmailLink(r.mailbox, id)], ['position', customerPosition ? String(customerPosition).slice(0, 500) : null],
  ].filter(([k, v]) => fid(k) && v != null && v !== '').map(([k, v]) => ({ id: fid(k), value: v }))
  const task = await cu(`/list/${listId}/task`, {
    method: 'POST',
    body: JSON.stringify({
      name: `[Innaderm] ${who}: ${reason}${t.orders?.[0] ? ` (${t.orders[0].name})` : ''}`.slice(0, 200),
      description, assignees: [calvin], tags: ['innaderm'], status: 'new ticket',
      custom_fields: custom,
    }),
  })
  await q(
    `INSERT INTO inn_cs_board (thread_id, status, clickup_task_id, escalated_at, updated_by) VALUES ($1, 'With Calvin', $2, now(), $3)
     ON CONFLICT (thread_id) DO UPDATE SET status = 'With Calvin', clickup_task_id = $2, escalated_at = now(), updated_by = $3, updated_at = now()`,
    [id, task.id, actor])
  await logEvent(actor, 'cs.escalate', { id, task: task.id, reason })
  return { ok: true, task: { id: task.id, url: task.url || `https://app.clickup.com/t/${task.id}` } }
}

// Status and Calvin's latest comment for escalated tickets (cached 3 minutes).
async function attachClickup(tickets) {
  if (!process.env.INNADERM_CLICKUP_TOKEN) return
  const calvin = String(278464620)
  for (const t of tickets.filter((x) => x.needsReply || x.status === 'With Calvin').slice(0, 40)) {
    const key = 'cu_task_' + t.clickup.id
    const hit = await cacheGet(key, 180)
    let v = hit?.fresh ? hit.value : null
    if (!v) {
      try {
        const [task, comments] = await Promise.all([cu(`/task/${t.clickup.id}`), cu(`/task/${t.clickup.id}/comment`)])
        const list = (comments?.comments || []).map((c) => ({ by: c.user?.username || '?', fromCalvin: String(c.user?.id) === calvin, text: String(c.comment_text || '').trim().slice(0, 1500), at: new Date(Number(c.date)).toISOString() }))
          .sort((a, b) => new Date(a.at) - new Date(b.at))
        v = { status: task?.status?.status || null, closed: task?.status?.type === 'closed', comments: list.slice(-5) }
        await cacheSet(key, v)
      } catch (e) {
        v = hit?.value || { error: String(e.message || e).slice(0, 120) }
      }
    }
    Object.assign(t.clickup, v)
    t.clickup.calvinReplied = (v.comments || []).some((c) => c.fromCalvin) || v.status === 'founder responded'
  }
}
