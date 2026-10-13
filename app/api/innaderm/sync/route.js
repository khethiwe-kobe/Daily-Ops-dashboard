import { session, unauthorized } from '../../../../lib/innaderm/auth'
import { syncOrders, syncState, configured } from '../../../../lib/innaderm/shopify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Pulls the next few pages of Shopify orders into inn_orders. The dashboard
// calls this on load and keeps calling while `complete` is false (the first
// 120-day backfill takes several calls; after that each call is a small
// incremental update).
export async function POST(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (!configured()) return Response.json({ configured: false, complete: true })
  try {
    const r = await syncOrders({ maxPages: 4 })
    return Response.json({ ...r, state: await syncState() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 300), state: await syncState().catch(() => null) }, { status: 502 })
  }
}
