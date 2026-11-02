import { q } from '../db'
import { cacheGet, cacheSet, ensureInnaderm } from './db'
import { gql } from './shopify'

// Refund, exchange/replacement and dispute rates by month since the store's
// first order (Calvin, 26 Oct: Khethiwe takes over refund approvals and is
// measured on bringing these down; Shopify holds payouts at a 1% dispute rate).
//
// Kept apart from the main order sync on purpose: it walks the whole order
// history (not 120 days) with a light query, and reads disputes from Shopify
// Payments, which needs a scope the app may not have. Any failure here is
// stored and shown on the cards; it never stops the orders the rest of the
// board depends on.

const PAGE = 100
const ORDERS_QUERY = `
query KpiOrders($after: String) {
  orders(first: ${PAGE}, sortKey: CREATED_AT, reverse: true, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id createdAt cancelledAt tags
      totalPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      refunds(first: 3) { createdAt }
    }
  }
}`

// Disputes come from Shopify Payments (scope read_shopify_payments_disputes).
const DISPUTES_QUERY = `
query KpiDisputes($after: String) {
  shopifyPaymentsAccount {
    disputes(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id initiatedAt status type reasonDetails { reason } amount { amount } order { id } }
    }
  }
}`

// A replacement or exchange shows up as a $0 order or an order tagged for it.
const REPLACEMENT_TAG = /replace|exchange|reship|resend|re-send/i

const gidNum = (gid) => (gid ? Number(String(gid).split('/').pop()) : null)
const STATE = 'kpi_sync'

let ready
export function ensureKpi() {
  if (ready) return ready
  ready = (async () => {
    await ensureInnaderm()
    await q(`CREATE TABLE IF NOT EXISTS inn_order_kpi (
      id BIGINT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      cancelled_at TIMESTAMPTZ,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      refunded NUMERIC(12,2) NOT NULL DEFAULT 0,
      refunds INTEGER NOT NULL DEFAULT 0,
      first_refund_at TIMESTAMPTZ,
      replacement BOOLEAN NOT NULL DEFAULT false
    )`)
    await q(`CREATE INDEX IF NOT EXISTS idx_inn_order_kpi_created ON inn_order_kpi (created_at)`)
    await q(`CREATE TABLE IF NOT EXISTS inn_disputes (
      id TEXT PRIMARY KEY,
      order_id BIGINT,
      initiated_at TIMESTAMPTZ NOT NULL,
      status TEXT,
      type TEXT,
      reason TEXT,
      amount NUMERIC(12,2)
    )`)
  })()
  ready.catch(() => { ready = null })
  return ready
}

function rowFrom(o) {
  const total = Number(o.totalPriceSet?.shopMoney?.amount || 0)
  const refundDates = (o.refunds || []).map((r) => r.createdAt).filter(Boolean).sort()
  return [
    gidNum(o.id), o.createdAt, o.cancelledAt, total, Number(o.totalRefundedSet?.shopMoney?.amount || 0),
    (o.refunds || []).length, refundDates[0] || null,
    total === 0 || (o.tags || []).some((t) => REPLACEMENT_TAG.test(String(t))),
  ]
}

async function upsert(rows) {
  if (!rows.length) return
  const cols = ['id', 'created_at', 'cancelled_at', 'total', 'refunded', 'refunds', 'first_refund_at', 'replacement']
  const values = [], params = []
  rows.forEach((r, i) => { values.push('(' + r.map((_, j) => '$' + (i * cols.length + j + 1)).join(',') + ')'); params.push(...r) })
  await q(`INSERT INTO inn_order_kpi (${cols.join(',')}) VALUES ${values.join(',')}
    ON CONFLICT (id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`, params)
}

