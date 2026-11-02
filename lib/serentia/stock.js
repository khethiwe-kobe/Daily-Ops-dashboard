import { parseCsv } from '../csv'
import { cached, cacheGet, cacheSet, ensureInnaderm, logEvent } from '../innaderm/db'
import { LOOP_SNAPSHOT } from './loop-snapshot'

// Serentia stock by shade. Separate from the Innaderm code on purpose: it only
// borrows the Innaderm cache table and login.
//
// Stock comes from the Inventory tab of Zendrop's shared sheet for Serentia
// ("Serene [3730212] | Zendrop"), which Zendrop updates per shade: units in
// the Zendrop app, units in their Sumai system, MOQ, lead time and their own
// days-left estimate. Sales per shade come from the Serentia Shopify store once
// SERENTIA_SHOPIFY_* keys are set in Vercel; without them the page uses
// Zendrop's days-left estimate instead.

export const SETTINGS = {
  sheetId: process.env.SERENTIA_ZENDROP_SHEET_ID || '1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY',
  inventoryGid: process.env.SERENTIA_ZENDROP_INVENTORY_GID || '', // optional: faster, exact tab export
  baselineDays: 14,   // sales window for the daily run rate
  safetyDays: 7,      // buffer on top of the supplier lead time
  targetDays: 30,     // a reorder should cover this many days after it lands
  soonDays: 14,       // "reorder soon" window before the reorder point
}

// Planned demand on top of the measured selling rate, edited on the tab and
// shared by everyone (inn_cache 'ser_plan_settings'). Defaults are a starting
// guess, not history: the tab says so until someone saves real figures.
export const DEMAND_DEFAULTS = {
  upliftPct: 0,            // campaigns running now, on every day
  bfFrom: '2026-11-27',    // Black Friday
  bfTo: '2026-12-01',      // through Cyber Monday
  bfMultiplier: 3,         // times normal daily sales during that window
  through: '2026-12-31',   // "needed by" date for the Q4 column
  saved: false,
}
const PLAN_KEY = 'ser_plan_settings'
export async function demandSettings() {
  await ensureInnaderm()
  const v = (await cacheGet(PLAN_KEY, 1e12))?.value
  return v ? { ...DEMAND_DEFAULTS, ...v, saved: true } : { ...DEMAND_DEFAULTS }
}
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null)
export async function saveDemandSettings(b, actor) {
  await ensureInnaderm()
  const n = (v, lo, hi) => { const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`Value out of range (${lo}-${hi})`); return x }
  const v = {
    upliftPct: n(b.upliftPct ?? 0, -90, 1000),
    bfFrom: isoDay(b.bfFrom) || DEMAND_DEFAULTS.bfFrom,
    bfTo: isoDay(b.bfTo) || DEMAND_DEFAULTS.bfTo,
    bfMultiplier: n(b.bfMultiplier ?? 1, 1, 50),
    through: isoDay(b.through) || DEMAND_DEFAULTS.through,
    savedAt: new Date().toISOString(), by: actor,
  }
  if (v.bfTo < v.bfFrom) throw new Error('Black Friday end is before its start')
  await cacheSet(PLAN_KEY, v)
  await logEvent(actor, 'serentia_plan_saved', v)
  return { ...DEMAND_DEFAULTS, ...v, saved: true }
}

