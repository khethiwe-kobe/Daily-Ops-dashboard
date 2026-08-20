import { Pool } from 'pg'

// One pool per lambda instance. Serverless means many short-lived instances,
// so keep the per-instance cap tiny and lean on the provider's pooler
// (Neon/Supabase pooled connection strings) for the real multiplexing.
// Providers disagree on the variable name: Vercel Postgres uses POSTGRES_URL,
// Neon's integration sets DATABASE_URL. Accept either so connecting the
// database is one click with no prefix to remember.
export function connectionString() {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || ''
}

let pool
export function db() {
  const cs = connectionString()
  if (!cs) throw new Error('No database URL set (POSTGRES_URL or DATABASE_URL)')
  if (!pool) {
    pool = new Pool({
      connectionString: cs,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: cs.includes('localhost') ? false : { rejectUnauthorized: false },
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
