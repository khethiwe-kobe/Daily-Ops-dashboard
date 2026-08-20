import { q, ensureSchema } from '../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Unauthenticated, deliberately says nothing about ticket content - just
// enough to tell whether the deploy and the database are wired up.
export async function GET() {
  const out = {
    ok: true,
    db: 'unknown',
    urlVar: process.env.POSTGRES_URL ? 'POSTGRES_URL' : process.env.DATABASE_URL ? 'DATABASE_URL' : 'none',
    syncKey: process.env.SYNC_KEY ? 'set' : 'MISSING',
    statuses: null,
    threads: null,
  }
  try {
    await ensureSchema()
    out.statuses = Number((await q('SELECT COUNT(*)::int AS n FROM ticket_status'))[0].n)
    out.threads = Number((await q('SELECT COUNT(*)::int AS n FROM ticket_thread'))[0].n)
    out.db = 'connected'
  } catch (e) {
    out.ok = false
    out.db = 'error: ' + String(e.message || e).slice(0, 120)
  }
  return Response.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