// Multiplier on the base rate for each day from today: campaign uplift every
// day, times the Black Friday factor inside its window.
export function demandFactors(dm, now = Date.now(), days = 730) {
  const out = []
  const start = new Date(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
  for (let k = 0; k < days; k++) {
    const d = new Date(start + k * DAY).toISOString().slice(0, 10)
    let f = 1 + (Number(dm?.upliftPct) || 0) / 100
    if (dm?.bfFrom && dm?.bfTo && d >= dm.bfFrom && d <= dm.bfTo) f *= Number(dm.bfMultiplier) || 1
    out.push(f)
  }
  return out
}
const coverDays = (stock, rate, F) => {
  if (!(rate > 0)) return null
  let left = stock
  for (let k = 0; k < F.length; k++) { const d = rate * F[k]; if (left <= d) return k + left / d; left -= d }
  return F.length
}
const sumDemand = (rate, F, from, to) => { let t = 0; for (let k = Math.max(0, from); k < Math.min(to, F.length); k++) t += rate * F[k]; return t }

// ---------- Zendrop Inventory tab ----------
const num = (v) => {
  const s = String(v ?? '').replace(/[,\s$]/g, '')
  if (s === '' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
const days = (v) => { const m = String(v || '').match(/(\d+)/); return m ? Number(m[1]) : null }

// Exported for tests. Finds the header row by its column names, carries
// merged cells (product, MOQ, lead time) down, keeps one row per variant.
export function parseInventory(rows) {
  const hi = rows.findIndex((r) => r.some((c) => /^variant$/i.test(String(c).trim())) && r.some((c) => /^inventory\s+count/i.test(String(c).trim())))
  if (hi < 0) throw new Error('Inventory tab: header row not found (expected "Variant" and "Inventory Count")')
  const head = rows[hi].map((c) => String(c).replace(/\s+/g, ' ').trim().toLowerCase())
  const col = (re) => head.findIndex((h) => re.test(h))
  const C = {
    product: col(/^product name/), moq: col(/^moq/), lead: col(/^lead time/), sku: col(/^sku/), variant: col(/^variant$/),
    count: col(/^inventory count/), zd: col(/inventory \(zd app\)/), sumai: col(/units in sumai/), daysLeft: col(/days stock will last/),
    notes: col(/^notes/), updated: col(/date last updated/),
  }
  const out = []
  let carry = { product: '', moq: null, lead: null }
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]
    const get = (k) => (C[k] >= 0 ? r[C[k]] : '')
    // A new product block starts where column A has a name (merged cells
    // export their value on the first row only).
    if (String(get('product')).trim()) carry = { product: String(get('product')).trim(), moq: num(get('moq')), lead: days(get('lead')) }
    else { if (num(get('moq')) != null) carry.moq = num(get('moq')); if (days(get('lead')) != null) carry.lead = days(get('lead')) }
    const variant = String(get('variant')).trim()
    if (!variant && !String(get('sku')).trim()) continue
    out.push({
      product: carry.product, variant, sku: String(get('sku')).trim(), moq: carry.moq, leadDays: carry.lead,
      zdApp: num(get('zd')), sumai: num(get('sumai')), counted: num(get('count')), zdDaysLeft: num(get('daysLeft')),
      notes: String(get('notes')).trim(), updated: String(get('updated')).trim(),
    })
  }
  return out
}

export function zendropInventory() {
  const { sheetId, inventoryGid } = SETTINGS
  return cached('ser_zd_inventory_v2_' + sheetId, 900, async () => {
    const url = inventoryGid
      ? `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${inventoryGid}`
      : `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&headers=0&sheet=Inventory`
    const r = await fetch(url, { redirect: 'follow' })
    if (!r.ok) throw new Error(`Zendrop sheet HTTP ${r.status}`)
    return { rows: parseInventory(parseCsv(await r.text())), sheetId }
  })
}

// ---------- Serentia Shopify (optional) ----------
// Same two auth options as Innaderm: a Dev Dashboard app (client ID + secret)
// or a legacy shpat_ token. Scope needed: read_orders.
const API_VERSION = '2026-01'
const env = (k) => String(process.env['SERENTIA_SHOPIFY_' + k] || '').trim()
export const shopifyStore = () => env('STORE').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
export const shopifyConfigured = () => !!shopifyStore() && (!!env('TOKEN') || !!(env('CLIENT_ID') && env('CLIENT_SECRET')))

let memToken = null
async function token() {
  if (env('TOKEN')) return env('TOKEN')
  if (memToken && memToken.expiresAt - 600e3 > Date.now()) return memToken.token
  const r = await fetch(`https://${shopifyStore()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env('CLIENT_ID'), client_secret: env('CLIENT_SECRET') }),
  })
  const json = await r.json().catch(() => null)
  if (!r.ok || !json?.access_token) throw new Error(`Serentia Shopify token HTTP ${r.status}`)
  memToken = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in || 86400) * 1000 }
  return memToken.token
}
async function gql(query, variables) {
  const r = await fetch(`https://${shopifyStore()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() },
    body: JSON.stringify({ query, variables }),
  })
  const json = await r.json().catch(() => null)
  if (!r.ok || !json) throw new Error(`Serentia Shopify HTTP ${r.status}`)
  if (json.errors?.length) throw new Error('Serentia Shopify: ' + json.errors.map((e) => e.message).join('; ').slice(0, 200))
  return json
}

