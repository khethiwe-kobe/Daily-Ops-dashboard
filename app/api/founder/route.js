import { q, ensureSchema } from '../../../lib/db'
import { okSlug } from '../../../lib/auth'
import tickets from '../../../data/tickets.json'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const GROUP_LABEL = {
  cancel: 'Cancellations', refund: 'Refunds & charges', delivery: 'Not received',
  shade: 'Wrong shade / returns', question: 'Product & help', other: 'Other',
}
const CHAT = 'https://serentia-shop.reamaze.com/admin/conversations/'

// The founder reviews escalations without Re:amaze access, so this route is
// gated on SYNC_KEY instead of credentials. The key never appears in the
// public HTML - the board fetches it from /api/founderlink.
function keyOk(request) {
  const key = new URL(request.url).searchParams.get('key') || ''
  return !!process.env.SYNC_KEY && key === process.env.SYNC_KEY
}

export async function GET(request) {
  if (!keyOk(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  await ensureSchema()

  const flagged = {}
  for (const r of await q("SELECT slug, note, updated_at FROM ticket_status WHERE status = 'Founder'")) {
    flagged[r.slug] = { note: r.note || '', updated: new Date(r.updated_at).toISOString() }
  }
  const threads = {}
  for (const m of await q('SELECT slug, author, body, created_at FROM ticket_thread ORDER BY id ASC')) {
    ;(threads[m.slug] ||= []).push({ author: m.author, body: m.body, at: new Date(m.created_at).toISOString() })
  }

  const list = tickets.filter((t) => flagged[t.l]).map((t) => {
    const thread = threads[t.l] || []
    const last = thread[thread.length - 1]
    return {
      group: GROUP_LABEL[t.g] || t.g, g: t.g, customer: t.c, subject: t.s,
      note: flagged[t.l].note, updated: flagged[t.l].updated, thread,
      awaitingFounder: !!last && last.author === 'om',
      waitingSince: t.ld || t.d || null,
      chat: CHAT + t.l, slug: t.l,
    }
  }).sort((a, b) => {
    if (a.awaitingFounder !== b.awaitingFounder) return a.awaitingFounder ? -1 : 1
    const ta = a.waitingSince ? Date.parse(a.waitingSince) : Infinity
    const tb = b.waitingSince ? Date.parse(b.waitingSince) : Infinity
    return ta - tb
  })

  return Response.json({ count: list.length, tickets: list }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request) {
  if (!keyOk(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  await ensureSchema()
  let body = null
  try { body = await request.json() } catch { body = null }
  const slug = typeof body?.slug === 'string' ? body.slug : ''
  const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, 2000) : ''
  if (!okSlug(slug)) return Response.json({ error: 'invalid ticket' }, { status: 400 })
  if (!comment) return Response.json({ error: 'empty message' }, { status: 400 })

  const row = (await q("SELECT slug FROM ticket_status WHERE slug = $1 AND status = 'Founder'", [slug]))[0]
  if (!row) return Response.json({ error: 'not a founder ticket' }, { status: 404 })

  await q(`INSERT INTO ticket_thread (slug, author, body) VALUES ($1, 'founder', $2)`, [slug, comment])
  await q('UPDATE ticket_status SET updated_at = now() WHERE slug = $1', [slug])
  return Response.json({ ok: true })
}