// One step of the walk. The full history is walked newest first; once done,
// a refresh re-walks only the last 120 days (refunds and cancellations land
// weeks after the order) at most every 6 hours. Disputes are re-read with it.
export async function syncKpi({ maxPages = 6 } = {}) {
  await ensureKpi()
  const st = (await cacheGet(STATE, 1e12))?.value || {}
  const refreshDue = st.complete && Date.now() - new Date(st.completedAt || 0).getTime() > 6 * 3600e3
  if (st.complete && !refreshDue) return { complete: true, error: st.error || null, disputes: st.disputes || null }
  const recentOnly = !!st.complete
  const sinceMs = Date.now() - 120 * 86400e3
  let after = st.complete ? null : st.cursor || null
  let pages = 0, fetched = 0, hasNext = true, error = null
  try {
    while (hasNext && pages < maxPages) {
      const json = await gql(ORDERS_QUERY, { after })
      const conn = json.data.orders
      await upsert(conn.nodes.map(rowFrom))
      fetched += conn.nodes.length
      pages += 1
      hasNext = conn.pageInfo.hasNextPage
      after = conn.pageInfo.endCursor
      // Newest first: on a refresh, stop once past the 120-day window.
      if (recentOnly && conn.nodes.length && new Date(conn.nodes[conn.nodes.length - 1].createdAt).getTime() < sinceMs) hasNext = false
      // Wait for Shopify's query-cost bucket instead of tripping THROTTLED.
      const t = json.extensions?.cost?.throttleStatus
      if (hasNext && t && t.currentlyAvailable < (json.extensions.cost.requestedQueryCost || 500)) {
        await new Promise((res) => setTimeout(res, Math.min(8000, ((json.extensions.cost.requestedQueryCost - t.currentlyAvailable) / (t.restoreRate || 50)) * 1000 + 200)))
      }
    }
  } catch (e) {
    error = String(e?.message || e).slice(0, 240)
  }
  const done = !hasNext && !error
  let disputes = st.disputes || null
  if (done) disputes = await syncDisputes()
  await cacheSet(STATE, {
    complete: done || !!st.complete, completedAt: done ? new Date().toISOString() : st.completedAt || null,
    cursor: done ? null : after, error, disputes, lastRunAt: new Date().toISOString(),
  })
  // An error ends this walk for now (the dashboard stops asking); the next
  // load picks it up from the saved cursor.
  return { complete: done || !!error, fetched, error, disputes }
}

async function syncDisputes() {
  try {
    let after = null, n = 0
    for (let page = 0; page < 20; page++) {
      const json = await gql(DISPUTES_QUERY, { after })
      const conn = json.data?.shopifyPaymentsAccount?.disputes
      if (!conn) return { ok: false, error: 'Shopify Payments is not available for this store' }
      for (const d of conn.nodes) {
        await q(`INSERT INTO inn_disputes (id, order_id, initiated_at, status, type, reason, amount) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, type = EXCLUDED.type, reason = EXCLUDED.reason, amount = EXCLUDED.amount`,
          [String(d.id), gidNum(d.order?.id), d.initiatedAt, d.status || null, d.type || null, d.reasonDetails?.reason || null, Number(d.amount?.amount || 0)])
        n++
      }
      if (!conn.pageInfo.hasNextPage) break
      after = conn.pageInfo.endCursor
    }
    return { ok: true, count: n, at: new Date().toISOString() }
  } catch (e) {
    const msg = String(e?.message || e)
    return { ok: false, error: /access|scope|denied|permission/i.test(msg) ? 'needs the read_shopify_payments_disputes permission on the Shopify app' : msg.slice(0, 200) }
  }
}

// Month by month, by the month the order was placed (a refund or dispute is
// counted against its order's month, which is how a dispute rate is judged).
export async function monthlyKpi() {
  await ensureKpi()
  const st = (await cacheGet(STATE, 1e12))?.value || null
  const months = await q(`
    WITH o AS (
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
             COUNT(*)::int AS orders,
             COUNT(*) FILTER (WHERE NOT replacement)::int AS paid_orders,
             COALESCE(SUM(total) FILTER (WHERE NOT replacement), 0) AS sales,
             COALESCE(SUM(refunded), 0) AS refunded,
             COUNT(*) FILTER (WHERE refunded > 0)::int AS refunded_orders,
             COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS cancelled,
             COUNT(*) FILTER (WHERE replacement)::int AS replacements
      FROM inn_order_kpi GROUP BY 1),
    d AS (
      -- A dispute counts in its order's month; one without a known order in
      -- the month it was opened.
      SELECT to_char(date_trunc('month', COALESCE(k.created_at, x.initiated_at)), 'YYYY-MM') AS month, COUNT(*)::int AS disputes
      FROM inn_disputes x LEFT JOIN inn_order_kpi k ON k.id = x.order_id GROUP BY 1)
    SELECT o.*, COALESCE(d.disputes, 0) AS disputes FROM o LEFT JOIN d USING (month) ORDER BY o.month`)
  return {
    sync: st ? { complete: !!st.complete, completedAt: st.completedAt || null, error: st.error || null, lastRunAt: st.lastRunAt || null } : null,
    disputes: st?.disputes || null,
    months: months.map((m) => ({
      month: m.month, orders: m.orders, paidOrders: m.paid_orders, sales: Number(m.sales), refunded: Number(m.refunded),
      refundedOrders: m.refunded_orders, cancelled: m.cancelled, replacements: m.replacements, disputes: m.disputes,
    })),
  }
}
