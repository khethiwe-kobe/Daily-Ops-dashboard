import { ensureSchema } from '../../../../lib/db'
import { getSetting, setSetting, hashKey, NO_STORE } from '../../../../lib/prom'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// One-time creation of the board's access key. Works only while no key is
// stored; after that the key can only be changed from the board itself.

export async function GET() {
  await ensureSchema()
  return Response.json({ configured: !!(await getSetting('access_key_hash')) }, { headers: NO_STORE })
}

export async function POST(request) {
  await ensureSchema()
  if (await getSetting('access_key_hash')) {
    return Response.json({ error: 'An access key already exists. Change it from the board.' }, { status: 409, headers: NO_STORE })
  }
  let body = null
  try { body = await request.json() } catch { body = null }
  const key = typeof body?.key === 'string' ? body.key.trim() : ''
  if (key.length < 8 || key.length > 64) {
    return Response.json({ error: 'Choose a key of 8 to 64 characters.' }, { status: 400, headers: NO_STORE })
  }
  await setSetting('access_key_hash', hashKey(key))
  return Response.json({ ok: true }, { headers: NO_STORE })
}
