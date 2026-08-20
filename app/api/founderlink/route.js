import { q, ensureSchema } from '../../../lib/db'
import { authed, unauthorized } from '../../../lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Hands the signed founder URL to an authenticated operator, so SYNC_KEY is
// never baked into a page anyone can view-source.
export async function GET(request) {
  if (!(await authed(request))) return unauthorized()
  if (!process.env.SYNC_KEY) return Response.json({ error: 'SYNC_KEY not configured' }, { status: 503 })
  await ensureSchema()
  const n = (await q("SELECT COUNT(*)::int AS n FROM ticket_status WHERE status = 'Founder'"))[0].n
  const origin = new URL(request.url).origin
  return Response.json({ url: `${origin}/founder?key=${process.env.SYNC_KEY}`, count: Number(n) })
}
