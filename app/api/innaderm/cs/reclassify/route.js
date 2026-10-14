import { session, unauthorized, forbidden } from '../../../../../lib/innaderm/auth'
import { reclassifyAll } from '../../../../../lib/innaderm/cs'
import { logEvent } from '../../../../../lib/innaderm/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Admin: re-run the category rules over every stored ticket.
export async function POST(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (s.role !== 'admin') return forbidden()
  const r = await reclassifyAll()
  await logEvent(s.name, 'cs.reclassify', r)
  return Response.json(r)
}
