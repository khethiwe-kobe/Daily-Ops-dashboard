import { scriptAuthorised, pendingDrafts, draftResults } from '../../../../../lib/innaderm/csboard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// For the support mailbox's Apps Script only (INNADERM_CS_INGEST_KEY):
// GET the replies waiting to become Gmail drafts, POST back what happened.
export async function GET(request) {
  if (!scriptAuthorised(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  return Response.json({ drafts: await pendingDrafts() })
}

export async function POST(request) {
  if (!scriptAuthorised(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  let body = null
  try { body = await request.json() } catch {}
  return Response.json(await draftResults(body?.results))
}
