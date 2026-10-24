import { login, sessionCookie } from '../../../../../lib/serentia/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  let body = null
  try { body = await request.json() } catch { body = null }
  const key = typeof body?.key === 'string' ? body.key : ''
  if (!key) return Response.json({ error: 'Enter your access key.' }, { status: 400 })
  try {
    const r = await login(request, key)
    if (r.error) return Response.json({ error: r.error }, { status: r.status || 401 })
    return Response.json(
      { token: r.token, name: r.name, role: r.role, expiresAt: r.expiresAt },
      { headers: { 'Set-Cookie': sessionCookie(r.token), 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    const msg = String(e?.message || e)
    const db = /database URL|ECONN|connect|relation/i.test(msg)
    return Response.json({ error: db ? 'Database not reachable. Check POSTGRES_URL in Vercel.' : 'Login failed.' }, { status: 500 })
  }
}
