import { q, ensureSchema } from '../../../../lib/db'
import { tally } from '../../../../lib/names'
import { organiser, votingOpen, unauthorized } from '../../../../lib/prom'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The results board is for the organisers only: it needs the board's access
// key (or SYNC_KEY). Voters never need this.
export async function GET(request) {
  await ensureSchema()
  if (!(await organiser(request))) return unauthorized()

  const rows = await q('SELECT king, queen, updated_at FROM prom_votes')
  let last = null
  for (const r of rows) if (!last || r.updated_at > last) last = r.updated_at

  const total = rows.length
  const withShare = (list) => list.map((c) => ({ ...c, share: total ? c.votes / total : 0 }))

  return Response.json({
    total,
    lastVoteAt: last ? new Date(last).toISOString() : null,
    open: await votingOpen(),
    king: withShare(tally(rows.map((r) => r.king))),
    queen: withShare(tally(rows.map((r) => r.queen))),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