const SALES_QUERY = `
query Sales($q: String!, $after: String) {
  orders(first: 100, query: $q, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { lineItems(first: 20) { nodes { quantity title variantTitle sku } } }
  }
}`

// Units sold per line-item variant title over the last `n` days (cancelled
// orders excluded). Bundles count as their line quantity: a "2 + 1 free"
// variant that ships three units is counted once unless its title says so,
// which is why the page shows both rates side by side.
export function shopifySales(n) {
  return cached(`ser_sales_v1_${n}`, 1800, async () => {
    const since = new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10)
    const byTitle = {}
    let after = null, orders = 0, truncated = false
    for (let page = 0; page < 30; page++) {
      const json = await gql(SALES_QUERY, { q: `created_at:>=${since} -status:cancelled`, after })
      const conn = json.data.orders
      for (const o of conn.nodes) {
        orders++
        for (const li of o.lineItems.nodes) {
          const key = `${li.title} / ${li.variantTitle || ''}`.trim()
          byTitle[key] = (byTitle[key] || 0) + Number(li.quantity || 0)
        }
      }
      if (!conn.pageInfo.hasNextPage) break
      after = conn.pageInfo.endCursor
      if (page === 29) truncated = true
    }
    return { days: n, since, orders, byTitle, truncated }
  })
}

// ---------- Loop Subscriptions (Serentia) ----------
// Committed renewals over the next 30 days, by line title, so each shade can
// see the stock already promised to subscribers. Admin API token from Loop
// admin > Settings > API Tokens on the Serentia store, set as
// SERENTIA_LOOP_TOKEN. Loop allows 2 requests per 3 seconds: pages are walked
// slowly and the result is cached for 30 minutes.
const LOOP_BASE = 'https://api.loopsubscriptions.com/admin/2026-04'
export const loopConfigured = () => !!String(process.env.SERENTIA_LOOP_TOKEN || '').trim()
const lineTitle = (l) => [l.productTitle || l.product?.title || l.title || l.name || '', l.variantTitle || l.variant?.title || l.variantName || ''].filter(Boolean).join(' / ')

export function loopRenewals() {
  return cached('ser_loop_renewals_30d_v1', 1800, async () => {
    const now = Math.floor(Date.now() / 1000)
    const end = now + 30 * 86400
    const byTitle = {}       // units due in 30 days per line title
    const byTitleDays = {}   // units due per title per day offset, for "due before restock"
    let subs = 0, units = 0, pages = 0, cursor = null, untitled = 0
    while (pages < 20) {
      const url = new URL(LOOP_BASE + '/subscription')
      url.searchParams.set('status', 'ACTIVE')
      url.searchParams.set('pageSize', '100')
      url.searchParams.set('nextBillingStartEpoch', String(now))
      url.searchParams.set('nextBillingEndEpoch', String(end))
      if (cursor) url.searchParams.set('afterCursor', cursor)
      const r = await fetch(url, { headers: { 'X-Loop-Token': String(process.env.SERENTIA_LOOP_TOKEN).trim(), 'Content-Type': 'application/json' } })
      if (!r.ok) throw new Error(`Serentia Loop HTTP ${r.status}`)
      const json = await r.json()
      for (const sub of json.data || []) {
        subs += 1
        const day = Math.max(0, Math.floor((Number(sub.nextBillingDateEpoch || now) - now) / 86400))
        for (const l of sub.lines || []) {
          const t = lineTitle(l)
          const q = Number(l.quantity || 0) || 1
          if (!t) untitled += q
          const key = t || '(no title)'
          byTitle[key] = (byTitle[key] || 0) + q
          ;(byTitleDays[key] ||= {})[day] = (byTitleDays[key][day] || 0) + q
          units += q
        }
      }
      pages += 1
      if (!json.pageInfo?.hasNextPage) break
      cursor = json.pageInfo.nextCursor
      await new Promise((res) => setTimeout(res, 1600))
    }
    return { subscriptions: subs, units, byTitle, byTitleDays, untitled, truncated: pages >= 20 }
  })
}

