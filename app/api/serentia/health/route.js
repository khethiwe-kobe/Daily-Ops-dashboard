import { q, resolveConnection } from '../../../../lib/db'
import { ensureSerentia } from '../../../../lib/serentia/db'
import { authMode } from '../../../../lib/serentia/shopify'

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
      SERENTIA_ADMIN_KEY: !!process.env.SERENTIA_ADMIN_KEY,
      SERENTIA_SHOPIFY_TOKEN: !!process.env.SERENTIA_SHOPIFY_TOKEN,
      SERENTIA_SHOPIFY_CLIENT_ID: !!process.env.SERENTIA_SHOPIFY_CLIENT_ID,
      SERENTIA_SHOPIFY_CLIENT_SECRET: !!process.env.SERENTIA_SHOPIFY_CLIENT_SECRET,
      shopifyAuth: authMode(),
      SERENTIA_SHOPIFY_STORE: process.env.SERENTIA_SHOPIFY_STORE || 'not set (required)',
      SERENTIA_LOOP_TOKEN: !!process.env.SERENTIA_LOOP_TOKEN,
      SERENTIA_CLICKUP_TOKEN: !!process.env.SERENTIA_CLICKUP_TOKEN,
    },
    keys: null,
    orders: null,
  }
  try {
    await ensureSerentia()
    out.keys = Number((await q('SELECT COUNT(*)::int AS n FROM ser_access_keys WHERE revoked_at IS NULL'))[0].n)
    out.orders = Number((await q('SELECT COUNT(*)::int AS n FROM ser_orders'))[0].n)
    out.db = 'connected'
  } catch (e) {
    out.ok = false
    out.db = 'error: ' + String(e.message || e).slice(0, 120)
  }
  return Response.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
