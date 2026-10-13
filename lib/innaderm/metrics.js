import { q } from '../db'

// Everything derived from inn_orders for a selectable period. Days are whole
// UTC days ending today; "prior" is the same length immediately before, for
// the deltas on the KPI tiles.
const OPEN_STATUSES = ['UNFULFILLED', 'PARTIALLY_FULFILLED', 'IN_PROGRESS', 'ON_HOLD', 'SCHEDULED', 'PENDING_FULFILLMENT', 'OPEN']

const num = (v) => (v == null ? null : Number(v))

function ageBuckets(rows, field) {
  const b = { '0-3 days': 0, '4-7 days': 0, '8-14 days': 0, '15+ days': 0 }
  const now = Date.now()
  for (const r of rows) {
    const d = (now - new Date(r[field]).getTime()) / 86400e3
    if (d <= 3) b['0-3 days']++
    else if (d <= 7) b['4-7 days']++
    else if (d <= 14) b['8-14 days']++
    else b['15+ days']++
  }
  return b
}

export async function fulfilment(days) {
  const since = new Date(Date.now() - days * 86400e3)
  const prior = new Date(since.getTime() - days * 86400e3)

  const [cur] = await q(
    `SELECT COUNT(*)::int AS orders, COALESCE(SUM(units),0)::int AS units, COALESCE(SUM(total),0) AS revenue,
            COUNT(*) FILTER (WHERE is_recurring)::int AS renewals,
            COUNT(*) FILTER (WHERE is_subscription AND NOT is_recurring)::int AS new_subs,
            AVG(EXTRACT(EPOCH FROM (first_fulfilled_at - created_at))/3600) FILTER (WHERE first_fulfilled_at IS NOT NULL) AS avg_fulfil_h,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_fulfilled_at - created_at))/3600)
              FILTER (WHERE first_fulfilled_at IS NOT NULL) AS med_fulfil_h,
            COUNT(*) FILTER (WHERE first_fulfilled_at IS NOT NULL)::int AS fulfilled_of_created
     FROM inn_orders WHERE created_at >= $1 AND cancelled_at IS NULL`,
    [since],
  )
  const [prev] = await q(
    `SELECT COUNT(*)::int AS orders, COALESCE(SUM(units),0)::int AS units,
            AVG(EXTRACT(EPOCH FROM (first_fulfilled_at - created_at))/3600) FILTER (WHERE first_fulfilled_at IS NOT NULL) AS avg_fulfil_h
     FROM inn_orders WHERE created_at >= $1 AND created_at < $2 AND cancelled_at IS NULL`,
    [prior, since],
  )
  const [del] = await q(
    `SELECT COUNT(*)::int AS delivered,
            AVG(EXTRACT(EPOCH FROM (delivered_at - first_fulfilled_at))/86400) AS avg_days,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at - first_fulfilled_at))/86400) AS med_days,
            AVG(EXTRACT(EPOCH FROM (delivered_at - created_at))/86400) AS avg_door_days
     FROM inn_orders WHERE delivered_at >= $1 AND first_fulfilled_at IS NOT NULL`,
    [since],
  )
  const [delPrev] = await q(
    `SELECT COUNT(*)::int AS delivered, AVG(EXTRACT(EPOCH FROM (delivered_at - first_fulfilled_at))/86400) AS avg_days
     FROM inn_orders WHERE delivered_at >= $1 AND delivered_at < $2 AND first_fulfilled_at IS NOT NULL`,
    [prior, since],
  )

  const transitRows = await q(
    `SELECT name, first_fulfilled_at, display, tracking_company, tracking_number, country
     FROM inn_orders
     WHERE first_fulfilled_at IS NOT NULL AND delivered_at IS NULL AND cancelled_at IS NULL
       AND first_fulfilled_at >= now() - interval '60 days'
     ORDER BY first_fulfilled_at ASC`,
  )
  const unfulfilledRows = await q(
    `SELECT name, created_at, fulfill_status, units, financial FROM inn_orders
     WHERE first_fulfilled_at IS NULL AND cancelled_at IS NULL AND fulfill_status = ANY($1)
       AND created_at >= now() - interval '90 days'
     ORDER BY created_at ASC`,
    [OPEN_STATUSES],
  )

  // one row per day for the period: placed / fulfilled / delivered
  const series = await q(
    `WITH d AS (SELECT generate_series(date_trunc('day', $1::timestamptz), date_trunc('day', now()), interval '1 day') AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       (SELECT COUNT(*)::int FROM inn_orders o WHERE date_trunc('day', o.created_at) = d.day AND o.cancelled_at IS NULL) AS placed,
       (SELECT COALESCE(SUM(units),0)::int FROM inn_orders o WHERE date_trunc('day', o.created_at) = d.day AND o.cancelled_at IS NULL) AS units,
       (SELECT COUNT(*)::int FROM inn_orders o WHERE date_trunc('day', o.first_fulfilled_at) = d.day) AS fulfilled,
       (SELECT COUNT(*)::int FROM inn_orders o WHERE date_trunc('day', o.delivered_at) = d.day) AS delivered
     FROM d ORDER BY d.day`,
    [since],
  )

  const carriers = {}
  for (const r of transitRows) carriers[r.tracking_company || 'Unknown'] = (carriers[r.tracking_company || 'Unknown'] || 0) + 1

  return {
    days,
    period: { orders: cur.orders, units: cur.units, revenue: num(cur.revenue), renewals: cur.renewals, newSubs: cur.new_subs,
      fulfilledOfCreated: cur.fulfilled_of_created },
    prior: { orders: prev.orders, units: prev.units },
    inTransit: {
      count: transitRows.length, buckets: ageBuckets(transitRows, 'first_fulfilled_at'), carriers,
      oldest: transitRows.slice(0, 8).map((r) => ({ name: r.name, days: Math.floor((Date.now() - new Date(r.first_fulfilled_at)) / 86400e3),
        status: r.display, carrier: r.tracking_company, tracking: r.tracking_number, country: r.country })),
    },
    unfulfilled: {
      count: unfulfilledRows.length, units: unfulfilledRows.reduce((a, r) => a + r.units, 0),
      buckets: ageBuckets(unfulfilledRows, 'created_at'),
      oldest: unfulfilledRows.slice(0, 8).map((r) => ({ name: r.name, days: Math.floor((Date.now() - new Date(r.created_at)) / 86400e3),
        status: r.fulfill_status, units: r.units, financial: r.financial })),
    },
    delivered: { count: del.delivered, prior: delPrev.delivered },
    avgFulfilHours: num(cur.avg_fulfil_h), medFulfilHours: num(cur.med_fulfil_h), priorAvgFulfilHours: num(prev.avg_fulfil_h),
    avgDeliveryDays: num(del.avg_days), medDeliveryDays: num(del.med_days), priorAvgDeliveryDays: num(delPrev.avg_days),
    avgDoorDays: num(del.avg_door_days),
    series,
  }
}

