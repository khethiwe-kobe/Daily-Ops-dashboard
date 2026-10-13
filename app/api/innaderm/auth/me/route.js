import { session, unauthorized } from '../../../../../lib/innaderm/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  return Response.json({ name: s.name, role: s.role }, { headers: { 'Cache-Control': 'no-store' } })
}
