import { authed, unauthorized } from '../../../../lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Straight proxy so the browser can read live Re:amaze without tripping CORS.
// It forwards the caller's own credentials and adds none of its own.
export async function GET(request) {
  if (!(await authed(request))) return unauthorized()
  const url = new URL(request.url)
  const brand = (request.headers.get('x-reamaze-brand') || '').replace(/[^a-z0-9-]/gi, '')
  const page = String(Number(url.searchParams.get('page') || 1) || 1)
  const filter = (url.searchParams.get('filter') || '').replace(/[^a-z]/gi, '')

  const target = `https://${brand}.reamaze.io/api/v1/conversations?page=${page}` +
    (filter ? `&filter=${filter}` : '')
  const r = await fetch(target, {
    headers: {
      Accept: 'application/json',
      Authorization: request.headers.get('authorization') || '',
      'User-Agent': 'serentia-dashboard',
    },
  })
  if (!r.ok) return Response.json({ error: 'reamaze ' + r.status }, { status: r.status })
  return Response.json(await r.json(), { headers: { 'Cache-Control': 'no-store' } })
}
