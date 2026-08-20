import { Pool } from 'pg'

// One pool per lambda instance. Serverless means many short-lived instances,
// so keep the per-instance cap tiny and lean on the provider's pooler
// (Neon/Supabase pooled connection strings) for the real multiplexing.
let pool
export function db() {
  if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL is not set')
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.POSTGRES_URL,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.POSTGRES_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    })
  }
  return pool
}

export async function q(text, params = []) {
  const res = await db().query(text, params)
  return res.rows
}

// Called on first use so a fresh database works without a manual migrate step.
let ready
export async function ensureSchema() {
  if (ready) return ready
  ready = (async () => {
    await q(`CREATE TABLE IF NOT EXISTS ticket_status (
      slug TEXT PRIMARY KEY,
      status TEXT,
      note TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    await q(`CREATE TABLE IF NOT EXISTS ticket_thread (
      id BIGSERIAL PRIMARY KEY,
      slug TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    await q(`CREATE INDEX IF NOT EXISTS idx_ticket_thread_slug ON ticket_thread (slug, id)`)
  })()
  return ready
}
