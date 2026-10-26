import { session, unauthorized, forbidden, listKeys, createKey, revokeKey, ROLES } from '../../../../lib/innaderm/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function admin(request) {
  const s = await session(request).catch(() => null)
  if (!s) return { res: unauthorized() }
  if (s.role !== 'admin') return { res: forbidden() }
  return { s }
}

export async function GET(request) {
  const { s, res } = await admin(request)
  if (res) return res
  const keys = (await listKeys()).map((k) => ({
    id: k.id, name: k.name, role: k.role, createdBy: k.created_by,
    createdAt: new Date(k.created_at).toISOString(),
    lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
    revokedAt: k.revoked_at ? new Date(k.revoked_at).toISOString() : null,
    activeSessions: k.active_sessions, you: k.id === s.keyId,
  }))
  return Response.json({ keys }, { headers: { 'Cache-Control': 'no-store' } })
}

// Issue a key. The plaintext is returned once and never stored.
export async function POST(request) {
  const { s, res } = await admin(request)
  if (res) return res
  let body = null
  try { body = await request.json() } catch { body = null }
  const name = String(body?.name || '').trim().slice(0, 80)
  const role = ROLES.includes(body?.role) ? body.role : 'viewer'
  if (name.length < 2) return Response.json({ error: 'Give the key a name (who it is for).' }, { status: 400 })
  const k = await createKey(name, role, s.name)
  return Response.json(k, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(request) {
  const { s, res } = await admin(request)
  if (res) return res
  const id = Number(new URL(request.url).searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: 'id required' }, { status: 400 })
  if (id === s.keyId) return Response.json({ error: 'You cannot revoke the key you are signed in with.' }, { status: 400 })
  await revokeKey(id, s.name)
  return Response.json({ ok: true })
}
