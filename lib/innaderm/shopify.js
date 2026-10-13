import { q } from '../db'
import { cached, cacheGet, cacheSet, ensureInnaderm } from './db'

// Shopify Admin GraphQL. The token is a custom-app Admin API token with
// read_orders, read_fulfillments, read_products, read_inventory and
// read_locations, set as INNADERM_SHOPIFY_TOKEN in Vercel. Never in the repo.
const API_VERSION = '2026-01'
const DEFAULT_STORE = 'f4f3a5-ad.myshopify.com' // innaderm.com
const BACKFILL_DAYS = 120
const PAGE = 100

export function store() {
  return (process.env.INNADERM_SHOPIFY_STORE || DEFAULT_STORE).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}
export function configured() {
  return !!process.env.INNADERM_SHOPIFY_TOKEN
}

export async function gql(query, variables = {}) {
  const r = await fetch(`https://${store()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.INNADERM_SHOPIFY_TOKEN || '' },
    body: JSON.stringify({ query, variables }),
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  if (!r.ok || !json) throw new Error(`Shopify HTTP ${r.status}: ${text.slice(0, 160)}`)
  if (json.errors?.length) throw new Error('Shopify: ' + json.errors.map((e) => e.message).join('; ').slice(0, 300))
  return json
}

const ORDERS_QUERY = `
query Orders($q: String!, $after: String) {
  orders(first: ${PAGE}, query: $q, sortKey: UPDATED_AT, after: $after) {
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
  await q(`INSERT INTO inn_orders (${cols.join(',')}) VALUES ${values.join(',')} ON CONFLICT (id) DO UPDATE SET ${update}`, params)
}

// Incremental sync. First run walks the last 120 days by updated_at; later
// runs resume from the newest updated_at seen minus an hour of slack. Bounded
// to a few pages per call so a request never runs long - the client keeps
// calling /api/innaderm/sync until `complete` is true.
export async function syncOrders({ maxPages = 4 } = {}) {
  await ensureInnaderm()
  if (!configured()) return { configured: false, complete: true, fetched: 0 }
  const state = (await cacheGet('shopify_orders_sync', 1e12))?.value || {}
  const since = state.lastUpdatedAt
    ? new Date(new Date(state.lastUpdatedAt).getTime() - 3600e3)
    : new Date(Date.now() - BACKFILL_DAYS * 86400e3)
  let after = state.cursor && state.cursorSince === since.toISOString() ? state.cursor : null
  const query = `updated_at:>='${since.toISOString()}'`
  let fetched = 0, pages = 0, newest = state.lastUpdatedAt || null, hasNext = true
  while (hasNext && pages < maxPages) {
    const json = await gql(ORDERS_QUERY, { q: query, after })
    const conn = json.data.orders
    const rows = conn.nodes.map(rowFrom)
    await upsert(rows)
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
    lastRunAt: new Date().toISOString(),
    backfilled: complete ? true : !!state.backfilled,
    lastFetched: fetched,
  })
  return { configured: true, complete, fetched, pages }
}

export async function syncState() {
  const s = (await cacheGet('shopify_orders_sync', 1e12))?.value || null
  const n = (await q('SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest FROM inn_orders'))[0]
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