// ---------- Loop renewals pasted from the Loop admin (until the token exists) ----------
// Takes rows copied from Loop admin > Subscriptions (Status: Active), or lines
// like "November 21, 2026 · Elixir+ CC Cream - Buff Beige x 1". Each item is
// dated by the last date before it: Loop rows read Created on, Next order
// date, Items, so that is the next order date.
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December'
const TOKEN = new RegExp(`(#\\d{8,})|((?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})|([^\\t\\n#$·|]*?\\S)\\s+-\\s+([A-Za-z][A-Za-z ]*?)\\s+x\\s*(\\d+)`, 'g')

export function parseLoopPaste(text) {
  const items = []
  const ids = new Set()
  let date = null
  for (const m of String(text || '').matchAll(TOKEN)) {
    if (m[1]) { ids.add(m[1]); continue }
    if (m[2]) { const d = new Date(m[2] + (m[2].includes(',') ? ' 12:00 UTC' : 'T12:00:00Z')); if (!isNaN(d)) date = d.toISOString().slice(0, 10); continue }
    if (!date) continue
    const product = m[3].trim()
    items.push({ date, product, shade: shadeName(m[4]), qty: Number(m[5]) })
  }
  return { items, subscriptions: ids.size || null }
}

const RENEW_KEY = 'ser_manual_renewals'
export async function manualRenewals() {
  await ensureInnaderm()
  return (await cacheGet(RENEW_KEY, 1e12))?.value || null
}
export async function saveManualRenewals({ text }, actor) {
  await ensureInnaderm()
  const parsed = parseLoopPaste(text)
  if (!parsed.items.length) throw new Error('No subscription items found. Paste the Loop rows (with the next order date and the items column).')
  const value = { ...parsed, savedAt: new Date().toISOString(), by: actor }
  await cacheSet(RENEW_KEY, value)
  await logEvent(actor, 'serentia_renewals_pasted', { items: parsed.items.length, subscriptions: parsed.subscriptions })
  return value
}
export async function clearManualRenewals(actor) {
  await ensureInnaderm()
  await cacheSet(RENEW_KEY, null)
  await logEvent(actor, 'serentia_renewals_cleared', {})
}
// Turn dated items into the shape loopRenewals() returns, relative to today.
export function renewalsFromItems(m, now = Date.now()) {
  const today = new Date(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
  const byTitle = {}, byTitleDays = {}
  let units = 0, monthly = 0
  for (const it of m.items || []) {
    monthly += it.qty
    const day = Math.round((Date.parse(it.date + 'T00:00:00Z') - today) / 86400e3)
    if (day < 0 || day > 29) continue
    const key = `${it.product} / ${it.shade}`
    byTitle[key] = (byTitle[key] || 0) + it.qty
    ;(byTitleDays[key] ||= {})[day] = (byTitleDays[key][day] || 0) + it.qty
    units += it.qty
  }
  return { subscriptions: m.subscriptions, units, monthly, byTitle, byTitleDays, manual: true, snapshot: !!m.snapshot, savedAt: m.savedAt, by: m.by }
}

// ---------- the page ----------
const safe = (p) => p.catch((e) => ({ error: String(e?.message || e).slice(0, 240) }))
const DAY = 86400e3

// Units per item sold, read from the variant title: "Buy 2 Get 1" = 3,
// "2 Pack" / "x2" = 2, otherwise 1.
export function tubesIn(title) {
  const t = String(title || '').toLowerCase()
  let m = t.match(/buy\s*(\d+)\s*(?:get|\+)\s*(\d+)/)
  if (m) return Number(m[1]) + Number(m[2])
  m = t.match(/(\d+)\s*(?:pack|pcs|tubes|x\b)|x\s*(\d+)\b/)
  if (m) return Number(m[1] || m[2])
  return 1
}

// ---------- Sales pasted from a Shopify report (until the app keys exist) ----------
// Accepts a Shopify Analytics CSV export ("Total sales by product", or the
// same report split by product variant) or plain lines like "Ivory 120".
// Every Elixir+ listing draws on the same Zendrop stock (CC Cream, Glow
// Rewind, Calm & Cover, offer and Black Friday pages are the same compacts), so
// they are added together. Brush and Hydra-Prep are left out.
const CREAM_PRODUCT = /elixir|cc cream|bb cream|calm\s*&\s*cover|glow rewind/i
const NOT_CREAM = /brush|hydra|gift card|shipping|protection/i
const intOf = (v) => { const t = String(v ?? '').replace(/[,\s]/g, ''); return /^-?\d+$/.test(t) ? Number(t) : null }

export function parseSalesPaste(text, shadeNames) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim())
  const split = (l) => (l.includes('\t') ? l.split('\t') : l.includes(',') ? (parseCsv(l)[0] || []) : [l])
  const rows = lines.map(split)
  const head = rows[0].map((c) => String(c).trim().toLowerCase())
  const hasHead = head.some((h) => /items sold|quantity|units/.test(h))
  const qtyCol = hasHead ? head.findIndex((h) => /net items sold|net quantity/.test(h)) >= 0 ? head.findIndex((h) => /net items sold|net quantity/.test(h)) : head.findIndex((h) => /items sold|quantity|units/.test(h)) : -1
  const textCols = hasHead ? head.map((h, i) => (/product title|variant title|^variant|^product$|title|sku/.test(h) ? i : -1)).filter((i) => i >= 0) : []
  const hasVariant = hasHead && head.some((h) => /variant/.test(h))
  const shades = [...shadeNames].sort((a, b) => b.length - a.length)
  const byShade = {}, matched = [], skipped = []
  let creamTotal = 0
  for (const r of hasHead ? rows.slice(1) : rows) {
    const label = (textCols.length ? textCols.map((i) => r[i]).filter(Boolean).join(' / ') : r.join(' ')).trim()
    let qty = qtyCol >= 0 ? intOf(r[qtyCol]) : null
    if (qty == null && !hasHead) { const m = label.match(/(-?\d[\d,]*)\s*$/); qty = m ? intOf(m[1]) : null }
    if (qty == null || !label) { skipped.push(label || r.join(' ')); continue }
    const name = hasHead ? label : label.replace(/(-?\d[\d,]*)\s*$/, '').trim()
    const shade = shades.find((sh) => name.toLowerCase().includes(sh.toLowerCase()))
    const cream = !NOT_CREAM.test(name) && (CREAM_PRODUCT.test(name) || !!shade)
    if (!cream) { skipped.push(name); continue }
    const tubes = qty * tubesIn(name)
    creamTotal += tubes
    if (shade) byShade[shade] = (byShade[shade] || 0) + tubes
    matched.push({ label: name, qty, tubes, shade: shade || null })
  }
  const shadeLevel = Object.keys(byShade).length > 0
  return { byShade, creamTotal, shadeLevel, hasVariantColumn: hasVariant, matched, skipped }
}

