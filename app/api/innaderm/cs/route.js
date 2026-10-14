import { session, unauthorized } from '../../../../lib/innaderm/auth'
import { csMetrics } from '../../../../lib/innaderm/cs'
import { getSettings } from '../../../../lib/innaderm/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PERIODS = new Set([7, 14, 30, 60, 90])

export async function GET(request) {
  const s = await session(request).catch(() => null)
  if (!s) return unauthorized()
  const days = Number(new URL(request.url).searchParams.get('days') || 7)
  if (!PERIODS.has(days)) return Response.json({ error: 'days must be one of 7, 14, 30, 60, 90' }, { status: 400 })
  try {
    const { settings, meta } = await getSettings()
    const data = await csMetrics({ days, settings })
    return Response.json({ ...data, settings, settingsMeta: meta }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 })
  }
}
