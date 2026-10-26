import { parseCsv } from '../csv'
import { cached, ensureInnaderm } from '../innaderm/db'

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
  const hi = rows.findIndex((r) => r.some((c) => /^variant$/i.test(String(c).trim())) && r.some((c) => /inventory \(zd app\)/i.test(String(c))))
  if (hi < 0) throw new Error('Inventory tab: header row not found (expected "Variant" and "Inventory (ZD App)")')
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
    if (String(get('product')).trim()) carry = { product: String(get('product')).trim(), moq: num(get('moq')), lead: days(get('lead')) }
    else { if (num(get('moq')) != null) carry.moq = num(get('moq')); if (days(get('lead')) != null) carry.lead = days(get('lead')) }
    const variant = String(get('variant')).trim()
    if (!variant) continue
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
  return cached('ser_zd_inventory_v1_' + sheetId, 900, async () => {
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
// variant that ships three tubes is counted once unless its title says so,
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

// ---------- the page ----------
const safe = (p) => p.catch((e) => ({ error: String(e?.message || e).slice(0, 240) }))
const DAY = 86400e3

// Tubes per unit sold, read from the variant title: "Buy 2 Get 1" = 3,
// "2 Pack" / "x2" = 2, otherwise 1.
export function tubesIn(title) {
  const t = String(title || '').toLowerCase()
  let m = t.match(/buy\s*(\d+)\s*(?:get|\+)\s*(\d+)/)
  if (m) return Number(m[1]) + Number(m[2])
  m = t.match(/(\d+)\s*(?:pack|pcs|tubes|x\b)|x\s*(\d+)\b/)
  if (m) return Number(m[1] || m[2])
  return 1
}

export function plan(rows, sales, s = SETTINGS, now = Date.now()) {
  const shades = rows.map((r) => {
    const onHand = r.zdApp ?? 0
    let sold = null
    if (sales && !sales.error) {
      sold = 0
      for (const [title, qty] of Object.entries(sales.byTitle)) {
        if (title.toLowerCase().includes(r.variant.toLowerCase())) sold += qty * tubesIn(title)
      }
    }
    const rateShopify = sold != null ? sold / sales.days : null
    const rateZendrop = r.zdDaysLeft > 0 && onHand > 0 ? onHand / r.zdDaysLeft : null
    const rate = rateShopify ?? rateZendrop
    const lead = r.leadDays ?? 10
    const point = lead + s.safetyDays
    const cover = rate > 0 ? onHand / rate : null
    let status = 'unknown'
    if (onHand <= 0) status = 'out'
    else if (cover != null) status = cover <= point ? 'reorder' : cover <= point + s.soonDays ? 'soon' : 'ok'
    else if (rate === 0) status = 'ok' // stock but no sales in the window
    const reorderBy = cover != null ? new Date(now + Math.max(0, cover - point) * DAY).toISOString() : null
    const runsOut = cover != null ? new Date(now + cover * DAY).toISOString() : null
    const need = rate != null ? Math.max(0, Math.ceil((rate * (point + s.targetDays) - onHand) / 100) * 100) : null
    const mismatch = r.sumai != null && r.zdApp != null && r.sumai !== r.zdApp
    return { ...r, onHand, sold, rateShopify, rateZendrop, rate, rateSource: rateShopify != null ? 'shopify' : rateZendrop != null ? 'zendrop' : null, cover, status, reorderBy, runsOut, suggest: ['out', 'reorder', 'soon'].includes(status) ? need : 0, mismatch }
  })
  const order = { out: 0, reorder: 1, soon: 2, unknown: 3, ok: 4 }
  shades.sort((a, b) => order[a.status] - order[b.status] || (a.cover ?? 1e9) - (b.cover ?? 1e9))
  const suggestTotal = shades.reduce((a, x) => a + (x.suggest || 0), 0)
  const moq = rows.find((r) => r.moq)?.moq ?? null
  return {
    shades,
    totals: { onHand: shades.reduce((a, x) => a + x.onHand, 0), rate: shades.every((x) => x.rate != null) ? shades.reduce((a, x) => a + x.rate, 0) : null, suggest: suggestTotal, moq, belowMoq: moq != null && suggestTotal > 0 && suggestTotal < moq },
    updated: rows.map((r) => r.updated).filter(Boolean).sort().pop() || null,
  }
}

export async function stockOverview() {
  await ensureInnaderm()
  const [inv, sales] = await Promise.all([
    safe(zendropInventory()),
    shopifyConfigured() ? safe(shopifySales(SETTINGS.baselineDays)) : Promise.resolve(null),
  ])
  const p = inv && !inv.error ? plan(inv.rows, sales) : null
  return {
    generatedAt: new Date().toISOString(),
    settings: SETTINGS,
    sources: {
      zendrop: { sheetId: SETTINGS.sheetId, cachedAt: inv?.cachedAt || null, stale: !!inv?.stale, error: inv?.error || null },
      shopify: { configured: shopifyConfigured(), store: shopifyStore() || null, orders: sales?.orders ?? null, truncated: !!sales?.truncated, error: sales?.error || null },
    },
    ...(p || { shades: [], totals: null, updated: null }),
  }
}
