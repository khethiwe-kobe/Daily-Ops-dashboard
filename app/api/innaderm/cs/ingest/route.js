import { ingest } from '../../../../../lib/innaderm/cs'
import { scriptAuthorised, autoDraft } from '../../../../../lib/innaderm/csboard'
import { getSettings } from '../../../../../lib/innaderm/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Called by the Apps Script in the support mailbox (scripts/innaderm-gmail-sync.gs)
// with INNADERM_CS_INGEST_KEY as a bearer token. Not a user login.
export async function POST(request) {
  if (!scriptAuthorised(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }) }
  try {
    const r = await ingest(body)
    // Auto-drafts only for live activity, not the 90-day backfill.
    let auto = { queued: 0 }
    if (!body?.backfill) {
      try { const { settings } = await getSettings(); auto = await autoDraft(r.ids, settings) } catch { /* never block ingest */ }
    }
    return Response.json({ saved: r.saved, skipped: r.skipped, autoDrafts: auto.queued })
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 })
  }
}
