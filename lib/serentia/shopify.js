import { q } from '../db'
import { cached, cacheGet, cacheSet, ensureSerentia } from './db'

// Shopify Admin GraphQL. Two ways to authenticate, both set in Vercel and
// never in the repo:
// - SERENTIA_SHOPIFY_CLIENT_ID + SERENTIA_SHOPIFY_CLIENT_SECRET: an app made
//   in Shopify's Dev Dashboard (the only option for new apps since 1 Jan
//   2026). Its access token comes from the client credentials grant and
//   expires after about 24h, so it is fetched on demand and cached.
// - SERENTIA_SHOPIFY_TOKEN: a permanent shpat_ token from a legacy custom app
//   created in the store admin before 2026. Used as-is when set.
// Scopes needed: read_orders, read_fulfillments, read_products,
// read_inventory, read_locations.
const API_VERSION = '2026-01'
const BACKFILL_DAYS = 120
// Orders carry their line items here (stock is per shade), so a page is
// smaller than Innaderm's to keep each query under Shopify's cost limit.
const PAGE = 30
const LINES = 8
const TOKEN_CACHE_KEY = 'shopify_access_token'
const TOKEN_MARGIN_MS = 10 * 60e3 // refresh 10 minutes before expiry

// No default store: SERENTIA_SHOPIFY_STORE (the xxx.myshopify.com name) is
// required, so a missing setting can never read another brand's store.
export function store() {
  return String(process.env.SERENTIA_SHOPIFY_STORE || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}
function hasClientCredentials() {
  return !!(process.env.SERENTIA_SHOPIFY_CLIENT_ID && process.env.SERENTIA_SHOPIFY_CLIENT_SECRET)
}
export function configured() {
  return !!store() && (!!process.env.SERENTIA_SHOPIFY_TOKEN || hasClientCredentials())
}
export function authMode() {
  if (process.env.SERENTIA_SHOPIFY_TOKEN) return 'static token'
  if (hasClientCredentials()) return 'client credentials'
  return 'none'
}

// Kept per serverless instance and in ser_cache so instances share a token
// instead of each requesting their own.
let memToken = null
async function requestToken() {
  // Form-encoded as in Shopify's client credentials tutorial (and RFC 6749);
  // trimmed because a space or newline pasted into Vercel reads as an
  // invalid secret.
  const r = await fetch(`https://${store()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SERENTIA_SHOPIFY_CLIENT_ID.trim(),
      client_secret: process.env.SERENTIA_SHOPIFY_CLIENT_SECRET.trim(),
    }),
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  if (!r.ok || !json?.access_token) throw new Error(`Shopify token HTTP ${r.status}: ${text.slice(0, 160)}`)
  const ttlMs = Number(json.expires_in || 86400) * 1000
  return { token: json.access_token, expiresAt: Date.now() + ttlMs }
}
const usable = (t) => t && t.token && t.expiresAt - TOKEN_MARGIN_MS > Date.now()

async function accessToken({ force = false } = {}) {
  if (process.env.SERENTIA_SHOPIFY_TOKEN) return process.env.SERENTIA_SHOPIFY_TOKEN
  if (!hasClientCredentials()) return ''
  if (!force && usable(memToken)) return memToken.token
  await ensureSerentia()
  if (!force) {
    const hit = (await cacheGet(TOKEN_CACHE_KEY, 1e12))?.value
    if (usable(hit)) { memToken = hit; return hit.token }
  }
  memToken = await requestToken()
  await cacheSet(TOKEN_CACHE_KEY, memToken)
  return memToken.token
}

async function post(query, variables, token) {
  return fetch(`https://${store()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  })
}

export async function gql(query, variables = {}) {
  let r = await post(query, variables, await accessToken())
  // A cached client-credentials token can be revoked early (app reinstalled,
  // secret rotated): fetch a new one once and retry.
  if (r.status === 401 && !process.env.SERENTIA_SHOPIFY_TOKEN && hasClientCredentials()) {
    r = await post(query, variables, await accessToken({ force: true }))
  }
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  if (!r.ok || !json) throw new Error(`Shopify HTTP ${r.status}: ${text.slice(0, 160)}`)
  if (json.errors?.length) throw new Error('Shopify: ' + json.errors.map((e) => e.message).join('; ').slice(0, 300))
  return json
}

const ORDERS_QUERY = `
query Orders($q: String!, $after: String) {
  orders(first: ${PAGE}, query: $q, sortKey: UPDATED_AT, reverse: true, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt updatedAt cancelledAt tags sourceName
      displayFinancialStatus displayFulfillmentStatus
      subtotalLineItemsQuantity
      currentTotalPriceSet { shopMoney { amount } }
      shippingAddress { countryCodeV2 }
      app { name }
      fulfillments(first: 3) {
        createdAt deliveredAt inTransitAt displayStatus status
        trackingInfo(first: 1) { company number }
      }
      lineItems(first: ${LINES}) { nodes { id quantity sku title variantTitle variant { id } } }
    }
  }
}`

const gidNum = (gid) => Number(String(gid).split('/').pop())

// Loop Subscriptions places renewal orders through the Shopify subscriptions
// API and tags them; a first subscription order comes through checkout like a
// normal order. Both flags are kept so demand can be split into "renewals"
// (committed) and "new orders" (run rate).
function classify(o) {
  const tags = (o.tags || []).map((t) => String(t).toLowerCase())
  const app = String(o.app?.name || '').toLowerCase()
  const src = String(o.sourceName || '').toLowerCase()
  const recurring = tags.some((t) => /recurring|renewal/.test(t)) || src === 'subscription_contract'
  const subscription = recurring || tags.some((t) => /subscri/.test(t)) || /loop/.test(app)
  return { recurring, subscription }
}

function rowFrom(o) {
  const fs = (o.fulfillments || []).filter((f) => f.status !== 'CANCELLED' && f.status !== 'FAILURE' && f.status !== 'ERROR')
  fs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  const first = fs[0]
  const delivered = fs.map((f) => f.deliveredAt).filter(Boolean).sort().pop() || null
  const transit = fs.map((f) => f.inTransitAt).filter(Boolean).sort()[0] || null
  const latest = fs[fs.length - 1]
  const { recurring, subscription } = classify(o)
  return [
    gidNum(o.id), o.name, o.createdAt, o.updatedAt, o.cancelledAt, o.displayFinancialStatus, o.displayFulfillmentStatus,
    Number(o.currentTotalPriceSet?.shopMoney?.amount || 0), Number(o.subtotalLineItemsQuantity || 0),
    recurring, subscription, first?.createdAt || null, transit, delivered, latest?.displayStatus || null,
    latest?.trackingInfo?.[0]?.company || null, latest?.trackingInfo?.[0]?.number || null,
    o.shippingAddress?.countryCodeV2 || null,
  ]
}

async function upsert(rows) {
  if (!rows.length) return
  const cols = ['id', 'name', 'created_at', 'updated_at', 'cancelled_at', 'financial', 'fulfill_status', 'total', 'units',
    'is_recurring', 'is_subscription', 'first_fulfilled_at', 'in_transit_at', 'delivered_at', 'display',
    'tracking_company', 'tracking_number', 'country']
  const values = []
  const params = []
  rows.forEach((r, i) => {
    values.push('(' + r.map((_, j) => '$' + (i * cols.length + j + 1)).join(',') + ')')
    params.push(...r)
  })
  const update = cols.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')
  await q(`INSERT INTO ser_orders (${cols.join(',')}) VALUES ${values.join(',')} ON CONFLICT (id) DO UPDATE SET ${update}`, params)
}

// Line items per order, replaced wholesale on every sync of that order so an
// edited order never keeps a removed line.
function linesFrom(o) {
  return (o.lineItems?.nodes || []).map((l) => [
    gidNum(l.id), gidNum(o.id), l.variant?.id ? gidNum(l.variant.id) : null, Number(l.quantity || 0),
    String(l.title || '').slice(0, 200), String(l.variantTitle || '').slice(0, 200), String(l.sku || '').slice(0, 120),
  ])
}
async function upsertLines(orders) {
  if (!orders.length) return
  await q('DELETE FROM ser_order_lines WHERE order_id = ANY($1::bigint[])', [orders.map((o) => gidNum(o.id))])
  const rows = orders.flatMap(linesFrom)
  if (!rows.length) return
  const cols = ['id', 'order_id', 'variant_id', 'qty', 'title', 'variant_title', 'sku']
  const values = []
  const params = []
  rows.forEach((r, i) => {
    values.push('(' + r.map((_, j) => '$' + (i * cols.length + j + 1)).join(',') + ')')
    params.push(...r)
  })
  await q(`INSERT INTO ser_order_lines (${cols.join(',')}) VALUES ${values.join(',')} ON CONFLICT (id) DO NOTHING`, params)
}

// Incremental sync. First run walks the last 120 days by updated_at, newest
// first so the recent days the board leads with fill in on the first call;
// later runs resume from the newest updated_at seen minus an hour of slack.
// Bounded to a few pages per call so a request never runs long - the client
// keeps calling /api/serentia/sync until `complete` is true.
export async function syncOrders({ maxPages = 8 } = {}) {
  await ensureSerentia()
  if (!configured()) return { configured: false, complete: true, fetched: 0 }
  const state = (await cacheGet('shopify_orders_sync', 1e12))?.value || {}
  // The backfill's start is fixed on its first call and kept with the cursor:
  // recomputing "120 days ago" each call moved it by a few seconds, so the
  // saved cursor never matched and every call restarted from page one.
  const since = state.lastUpdatedAt
    ? new Date(new Date(state.lastUpdatedAt).getTime() - 3600e3)
    : state.cursorSince && state.cursorOrder === 'desc' ? new Date(state.cursorSince)
    : new Date(Date.now() - BACKFILL_DAYS * 86400e3)
  // A cursor saved by the old oldest-first walk does not fit the newest-first
  // order, so only a 'desc' cursor resumes. The newest updated_at is on the
  // first page, so it is carried across calls until the walk completes.
  const resume = !!state.cursor && state.cursorSince === since.toISOString() && state.cursorOrder === 'desc'
  let after = resume ? state.cursor : null
  const query = `updated_at:>='${since.toISOString()}'`
  let fetched = 0, pages = 0, newest = (resume && state.newestSeen) || state.lastUpdatedAt || null, hasNext = true
  while (hasNext && pages < maxPages) {
    const json = await gql(ORDERS_QUERY, { q: query, after })
    const conn = json.data.orders
    const rows = conn.nodes.map(rowFrom)
    await upsert(rows)
    await upsertLines(conn.nodes)
    for (const o of conn.nodes) if (!newest || o.updatedAt > newest) newest = o.updatedAt
    fetched += rows.length
    pages += 1
    hasNext = conn.pageInfo.hasNextPage
    after = conn.pageInfo.endCursor
    const t = json.extensions?.cost?.throttleStatus
    if (hasNext && t && t.currentlyAvailable < (json.extensions.cost.requestedQueryCost || 500)) {
      // wait for the leaky bucket instead of tripping THROTTLED
      const wait = Math.min(8000, ((json.extensions.cost.requestedQueryCost - t.currentlyAvailable) / (t.restoreRate || 50)) * 1000 + 200)
      await new Promise((res) => setTimeout(res, wait))
    }
  }
  const complete = !hasNext
  await cacheSet('shopify_orders_sync', {
    lastUpdatedAt: complete ? newest : state.lastUpdatedAt || null,
    cursor: complete ? null : after,
    cursorSince: complete ? null : since.toISOString(),
    cursorOrder: complete ? null : 'desc',
    newestSeen: complete ? null : newest,
    lastRunAt: new Date().toISOString(),
    backfilled: complete ? true : !!state.backfilled,
    lastFetched: fetched,
  })
  return { configured: true, complete, fetched, pages }
}

export async function syncState() {
  const s = (await cacheGet('shopify_orders_sync', 1e12))?.value || null
  const n = (await q('SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest FROM ser_orders'))[0]
  return { ...(s || {}), orders: n.n, oldest: n.oldest ? new Date(n.oldest).toISOString() : null }
}

const VARIANTS_QUERY = `
query Variants($after: String) {
  productVariants(first: 100, after: $after, query: "product_status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title sku displayName inventoryQuantity
      product { id title }
      inventoryItem { tracked unitCost { amount } }
    }
  }
}`

// Finished goods as Shopify sees them: every tracked variant on an active
// product. Cached for 10 minutes.
export function inventory() {
  return cached('shopify_inventory', 600, async () => {
    const variants = []
    let after = null
    for (let i = 0; i < 5; i++) {
      const json = await gql(VARIANTS_QUERY, { after })
      const conn = json.data.productVariants
      for (const v of conn.nodes) {
        variants.push({
          id: String(gidNum(v.id)), title: v.displayName || v.title, sku: v.sku || '', product: v.product?.title || '',
          onHand: Number(v.inventoryQuantity || 0), tracked: !!v.inventoryItem?.tracked,
          unitCost: v.inventoryItem?.unitCost?.amount ? Number(v.inventoryItem.unitCost.amount) : null,
        })
      }
      if (!conn.pageInfo.hasNextPage) break
      after = conn.pageInfo.endCursor
    }
    return { variants }
  })
}
