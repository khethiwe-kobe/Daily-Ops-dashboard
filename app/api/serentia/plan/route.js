import { session, unauthorized, seesOps, forbidden } from '../../../../lib/innaderm/auth'
import { saveDemandSettings } from '../../../../lib/serentia/stock'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Planned demand for the Serentia stock tab: campaign uplift and the Black
// Friday window. Shared by everyone who can see the tab.
export async function POST(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (!seesOps(s)) return forbidden()
  let body = null
  try { body = await request.json() } catch {}
  try {
    return Response.json(await saveDemandSettings(body || {}, s.name))
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 400 })
  }
}
