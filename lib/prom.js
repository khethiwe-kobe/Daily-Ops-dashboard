import { createHash, timingSafeEqual } from 'node:crypto'
import { q } from './db'

export const NO_STORE = { 'Cache-Control': 'no-store' }

export async function getSetting(key) {
  const row = (await q('SELECT value FROM prom_settings WHERE key = $1', [key]))[0]
  return row ? row.value : null
}

export async function setSetting(key, value) {
  await q(
    `INSERT INTO prom_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  )
}

export const hashKey = (s) => createHash('sha256').update(String(s)).digest('hex')

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

// The organiser's key, taken from ?key= or the JSON body. Accepts either the
// board's own key (set once through /api/prom/setup and stored hashed) or
// SYNC_KEY, so the founder's existing key keeps working too.
export async function organiser(request, body) {
  const fromUrl = new URL(request.url).searchParams.get('key') || ''
  const key = (typeof body?.key === 'string' && body.key) || fromUrl
  if (!key) return false
  if (process.env.SYNC_KEY && same(key, process.env.SYNC_KEY)) return true
  const stored = await getSetting('access_key_hash')
  return !!stored && same(hashKey(key), stored)
}

// Voting is closed by the organiser's switch on the board or by the
// PROM_VOTING_CLOSED environment variable, whichever says closed.
export async function votingOpen() {
  if (/^(1|true|yes)$/i.test(process.env.PROM_VOTING_CLOSED || '')) return false
  return (await getSetting('voting')) !== 'closed'
}

export const unauthorized = () => Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE })
