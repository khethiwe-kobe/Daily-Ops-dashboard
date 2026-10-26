import { session, unauthorized, forbidden, seesOps } from '../../../../lib/innaderm/auth'
import { getSettings, saveSettings } from '../../../../lib/innaderm/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (!seesOps(s)) return forbidden()
  return Response.json(await getSettings(), { headers: { 'Cache-Control': 'no-store' } })
}

// Operating inputs (stock counts, lead times, MOQs, sources). Admin keys only;
// every change is written to inn_events with the key's name.
export async function PUT(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  if (s.role !== 'admin') return forbidden()
  let body = null
  try { body = await request.json() } catch { body = null }
  if (!body || typeof body !== 'object') return Response.json({ error: 'bad body' }, { status: 400 })
  const r = await saveSettings(body, s.name)
  if (!r.saved.length) return Response.json(r, { status: 400 })
  return Response.json({ ...r, ...(await getSettings()) }, { headers: { 'Cache-Control': 'no-store' } })
}
