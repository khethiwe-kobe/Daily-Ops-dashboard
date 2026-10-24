import { session, unauthorized } from '../../../../../lib/innaderm/auth'
import { getSettings } from '../../../../../lib/innaderm/settings'
import { boardData, updateTicket } from '../../../../../lib/innaderm/csboard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const err = (e) => Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 })

export async function GET(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  try {
    const { settings } = await getSettings()
    return Response.json(await boardData({ settings }), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) { return err(e) }
}

// Any signed-in key can work tickets: status, note, owner, type correction.
export async function POST(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  let body = null
  try { body = await request.json() } catch {}
  if (!body?.id) return Response.json({ error: 'id required' }, { status: 400 })
  try {
    const r = await updateTicket(String(body.id), body, s.name)
    return Response.json(r, { status: r.status || 200 })
  } catch (e) { return err(e) }
}
