// One-time import of the board state exported from the old Cloudflare/D1 build.
// Idempotent: re-running will not duplicate thread messages.
import fs from 'fs'
import path from 'path'
// pg is CommonJS: a named import works under a bundler but throws in plain
// node ESM, which is how this script actually runs.
import pg from 'pg'
const { Pool } = pg

const CANDIDATES = ['POSTGRES_URL', 'DATABASE_URL', 'POSTGRES_DATABASE_URL', 'POSTGRES_POSTGRES_URL', 'POSTGRES_PRISMA_URL']
const URL_ = CANDIDATES.map((k) => process.env[k]).find((v) => v && /^postgres(ql)?:\/\//.test(v)) ||
  Object.entries(process.env).filter(([k, v]) => /_URL$/.test(k) && /^postgres(ql)?:\/\//.test(String(v)))
    .sort((a, b) => (/UNPOOLED/i.test(a[0]) ? 1 : 0) - (/UNPOOLED/i.test(b[0]) ? 1 : 0)).map(([, v]) => v)[0]
if (!URL_) { console.error('FATAL: no Postgres connection string in the environment (tried ' + CANDIDATES.join(', ') + ')'); process.exit(2) }

const file = path.join(process.cwd(), 'data', 'seed-status.json')
const { statuses = {}, notes = {}, threads = {}, updated = {} } = JSON.parse(fs.readFileSync(file, 'utf8'))

const pool = new Pool({ connectionString: URL_, max: 2, ssl: URL_.includes('localhost') ? false : { rejectUnauthorized: false } })
const c = await pool.connect()

await c.query(`CREATE TABLE IF NOT EXISTS ticket_status (
  slug TEXT PRIMARY KEY, status TEXT, note TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
await c.query(`CREATE TABLE IF NOT EXISTS ticket_thread (
  id BIGSERIAL PRIMARY KEY, slug TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
await c.query(`CREATE INDEX IF NOT EXISTS idx_ticket_thread_slug ON ticket_thread (slug, id)`)

const slugs = new Set([...Object.keys(statuses), ...Object.keys(notes)])
let n = 0
await c.query('BEGIN')
for (const slug of slugs) {
  await c.query(
    `INSERT INTO ticket_status (slug, status, note, updated_at)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
     ON CONFLICT (slug) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`,
    [slug, statuses[slug] || null, notes[slug] || null, updated[slug] || null])
  n++
}
await c.query('COMMIT')

// Threads: skip any (slug, author, body) already present so re-seeding is safe.
let t = 0, skipped = 0
await c.query('BEGIN')
for (const [slug, msgs] of Object.entries(threads)) {
  for (const m of msgs) {
    const dup = await c.query(
      'SELECT 1 FROM ticket_thread WHERE slug = $1 AND author = $2 AND body = $3 LIMIT 1',
      [slug, m.author, m.body])
    if (dup.rowCount) { skipped++; continue }
    await c.query(
      'INSERT INTO ticket_thread (slug, author, body, created_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))',
      [slug, m.author, m.body, m.at || null])
    t++
  }
}
await c.query('COMMIT')

const counts = await c.query('SELECT (SELECT COUNT(*) FROM ticket_status) s, (SELECT COUNT(*) FROM ticket_thread) th')
console.log(`seeded ${n} statuses, ${t} thread messages (${skipped} already present)`)
console.log(`database now holds ${counts.rows[0].s} statuses, ${counts.rows[0].th} thread messages`)
c.release(); await pool.end()
