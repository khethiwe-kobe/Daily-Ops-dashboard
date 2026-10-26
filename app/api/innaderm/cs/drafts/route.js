import { scriptAuthorised, pendingDrafts, draftResults } from '../../../../../lib/innaderm/csboard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// For the support mailbox's Apps Script only (INNADERM_CS_INGEST_KEY):
// GET the replies waiting to become Gmail drafts, POST back what happened.
export async function GET(request) {
  if (!scriptAuthorised(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const v = Number(new URL(request.url).searchParams.get('v') || 1)
  return Response.json({ drafts: await pendingDrafts(Number.isFinite(v) ? v : 1) })
}

export async function POST(request) {
  if (!scriptAuthorised(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  let body = null
  try { body = await request.json() } catch {}
  return Response.json(await draftResults(body?.results))
}