const MANUAL_KEY = 'ser_manual_sales'
export async function manualSales() {
  await ensureInnaderm()
  return (await cacheGet(MANUAL_KEY, 1e12))?.value || null
}
export async function saveManualSales({ text, days, period }, actor) {
  await ensureInnaderm()
  const n = Math.round(Number(days))
  if (!(n >= 1 && n <= 366)) throw new Error('Days must be between 1 and 366')
  const inv = await zendropInventory().catch(() => null)
  const names = new Set((inv?.rows || []).filter(isCream).map((r) => shadeName(r.variant)))
  for (const d of ['Ivory', 'Buff Beige', 'Warm Honey', 'Honey Almond', 'Caramel Glow', 'Deep Mocha', 'Hazelnut']) names.add(d)
  const parsed = parseSalesPaste(text, names)
  if (!parsed.matched.length) throw new Error('No Elixir+ rows found. Paste the report rows (or lines like "Ivory 120").')
  const value = { days: n, period: String(period || '').slice(0, 60) || null, ...parsed, savedAt: new Date().toISOString(), by: actor }
  await cacheSet(MANUAL_KEY, value)
  await logEvent(actor, 'serentia_sales_pasted', { days: n, creamTotal: parsed.creamTotal, shadeLevel: parsed.shadeLevel })
  return value
}
export async function clearManualSales(actor) {
  await ensureInnaderm()
  await cacheSet(MANUAL_KEY, null)
  await logEvent(actor, 'serentia_sales_cleared', {})
}

// Elixir+ Cream rows: the original listing (product 3064479) and the "Kanary
// new product" listing whose SKUs read 3373424_3064479-<Shade>. Stock moved to
// the Kanary rows in Oct 2026, so each shade is the sum of both.
export const isCream = (r) => !!r.variant && !/default title/i.test(r.variant) && (/3064479/.test(r.sku) || /elixir/i.test(r.product))
const shadeKey = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ')
const shadeName = (v) => String(v || '').trim().replace(/\s+/g, ' ').replace(/(^|\s)([a-z])/g, (m, a, b) => a + b.toUpperCase())

