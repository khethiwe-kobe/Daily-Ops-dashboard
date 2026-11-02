import { session, unauthorized, forbidden } from '../../../../../lib/innaderm/auth'
import { saveTemplate } from '../../../../../lib/innaderm/csboard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Admin: edit or approve a reply template. Only approved templates are used for auto-drafts.
export async function PUT(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (s.role !== 'admin') return forbidden()
  let body = null
  try { body = await request.json() } catch {}
  const r = await saveTemplate(body, s.name)
  return Response.json(r, { status: r.status || 200 })
}
