import { q, resolveConnection } from '../../../../lib/db'
import { ensureInnaderm } from '../../../../lib/innaderm/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Unauthenticated. Says which integrations have their secret set and whether
// the database answers - nothing about the data itself.
export async function GET() {
  const out = {
    ok: true,
    db: 'unknown',
    dbVar: resolveConnection().name || 'none',
    env: {
      INNADERM_ADMIN_KEY: !!process.env.INNADERM_ADMIN_KEY,
      INNADERM_SHOPIFY_TOKEN: !!process.env.INNADERM_SHOPIFY_TOKEN,
      INNADERM_SHOPIFY_STORE: process.env.INNADERM_SHOPIFY_STORE || 'default (f4f3a5-ad.myshopify.com)',
      INNADERM_LOOP_TOKEN: !!process.env.INNADERM_LOOP_TOKEN,
      INNADERM_CLICKUP_TOKEN: !!process.env.INNADERM_CLICKUP_TOKEN,
    },
    keys: null,
    orders: null,
  }
  try {
    await ensureInnaderm()
    out.keys = Number((await q('SELECT COUNT(*)::int AS n FROM inn_access_keys WHERE revoked_at IS NULL'))[0].n)
    out.orders = Number((await q('SELECT COUNT(*)::int AS n FROM inn_orders'))[0].n)
    out.db = 'connected'
  } catch (e) {
    out.ok = false
    out.db = 'error: ' + String(e.message || e).slice(0, 120)
  }
  return Response.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
