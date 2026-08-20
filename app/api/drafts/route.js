import { authed, unauthorized } from '../../../lib/auth'
import drafts from '../../../data/drafts.json'

export const runtime = 'nodejs'

export async function GET(request) {
  if (!(await authed(request))) return unauthorized()
  return Response.json(drafts, { headers: { 'Cache-Control': 'no-store' } })
}
