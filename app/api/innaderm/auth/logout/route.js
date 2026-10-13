import { logout, sessionCookie } from '../../../../../lib/innaderm/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  await logout(request).catch(() => {})
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie('', 0), 'Cache-Control': 'no-store' } })
}
