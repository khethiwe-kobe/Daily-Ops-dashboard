import { session, unauthorized } from '../../../../lib/serentia/auth'
import { overview } from '../../../../lib/serentia/overview'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PERIODS = new Set([7, 14, 30, 60, 90])

export async function GET(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  const url = new URL(request.url)
  const days = Number(url.searchParams.get('days') || 7)
  if (!PERIODS.has(days)) return Response.json({ error: 'days must be one of 7, 14, 30, 60, 90' }, { status: 400 })
  try {
    const data = await overview({ days })
    return Response.json({ ...data, viewer: { name: s.name, role: s.role } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 })
  }
}
