import { q, ensureSchema } from '../../../lib/db'
import { authed, okSlug, unauthorized } from '../../../lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const OK_STATUSES = new Set(['Draft', 'Sent', 'Awaiting', 'Founder', 'Zsheet', 'Zslack', 'Done', 'Skip'])

export async function GET(request) {
  if (!(await authed(request))) return unauthorized()
  await ensureSchema()
  const rows = await q('SELECT slug, status, note, updated_at FROM ticket_status')
  const statuses = {}, notes = {}, updated = {}
  for (const r of rows) {
    if (r.status) statuses[r.slug] = r.status
    if (r.note) notes[r.slug] = r.note
    // The board compares this against the customer's newest message to spot
    // tickets that came back after being parked or closed.
    if (r.updated_at) updated[r.slug] = new Date(r.updated_at).toISOString()
  }
  const threads = {}
  for (const m of await q('SELECT slug, author, body, created_at FROM ticket_thread ORDER BY id ASC')) {
    ;(threads[m.slug] ||= []).push({ author: m.author, body: m.body, at: new Date(m.created_at).toISOString() })
  }
  return Response.json({ statuses, notes, threads, updated }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request) {
  if (!(await authed(request))) return unauthorized()
  await ensureSchema()
  let body = null
  try { body = await request.json() } catch { body = null }

  const statusEntries = Object.entries(body?.statuses || {})
    .filter(([s, v]) => okSlug(s) && typeof v === 'string' && OK_STATUSES.has(v)).slice(0, 300)
  const noteEntries = Object.entries(body?.notes || {})
    .filter(([s, v]) => okSlug(s) && typeof v === 'string')
    .map(([s, v]) => [s, v.slice(0, 2000)]).slice(0, 300)
  const replyEntries = Object.entries(body?.omReplies || {})
    .filter(([s, v]) => okSlug(s) && typeof v === 'string' && v.trim())
    .map(([s, v]) => [s, v.trim().slice(0, 2000)]).slice(0, 300)

  if (!statusEntries.length && !noteEntries.length && !replyEntries.length) {
    return Response.json({ error: 'nothing to save' }, { status: 400 })
  }

  const client = await (await import('../../../lib/db')).db().connect()
  try {
    await client.query('BEGIN')
    for (const [slug, status] of statusEntries) {
      await client.query(
        `INSERT INTO ticket_status (slug, status, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (slug) DO UPDATE SET status = $2, updated_at = now()`, [slug, status])
    }
    for (const [slug, note] of noteEntries) {
      await client.query(
        `INSERT INTO ticket_status (slug, status, note, updated_at) VALUES ($1, 'Draft', $2, now())
         ON CONFLICT (slug) DO UPDATE SET note = $2, updated_at = now()`, [slug, note])
    }
    for (const [slug, msg] of replyEntries) {
      // Append, never overwrite - the founder thread is a conversation.
      await client.query(`INSERT INTO ticket_thread (slug, author, body) VALUES ($1, 'om', $2)`, [slug, msg])
      await client.query(`UPDATE ticket_status SET updated_at = now() WHERE slug = $1`, [slug])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    return Response.json({ error: 'save failed' }, { status: 500 })
  } finally {
    client.release()
  }
  return Response.json({ ok: true, saved: statusEntries.length + noteEntries.length + replyEntries.length })
}