export function plan(rows, sales, s = SETTINGS, now = Date.now(), loop = null, dm = null) {
  const F = demandFactors(dm, now)
  const throughIdx = dm?.through ? Math.round((Date.parse(dm.through + 'T00:00:00Z') - Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z')) / DAY) + 1 : null
  const groups = new Map()
  const others = []
  for (const r of rows) {
    // "Inventory Count" is the column Zendrop keeps visible and current; the
    // hidden "Inventory (ZD App)" column is only a fallback.
    const count = r.counted ?? r.zdApp
    if (!isCream(r)) { if (count != null) others.push({ product: r.product, variant: r.variant.replace(/^\/\s*/, ''), sku: r.sku, count, updated: r.updated }); continue }
    const k = shadeKey(r.variant)
    if (!groups.has(k)) groups.set(k, { variant: shadeName(r.variant), parts: [], leadDays: null, moq: null, updated: null })
    const g = groups.get(k)
    g.parts.push({ product: r.product, sku: r.sku, count })
    if (r.leadDays != null) g.leadDays = r.leadDays
    if (r.moq != null) g.moq = r.moq
    if (r.updated && (!g.updated || r.updated > g.updated)) g.updated = r.updated
  }
  const shades = [...groups.values()].map((g) => {
    const net = g.parts.reduce((a, p) => a + (p.count || 0), 0)
    const onHand = Math.max(0, net)
    const oversold = net < 0 ? -net : 0
    let sold = null
    if (sales && !sales.error && sales.byShade) {
      if (sales.shadeLevel) sold = sales.byShade[g.variant] || 0
    } else if (sales && !sales.error) {
      sold = 0
      for (const [title, qty] of Object.entries(sales.byTitle)) {
        if (shadeKey(title).includes(shadeKey(g.variant))) sold += qty * tubesIn(title)
      }
    }
    const lead = g.leadDays ?? 10
    const point = lead + s.safetyDays
    // Loop: units promised to subscribers in the next 30 days, and the part due
    // before a reorder placed today could land (lead time).
    let renew30 = null, renewBeforeRestock = null
    if (loop && !loop.error) {
      renew30 = 0; renewBeforeRestock = 0
      for (const [title, q] of Object.entries(loop.byTitle || {})) {
        if (!shadeKey(title).includes(shadeKey(g.variant))) continue
        const per = tubesIn(title)
        renew30 += q * per
        for (const [d, n] of Object.entries(loop.byTitleDays?.[title] || {})) if (Number(d) <= lead) renewBeforeRestock += n * per
      }
    }
    let rate = sold != null ? sold / sales.days : null
    let rateFrom = rate != null ? (sales.byShade ? 'manual' : 'shopify') : null
    // Renewals alone are a floor on demand: use them when sales are missing or lower.
    if (renew30 != null && renew30 > 0 && (rate == null || renew30 / 30 > rate)) { rate = renew30 / 30; rateFrom = 'loop' }
    // Days of cover follow the planned demand (campaign uplift, Black Friday), not a flat rate.
    const cover = coverDays(onHand, rate, F)
    const needThrough = rate != null && throughIdx > 0 ? Math.ceil(sumDemand(rate, F, 0, throughIdx) + oversold) : null
    const shortThrough = needThrough != null ? Math.max(0, needThrough - onHand) : null
    let status = 'unknown'
    if (onHand <= 0) status = 'out'
    else if (cover != null) status = cover <= point ? 'reorder' : cover <= point + s.soonDays ? 'soon' : 'ok'
    else if (rate === 0) status = 'ok' // stock but no sales in the window
    // Subscribers due before a new batch could land need more than is on hand.
    if (renewBeforeRestock != null && renewBeforeRestock > onHand && status !== 'out') status = 'reorder'
    const reorderBy = cover != null ? new Date(now + Math.max(0, cover - point) * DAY).toISOString() : null
    const runsOut = cover != null ? new Date(now + cover * DAY).toISOString() : null
    // Oversold units are owed to customers already, so they are added to the order.
    const need = rate != null ? Math.max(0, Math.ceil((sumDemand(rate, F, 0, point + s.targetDays) - onHand + oversold) / 100) * 100) : null
    // Short of the Q4 need even if not yet at the reorder point: order the gap.
    if (shortThrough > 0 && status === 'ok') status = 'soon'
    return { variant: g.variant, parts: g.parts, leadDays: lead, moq: g.moq, updated: g.updated, onHand, oversold, sold, rate, rateSource: rateFrom, renew30, renewBeforeRestock, cover, needThrough, shortThrough, status, reorderBy, runsOut, suggest: ['out', 'reorder', 'soon'].includes(status) ? Math.max(need || 0, shortThrough ? Math.ceil(shortThrough / 100) * 100 : 0) : 0 }
  })
  const order = { out: 0, reorder: 1, soon: 2, unknown: 3, ok: 4 }
  shades.sort((a, b) => order[a.status] - order[b.status] || (b.oversold - a.oversold) || (a.cover ?? 1e9) - (b.cover ?? 1e9) || a.onHand - b.onHand)
  const suggestTotal = shades.reduce((a, x) => a + (x.suggest || 0), 0)
  const moq = shades.find((x) => x.moq)?.moq ?? null
  return {
    shades,
    others,
    demand: dm,
    totals: { needThrough: shades.every((x) => x.needThrough != null) && shades.length ? shades.reduce((a, x) => a + x.needThrough, 0) : null, shortThrough: shades.reduce((a, x) => a + (x.shortThrough || 0), 0), renew30: loop && !loop.error ? shades.reduce((a, x) => a + (x.renew30 || 0), 0) : null, subscriptions: loop && !loop.error ? loop.subscriptions : null, onHand: shades.reduce((a, x) => a + x.onHand, 0), oversold: shades.reduce((a, x) => a + x.oversold, 0), rate: shades.length && shades.every((x) => x.rate != null) ? shades.reduce((a, x) => a + x.rate, 0) : sales?.byShade && sales.creamTotal ? sales.creamTotal / sales.days : null, suggest: suggestTotal, moq, belowMoq: moq != null && suggestTotal > 0 && suggestTotal < moq },
    updated: rows.map((r) => r.updated).filter(Boolean).sort().pop() || null,
  }
}

export async function stockOverview() {
  await ensureInnaderm()
  const [inv, live, manual, loop, dm] = await Promise.all([
    safe(zendropInventory()),
    shopifyConfigured() ? safe(shopifySales(SETTINGS.baselineDays)) : Promise.resolve(null),
    shopifyConfigured() ? Promise.resolve(null) : manualSales().catch(() => null),
    loopConfigured() ? safe(loopRenewals()) : manualRenewals().then((m) => renewalsFromItems(m || LOOP_SNAPSHOT)).catch(() => renewalsFromItems(LOOP_SNAPSHOT)),
    demandSettings().catch(() => ({ ...DEMAND_DEFAULTS })),
  ])
  // Live Shopify sales win; pasted report numbers fill in until the keys exist.
  const sales = live || manual
  const p = inv && !inv.error ? plan(inv.rows, sales, SETTINGS, Date.now(), loop, dm) : null
  return {
    generatedAt: new Date().toISOString(),
    settings: SETTINGS,
    sources: {
      zendrop: { sheetId: SETTINGS.sheetId, cachedAt: inv?.cachedAt || null, stale: !!inv?.stale, error: inv?.error || null },
      shopify: { configured: shopifyConfigured(), store: shopifyStore() || null, orders: live?.orders ?? null, truncated: !!live?.truncated, error: live?.error || null },
      loop: { configured: loopConfigured() || !!loop?.manual, manual: !!loop?.manual, snapshot: !!loop?.snapshot, savedAt: loop?.savedAt || null, by: loop?.by || null, monthly: loop?.monthly ?? null, subscriptions: loop?.subscriptions ?? null, units: loop?.units ?? null, untitled: loop?.untitled || 0, truncated: !!loop?.truncated, cachedAt: loop?.cachedAt || null, error: loop?.error || null },
      manual: manual ? { days: manual.days, period: manual.period, savedAt: manual.savedAt, by: manual.by, creamTotal: manual.creamTotal, shadeLevel: manual.shadeLevel, matched: manual.matched, skipped: manual.skipped } : null,
    },
    ...(p || { shades: [], others: [], totals: null, updated: null, demand: dm }),
  }
}
