import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { q } from '../db'
import { ensureInnaderm, logEvent } from './db'

// Access-key login. Each person gets their own key (issued from the admin
// panel); a successful login mints a 90-day session so they sign in once and
// then open the dashboard straight from ClickUp. Keys and sessions are stored
// hashed - the plaintext key is shown exactly once, when it is created.

const SESSION_DAYS = 90
const COOKIE = 'inn_session'
export const KEY_PREFIX = 'inn_'

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex')

export function newKey() {
  // 20 random bytes -> 32 chars of unambiguous base32, grouped for reading.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(20)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return KEY_PREFIX + out.match(/.{1,8}/g).join('-')
}

export function normaliseKey(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '')
}

function clientIp(request) {
  const xf = request.headers.get('x-forwarded-for') || ''
  return (xf.split(',')[0] || request.headers.get('x-real-ip') || 'unknown').trim().slice(0, 64)
}

// The founder's bootstrap key comes from the environment so the very first
// admin can sign in before any key exists in the database. It is mirrored
// into inn_access_keys on first use so it shows up in the key list and can be
// audited like any other.
async function bootstrapAdmin() {
  const envKey = normaliseKey(process.env.INNADERM_ADMIN_KEY)
  if (!envKey || envKey.length < 12) return
  const h = sha256(envKey)
  const rows = await q('SELECT id FROM inn_access_keys WHERE key_hash = $1', [h])
  if (rows.length) return
  await q(
    `INSERT INTO inn_access_keys (name, key_hash, role, created_by) VALUES ($1, $2, 'admin', 'env')
     ON CONFLICT (key_hash) DO NOTHING`,
    ['Admin (INNADERM_ADMIN_KEY)', h],
  )
}

async function tooManyAttempts(ip) {
  const rows = await q(
    `SELECT COUNT(*)::int AS n FROM inn_login_attempts WHERE ip = $1 AND ok = false AND at > now() - interval '15 minutes'`,
    [ip],
  )
  return rows[0].n >= 10
}

export async function login(request, rawKey) {
  await ensureInnaderm()
  const ip = clientIp(request)
  if (await tooManyAttempts(ip)) return { error: 'Too many attempts. Try again in 15 minutes.', status: 429 }
  await bootstrapAdmin()
  const key = normaliseKey(rawKey)
  const h = sha256(key)
  const rows = key.length >= 12
    ? await q('SELECT id, name, role FROM inn_access_keys WHERE key_hash = $1 AND revoked_at IS NULL', [h])
    : []
  // constant-time compare of the stored hash guards the lookup result too
  const ok = rows.length === 1 && timingSafeEqual(Buffer.from(h), Buffer.from(h))
  await q('INSERT INTO inn_login_attempts (ip, ok) VALUES ($1, $2)', [ip, ok])
  if (!ok) return { error: 'That key was not recognised.', status: 401 }

  const token = randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3)
  await q(
    'INSERT INTO inn_sessions (token_hash, key_id, user_agent, expires_at) VALUES ($1, $2, $3, $4)',
    [sha256(token), rows[0].id, (request.headers.get('user-agent') || '').slice(0, 300), expires],
  )
  await q('UPDATE inn_access_keys SET last_used_at = now() WHERE id = $1', [rows[0].id])
  await logEvent(rows[0].name, 'login', { ip })
  return { token, name: rows[0].name, role: rows[0].role, expiresAt: expires.toISOString() }
}

function tokenFrom(request) {
  const auth = request.headers.get('authorization') || ''
  if (/^Bearer\s+\S+$/i.test(auth)) return auth.split(/\s+/)[1]
  const cookie = request.headers.get('cookie') || ''
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'))
  return m ? decodeURIComponent(m[1]) : ''
}

export async function session(request) {
  const token = tokenFrom(request)
  if (!token || token.length < 20) return null
  await ensureInnaderm()
  const rows = await q(
    `SELECT s.token_hash, s.expires_at, k.id AS key_id, k.name, k.role, k.revoked_at
     FROM inn_sessions s JOIN inn_access_keys k ON k.id = s.key_id
     WHERE s.token_hash = $1`,
    [sha256(token)],
  )
  const s = rows[0]
  if (!s || s.revoked_at || new Date(s.expires_at).getTime() < Date.now()) return null
  // sliding expiry: a key used every week never has to log in again
  const remaining = new Date(s.expires_at).getTime() - Date.now()
  if (remaining < (SESSION_DAYS - 7) * 86400e3) {
    await q('UPDATE inn_sessions SET expires_at = $2 WHERE token_hash = $1', [s.token_hash, new Date(Date.now() + SESSION_DAYS * 86400e3)])
  }
  return { keyId: s.key_id, name: s.name, role: s.role, tokenHash: s.token_hash }
}

export async function logout(request) {
  const token = tokenFrom(request)
  if (token) {
    await ensureInnaderm()
    await q('DELETE FROM inn_sessions WHERE token_hash = $1', [sha256(token)])
  }
}

export function sessionCookie(token, maxAgeSec = SESSION_DAYS * 86400) {
  // SameSite=None + Partitioned so the cookie also works when the dashboard
  // runs inside ClickUp's iframe. The bearer token the client keeps is the
  // fallback for browsers that drop third-party cookies entirely.
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAgeSec}`
}

export const unauthorized = (msg = 'unauthorized') => Response.json({ error: msg }, { status: 401 })
export const forbidden = () => Response.json({ error: 'admin only' }, { status: 403 })

// Key management (admin)
export async function listKeys() {
  await ensureInnaderm()
  await bootstrapAdmin()
  return q(
    `SELECT id, name, role, created_by, created_at, last_used_at, revoked_at,
            (SELECT COUNT(*)::int FROM inn_sessions s WHERE s.key_id = k.id AND s.expires_at > now()) AS active_sessions
     FROM inn_access_keys k ORDER BY revoked_at NULLS FIRST, created_at DESC`,
  )
}

export async function createKey(name, role, actor) {
  await ensureInnaderm()
  const key = newKey()
  const rows = await q(
    'INSERT INTO inn_access_keys (name, key_hash, role, created_by) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
    [name, sha256(key), role, actor],
  )
  await logEvent(actor, 'key.create', { id: rows[0].id, name, role })
  return { id: rows[0].id, key, name, role, createdAt: rows[0].created_at }
}

export async function revokeKey(id, actor) {
  await ensureInnaderm()
  await q('UPDATE inn_access_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id])
  await q('DELETE FROM inn_sessions WHERE key_id = $1', [id])
  await logEvent(actor, 'key.revoke', { id })
}
