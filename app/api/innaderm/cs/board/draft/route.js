import { session, unauthorized } from '../../../../../../lib/innaderm/auth'
import { queueDraft } from '../../../../../../lib/innaderm/csboard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Queue a reply; the support mailbox's Apps Script turns it into a Gmail draft.
export async function POST(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  let body = null
  try { body = await request.json() } catch {}
  if (!body?.id) return Response.json({ error: 'id required' }, { status: 400 })
  try {
    const r = await queueDraft(String(body.id), { body: body.body, template: body.template, category: body.category }, s.name)
    return Response.json(r, { status: r.status || 200 })
  } catch (e) { return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 }) }
}
