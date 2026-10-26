import { session, unauthorized, seesOps, forbidden } from '../../../../lib/innaderm/auth'
import { saveManualSales, clearManualSales } from '../../../../lib/serentia/stock'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Sales pasted from a Shopify report, used until the Serentia Shopify keys
// are set. Any key that sees the ops tabs can save or clear it.
export async function POST(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (!seesOps(s)) return forbidden()
  let body = null
  try { body = await request.json() } catch {}
  if (!body?.text || String(body.text).length > 200000) return Response.json({ error: 'Paste the report rows first (max 200 KB).' }, { status: 400 })
  try {
    return Response.json(await saveManualSales(body, s.name))
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 400 })
  }
}

export async function DELETE(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (!seesOps(s)) return forbidden()
  await clearManualSales(s.name)
  return Response.json({ ok: true })
}
