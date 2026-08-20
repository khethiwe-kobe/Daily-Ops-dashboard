// The board is gated on the caller's own Re:amaze credentials: the browser
// sends them, we verify them against Re:amaze itself, and only then touch the
// database. No separate password to manage, and revoking the Re:amaze token
// revokes the dashboard with it.
export async function authed(request) {
  const brand = (request.headers.get('x-reamaze-brand') || '').replace(/[^a-z0-9-]/gi, '')
  const auth = request.headers.get('authorization') || ''
  if (!brand || !auth) return false
  try {
    const r = await fetch(`https://${brand}.reamaze.com/api/v1/conversations?page=1`, {
      headers: { Accept: 'application/json', Authorization: auth, 'User-Agent': 'serentia-dashboard' },
    })
    return r.status === 200
  } catch {
    return false
  }
}

export const okSlug = (s) => typeof s === 'string' && /^[a-z0-9$._-]{1,300}$/.test(s)

export function unauthorized() {
  return Response.json({ error: 'unauthorized' }, { status: 401 })
}
