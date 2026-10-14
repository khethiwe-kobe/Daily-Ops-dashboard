import { timingSafeEqual } from 'node:crypto'
import { sha256 } from '../../../../../lib/innaderm/auth'
import { ingest } from '../../../../../lib/innaderm/cs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Called by the Apps Script in the support mailbox (scripts/innaderm-gmail-sync.gs)
// with INNADERM_CS_INGEST_KEY as a bearer token. Not a user login.
function authorised(request) {
  const want = String(process.env.INNADERM_CS_INGEST_KEY || '')
  if (want.length < 16) return false
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return timingSafeEqual(Buffer.from(sha256(got)), Buffer.from(sha256(want)))
}

export async function POST(request) {
  if (!authorised(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }) }
  try {
    return Response.json(await ingest(body))
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 })
  }
}
