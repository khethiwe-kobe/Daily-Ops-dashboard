import { session, unauthorized } from '../../../../../../lib/innaderm/auth'
import { getSettings } from '../../../../../../lib/innaderm/settings'
import { escalate } from '../../../../../../lib/innaderm/csboard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Send a ticket to Calvin as a task in ClickUp Founder Escalations.
export async function POST(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  let body = null
  try { body = await request.json() } catch {}
  if (!body?.id) return Response.json({ error: 'id required' }, { status: 400 })
  try {
    const { settings } = await getSettings()
    const r = await escalate(String(body.id), body, s.name, settings)
    return Response.json(r, { status: r.status || 200 })
  } catch (e) { return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 502 }) }
}
