import { authed, unauthorized } from '../../../lib/auth'
import tickets from '../../../data/tickets.json'

export const runtime = 'nodejs'

export async function GET(request) {
  if (!(await authed(request))) return unauthorized()
  return Response.json({ tickets }, { headers: { 'Cache-Control': 'no-store' } })
}
