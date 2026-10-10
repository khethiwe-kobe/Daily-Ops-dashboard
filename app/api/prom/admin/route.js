import { q, ensureSchema } from '../../../../lib/db'
import { organiser, setSetting, hashKey, votingOpen, unauthorized, NO_STORE } from '../../../../lib/prom'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Organiser controls for the board. Every action needs the access key.
//   close / open   - stop or resume accepting votes
//   reset          - delete every vote (confirm must be the word RESET)
//   change_key     - set a new access key (newKey, 8 to 64 characters)
export async function POST(request) {
  await ensureSchema()
  let body = null
  try { body = await request.json() } catch { body = null }
  if (!(await organiser(request, body))) return unauthorized()

  const action = body?.action
  if (action === 'close') await setSetting('voting', 'closed')
  else if (action === 'open') await setSetting('voting', 'open')
  else if (action === 'reset') {
    if (body?.confirm !== 'RESET') return Response.json({ error: 'Type RESET to confirm.' }, { status: 400, headers: NO_STORE })
    await q('DELETE FROM prom_votes')
  } else if (action === 'change_key') {
    const k = typeof body?.newKey === 'string' ? body.newKey.trim() : ''
    if (k.length < 8 || k.length > 64) return Response.json({ error: 'Choose a key of 8 to 64 characters.' }, { status: 400, headers: NO_STORE })
    await setSetting('access_key_hash', hashKey(k))
  } else return Response.json({ error: 'unknown action' }, { status: 400, headers: NO_STORE })

  const total = Number((await q('SELECT COUNT(*)::int AS n FROM prom_votes'))[0].n)
  return Response.json({ ok: true, open: await votingOpen(), total }, { headers: NO_STORE })
}
