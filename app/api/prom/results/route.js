import { q, ensureSchema } from '../../../../lib/db'
import { tally } from '../../../../lib/names'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The results board is for the organisers only, so it is gated on SYNC_KEY
// the same way /founder is. Voters never need this.
function keyOk(request) {
  const key = new URL(request.url).searchParams.get('key') || ''
  return !!process.env.SYNC_KEY && key === process.env.SYNC_KEY
}

export async function GET(request) {
  if (!keyOk(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  await ensureSchema()

  const rows = await q('SELECT king, queen, updated_at FROM prom_votes')
  let last = null
  for (const r of rows) if (!last || r.updated_at > last) last = r.updated_at

  const total = rows.length
  const withShare = (list) => list.map((c) => ({ ...c, share: total ? c.votes / total : 0 }))

  return Response.json({
    total,
    lastVoteAt: last ? new Date(last).toISOString() : null,
    open: !/^(1|true|yes)$/i.test(process.env.PROM_VOTING_CLOSED || ''),
    king: withShare(tally(rows.map((r) => r.king))),
    queen: withShare(tally(rows.map((r) => r.queen))),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
