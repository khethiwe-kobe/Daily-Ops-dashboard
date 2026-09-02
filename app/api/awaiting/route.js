import { authed, unauthorized } from '../../../lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Which conversations currently have the CUSTOMER as the last speaker.
//
// The board's ticket file is rebuilt once a day, so between refreshes it
// cannot know that you have since answered someone in Re:amaze. This asks
// Re:amaze directly, so a ticket leaves "They replied" as soon as your reply
// lands rather than the next morning.
//
// Status enum: 0 Open, 1 Responded, 2 Done, 3 Spam, 4 Archived, 5 On Hold,
// 6 Auto-Done, 7 AI Agent Assigned, 8 AI Agent Done, 9 Spam (AI).
// The ball is with us only at 0, 5 and 7 - status 1 means we replied last.
const AWAITING = new Set([0, 5, 7])

export async function GET(request) {
  if (!(await authed(request))) return unauthorized()
  const brand = (request.headers.get('x-reamaze-brand') || '').replace(/[^a-z0-9-]/gi, '')
  const auth = request.headers.get('authorization') || ''
  const H = { Accept: 'application/json', Authorization: auth, 'User-Agent': 'serentia-dashboard' }
  const url = (p) => `https://${brand}.reamaze.io/api/v1/conversations?page=${p}`

  const get = async (p) => {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(url(p), { headers: H })
        if (r.ok) return r.json()
        if (![429, 502, 503, 504].includes(r.status)) return null
      } catch { /* retry */ }
      await new Promise((s) => setTimeout(s, 400 * (a + 1)))
    }
    return null
  }

  const first = await get(1)
  if (!first) return Response.json({ error: 'reamaze unreachable' }, { status: 502 })

  const slugs = []
  const take = (list) => {
    for (const c of list || []) if (AWAITING.has(c.status)) slugs.push(c.slug)
  }
  take(first.conversations)

  const pages = []
  for (let p = 2; p <= (first.page_count || 1); p++) pages.push(p)
  for (let i = 0; i < pages.length; i += 10) {
    const batch = await Promise.all(pages.slice(i, i + 10).map(get))
    for (const j of batch) take(j?.conversations)
  }

  return Response.json(
    { slugs, count: slugs.length, scanned: first.total_count || null, at: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
