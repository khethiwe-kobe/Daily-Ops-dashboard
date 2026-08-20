import { q, ensureSchema, db } from '../../../lib/db'
import seed from '../../../data/seed-status.json'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// One-time import of the board state carried over from the old Cloudflare/D1
// build. Gated on SYNC_KEY and idempotent, so hitting it twice is harmless:
// statuses upsert, and a thread message is only inserted if an identical
// (slug, author, body) is not already there.
//
// Visit /api/seed?key=<SYNC_KEY> in a browser. Add &force=1 to re-run once the
// database already holds rows.
export async function GET(request) {
  const url = new URL(request.url)
  if (!process.env.SYNC_KEY || url.searchParams.get('key') !== process.env.SYNC_KEY) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  await ensureSchema()

  const existing = Number((await q('SELECT COUNT(*)::int AS n FROM ticket_status'))[0].n)
  if (existing > 0 && url.searchParams.get('force') !== '1') {
    return Response.json({
      ok: false,
      message: `Database already holds ${existing} statuses. Add &force=1 to import anyway.`,
      statuses: existing,
    })
  }

  // Read the fields off the module rather than destructuring with defaults:
  // the RSC transform rewrites JSON-module bindings and chokes on that form.
  const statuses = seed.statuses || {}
  const notes = seed.notes || {}
  const threads = seed.threads || {}
  const updated = seed.updated || {}
  const client = await db().connect()
  let wrote = 0, msgs = 0, skipped = 0
  try {
    await client.query('BEGIN')
    for (const slug of new Set([...Object.keys(statuses), ...Object.keys(notes)])) {
      await client.query(
        `INSERT INTO ticket_status (slug, status, note, updated_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
         ON CONFLICT (slug) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note,
           updated_at = EXCLUDED.updated_at`,
        [slug, statuses[slug] || null, notes[slug] || null, updated[slug] || null])
      wrote++
    }
    for (const [slug, list] of Object.entries(threads)) {
      for (const m of list) {
        const dup = await client.query(
          'SELECT 1 FROM ticket_thread WHERE slug = $1 AND author = $2 AND body = $3 LIMIT 1',
          [slug, m.author, m.body])
        if (dup.rowCount) { skipped++; continue }
        await client.query(
          'INSERT INTO ticket_thread (slug, author, body, created_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))',
          [slug, m.author, m.body, m.at || null])
        msgs++
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    return Response.json({ ok: false, error: String(e.message || e).slice(0, 200) }, { status: 500 })
  } finally {
    client.release()
  }

  const now = (await q('SELECT (SELECT COUNT(*)::int FROM ticket_status) s, (SELECT COUNT(*)::int FROM ticket_thread) t'))[0]
  return Response.json({
    ok: true,
    imported: { statuses: wrote, threadMessages: msgs, alreadyPresent: skipped },
    database: { statuses: Number(now.s), threadMessages: Number(now.t) },
  })
}
