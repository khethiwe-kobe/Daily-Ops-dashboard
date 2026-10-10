import { q, ensureSchema } from '../../../../lib/db'
import { normalizeName } from '../../../../lib/names'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

// Set PROM_VOTING_CLOSED=1 in the environment to stop accepting votes. The
// results board keeps working either way.
const votingOpen = () => !/^(1|true|yes)$/i.test(process.env.PROM_VOTING_CLOSED || '')

// Letters (any script), spaces, hyphens and apostrophes; 2 to 60 characters.
const okName = (s) => typeof s === 'string' && /^[\p{L}\p{M}][\p{L}\p{M}' .-]{1,59}$/u.test(s.trim())
const okToken = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s)

async function total() {
  return Number((await q('SELECT COUNT(*)::int AS n FROM prom_votes'))[0].n)
}

// Unauthenticated status for the voting page: is voting open, how many votes.
export async function GET() {
  await ensureSchema()
  return Response.json({ open: votingOpen(), total: await total() }, { headers: NO_STORE })
}

export async function POST(request) {
  if (!votingOpen()) return Response.json({ error: 'Voting has closed.' }, { status: 403, headers: NO_STORE })
  await ensureSchema()
  let body = null
  try { body = await request.json() } catch { body = null }

  const king = typeof body?.king === 'string' ? body.king.replace(/\s+/g, ' ').trim() : ''
  const queen = typeof body?.queen === 'string' ? body.queen.replace(/\s+/g, ' ').trim() : ''
  const token = body?.token

  if (!okToken(token)) return Response.json({ error: 'Something went wrong. Refresh the page and try again.' }, { status: 400, headers: NO_STORE })
  if (!okName(king)) return Response.json({ error: 'Enter a name for Prom King (letters only, 2 to 60 characters).' }, { status: 400, headers: NO_STORE })
  if (!okName(queen)) return Response.json({ error: 'Enter a name for Prom Queen (letters only, 2 to 60 characters).' }, { status: 400, headers: NO_STORE })
  if (!normalizeName(king) || !normalizeName(queen)) return Response.json({ error: 'Please enter real names.' }, { status: 400, headers: NO_STORE })

  const row = (await q(
    `INSERT INTO prom_votes (voter_token, king, queen) VALUES ($1, $2, $3)
     ON CONFLICT (voter_token) DO UPDATE SET king = EXCLUDED.king, queen = EXCLUDED.queen, updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [token, king, queen],
  ))[0]

  return Response.json({ ok: true, replaced: !row.inserted, king, queen, total: await total() }, { headers: NO_STORE })
}