// Run rate of NEW demand (orders that are not subscription renewals), in
// units per day, over the baseline window - renewals are counted separately
// as a commitment, so they must not also inflate the run rate.
export async function runRate(baselineDays) {
  const [r] = await q(
    `SELECT COALESCE(SUM(units),0)::int AS units, COUNT(*)::int AS orders,
            COALESCE(SUM(units) FILTER (WHERE is_recurring),0)::int AS renewal_units,
            COUNT(*) FILTER (WHERE is_recurring)::int AS renewal_orders
     FROM inn_orders WHERE created_at >= now() - ($1 || ' days')::interval AND cancelled_at IS NULL`,
    [String(baselineDays)],
  )
  const [p] = await q(
    `SELECT COALESCE(SUM(units),0)::int AS units
     FROM inn_orders WHERE created_at >= now() - ($1 || ' days')::interval AND created_at < now() - ($2 || ' days')::interval AND cancelled_at IS NULL AND NOT is_recurring`,
    [String(baselineDays * 2), String(baselineDays)],
  )
  const newUnits = r.units - r.renewal_units
  return {
    baselineDays, newUnitsPerDay: newUnits / baselineDays, priorNewUnitsPerDay: p.units / baselineDays,
    newOrdersPerDay: (r.orders - r.renewal_orders) / baselineDays,
    renewalUnitsLast30: null, // filled from a 30-day query below
    unitsPerNewOrder: r.orders - r.renewal_orders ? newUnits / (r.orders - r.renewal_orders) : 1,
  }
}

// Fallback when Loop is not connected: renewals that actually billed in the
// last 30 days are a floor on what will bill in the next 30 (monthly cadence).
export async function renewalsEstimate() {
  const [r] = await q(
    `SELECT COUNT(*)::int AS orders, COALESCE(SUM(units),0)::int AS units
     FROM inn_orders WHERE is_recurring AND created_at >= now() - interval '30 days' AND cancelled_at IS NULL`,
  )
  const weeks = await q(
    `SELECT FLOOR(EXTRACT(EPOCH FROM (now() - created_at))/86400/7)::int AS w, COALESCE(SUM(units),0)::int AS units
     FROM inn_orders WHERE is_recurring AND created_at >= now() - interval '30 days' AND cancelled_at IS NULL GROUP BY 1`,
  )
  const buckets = [0, 0, 0, 0, 0]
  for (const w of weeks) buckets[Math.min(4, w.w)] = w.units
  return { subscriptions: r.orders, units: r.units, weeks: buckets, source: 'estimate' }
}
