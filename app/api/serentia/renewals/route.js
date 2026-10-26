import { session, unauthorized, seesOps, forbidden } from '../../../../lib/innaderm/auth'
import { saveManualRenewals, clearManualRenewals } from '../../../../lib/serentia/stock'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Loop renewals pasted from the Loop admin, used until SERENTIA_LOOP_TOKEN
// is set. Any key that sees the ops tabs can save or clear it.
export async function POST(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (!seesOps(s)) return forbidden()
  let body = null
  try { body = await request.json() } catch {}
  if (!body?.text || String(body.text).length > 200000) return Response.json({ error: 'Paste the Loop rows first (max 200 KB).' }, { status: 400 })
  try {
    return Response.json(await saveManualRenewals(body, s.name))
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 400 })
  }
}

export async function DELETE(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (!seesOps(s)) return forbidden()
  await clearManualRenewals(s.name)
  return Response.json({ ok: true })
}
