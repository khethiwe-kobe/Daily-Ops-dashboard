import { q } from '../db'

// Serentia Ops tables. Same database as the support board and the Innaderm
// dashboard, own prefix so they never collide. Created on first use, additive only.
let ready
export function ensureSerentia() {
  if (ready) return ready
  ready = (async () => {
    await q(`CREATE TABLE IF NOT EXISTS ser_access_keys (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )`)
    await q(`CREATE TABLE IF NOT EXISTS ser_sessions (
      token_hash TEXT PRIMARY KEY,
      key_id BIGINT NOT NULL REFERENCES ser_access_keys(id),
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )`)
    await q(`CREATE TABLE IF NOT EXISTS ser_login_attempts (
      id BIGSERIAL PRIMARY KEY,
      ip TEXT NOT NULL,
      ok BOOLEAN NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    await q(`CREATE INDEX IF NOT EXISTS idx_ser_login_ip ON ser_login_attempts (ip, at)`)
    await q(`CREATE TABLE IF NOT EXISTS ser_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    await q(`CREATE TABLE IF NOT EXISTS ser_cache (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    // One row per Shopify order, kept current by incremental sync. Everything
    // the fulfilment panel needs is derived from these columns, so a period
    // change is a SQL query, not another Shopify pull.
    await q(`CREATE TABLE IF NOT EXISTS ser_orders (
      id BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      cancelled_at TIMESTAMPTZ,
      financial TEXT,
      fulfill_status TEXT,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      units INTEGER NOT NULL DEFAULT 0,
      is_recurring BOOLEAN NOT NULL DEFAULT false,
      is_subscription BOOLEAN NOT NULL DEFAULT false,
      first_fulfilled_at TIMESTAMPTZ,
      in_transit_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      display TEXT,
      tracking_company TEXT,
      tracking_number TEXT,
      country TEXT
    )`)
    await q(`CREATE INDEX IF NOT EXISTS idx_ser_orders_created ON ser_orders (created_at)`)
    await q(`CREATE INDEX IF NOT EXISTS idx_ser_orders_delivered ON ser_orders (delivered_at)`)
    await q(`CREATE INDEX IF NOT EXISTS idx_ser_orders_fulfilled ON ser_orders (first_fulfilled_at)`)
    await q(`CREATE TABLE IF NOT EXISTS ser_order_lines (
      id BIGINT PRIMARY KEY,
      order_id BIGINT NOT NULL,
      variant_id BIGINT,
      qty INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      variant_title TEXT,
      sku TEXT
    )`)
    await q(`CREATE INDEX IF NOT EXISTS idx_ser_order_lines_order ON ser_order_lines (order_id)`)
    await q(`CREATE TABLE IF NOT EXISTS ser_events (
      id BIGSERIAL PRIMARY KEY,
      actor TEXT,
      kind TEXT NOT NULL,
      detail JSONB,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  })()
  return ready
}

export async function cacheGet(key, maxAgeSec) {
  const rows = await q('SELECT value, fetched_at FROM ser_cache WHERE key = $1', [key])
  if (!rows.length) return null
  const age = (Date.now() - new Date(rows[0].fetched_at).getTime()) / 1000
  return { value: rows[0].value, ageSec: age, fresh: age <= maxAgeSec, fetchedAt: new Date(rows[0].fetched_at).toISOString() }
}

export async function cacheSet(key, value) {
  await q(
    `INSERT INTO ser_cache (key, value, fetched_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()`,
    [key, JSON.stringify(value)],
  )
}

// Read-through cache: serve a fresh copy, otherwise refetch and store. On a
// refetch failure the stale copy is returned with the error attached so one
// slow upstream never blanks a panel.
export async function cached(key, maxAgeSec, fetcher) {
  const hit = await cacheGet(key, maxAgeSec)
  if (hit && hit.fresh) return { ...hit.value, cachedAt: hit.fetchedAt, stale: false }
  try {
    const fresh = await fetcher()
    await cacheSet(key, fresh)
    return { ...fresh, cachedAt: new Date().toISOString(), stale: false }
  } catch (e) {
    if (hit) return { ...hit.value, cachedAt: hit.fetchedAt, stale: true, error: String(e.message || e).slice(0, 200) }
    throw e
  }
}

export async function logEvent(actor, kind, detail) {
  try {
    await q('INSERT INTO ser_events (actor, kind, detail) VALUES ($1, $2, $3::jsonb)', [actor || null, kind, JSON.stringify(detail || {})])
  } catch {
    // never let audit logging break the request
  }
}
