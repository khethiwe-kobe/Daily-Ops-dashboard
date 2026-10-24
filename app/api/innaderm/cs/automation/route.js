import { session, unauthorized, forbidden } from '../../../../../lib/innaderm/auth'
import { saveAutomation } from '../../../../../lib/innaderm/csboard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Admin: move a ticket type along the automation ladder, set owner / next step.
export async function PUT(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (s.role !== 'admin') return forbidden()
  let body = null
  try { body = await request.json() } catch {}
  const r = await saveAutomation(body, s.name)
  return Response.json(r, { status: r.status || 200 })
}
