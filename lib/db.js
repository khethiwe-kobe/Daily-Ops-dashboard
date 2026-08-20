import { Pool } from 'pg'

// One pool per lambda instance. Serverless means many short-lived instances,
// so keep the per-instance cap tiny and lean on the provider's pooler
// (Neon/Supabase pooled connection strings) for the real multiplexing.
// Providers disagree on what to call the connection string, and Vercel's Neon
// integration optionally prefixes every name it creates. Rather than demand one
// spelling, look through the likely names in priority order and fall back to
// sniffing the environment for anything that is plainly a Postgres URL.
// Pooled connections are strongly preferred: on serverless each request can get
// its own instance, and the unpooled endpoint runs out of connections fast.
const CANDIDATES = [
  'POSTGRES_URL',
  'DATABASE_URL',
  'POSTGRES_DATABASE_URL',
  'POSTGRES_POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
]

export function resolveConnection() {
  for (const name of CANDIDATES) {
    const v = process.env[name]
    if (v && /^postgres(ql)?:\/\//.test(v) && !/UNPOOLED/i.test(name)) return { name, value: v }
  }
  // Last resort: any variable holding a postgres:// string. Unpooled sorts last
  // but is still usable - a slower connection beats no database at all.
  const found = Object.entries(process.env)
    .filter(([k, v]) => /URL/i.test(k) && typeof v === 'string' && /^postgres(ql)?:\/\//.test(v))
    .sort((a, b) => (/UNPOOLED/i.test(a[0]) ? 1 : 0) - (/UNPOOLED/i.test(b[0]) ? 1 : 0))
  return found.length ? { name: found[0][0], value: found[0][1] } : { name: null, value: '' }
}

export function connectionString() {
  return resolveConnection().value
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
