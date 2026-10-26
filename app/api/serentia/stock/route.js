import { session, unauthorized, seesOps, forbidden } from '../../../../lib/innaderm/auth'
import { stockOverview } from '../../../../lib/serentia/stock'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Serentia stock by shade. Same login keys as the Innaderm dashboard.
export async function GET(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (!seesOps(s)) return forbidden()
  try {
    return Response.json(await stockOverview(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 })
  }
}
