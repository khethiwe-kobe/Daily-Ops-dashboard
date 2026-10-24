import { q } from '../db'
import { ensureSerentia, logEvent } from './db'

// Operating inputs the dashboard cannot read from any system: where stock is
// counted, the shades, Zendrop's lead time and MOQ, the Black Friday
// scenario. Serentia is dropshipped, so stock sits with Zendrop and the
// Inventory tab of the Zendrop sheet is the default count.
export const DEFAULTS = {
  // Stock on hand, per shade
  stock_source: 'zendrop',             // 'zendrop' = Inventory tab of the Zendrop sheet, 'shopify' = tracked variants
  zendrop_inventory_gid: null,         // gid of the Inventory tab (from its URL); null = look the tab up by name
  zendrop_inventory_tab: 'Inventory',
  zendrop_inventory_products: ['3373424'], // Zendrop product ids to count (current Elixir+ Cream version)
  shades: ['Ivory', 'Buff Beige', 'Warm Honey', 'Honey Almond', 'Caramel Glow', 'Deep Mocha', 'Hazelnut'],
  // Reorder inputs
  lead_days: 10,                       // Zendrop sheet: "The production cycle is about 10 days"
  safety_days: 7,                      // buffer added on top of lead time
  moq_units: 2500,                     // Zendrop sheet MOQ, per product order
  unit_cost: null,
  // Demand model
  baseline_days: 14,                   // run-rate window for new (non-renewal) orders
  bf_start: '2026-11-26',              // early access (Black Friday email, 11 Nov)
  bf_end: '2026-12-01',                // through Cyber Monday
  bf_multiplier: 3,                    // new-order demand during the window vs normal; set from last year's lift
  cover_until: '2026-12-31',           // order enough to last until this date (+ safety)
  // Sources
  clickup_lists: [],
  zendrop_sheet_id: '1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY',
}

const NUMERIC = new Set(['lead_days', 'safety_days', 'moq_units', 'unit_cost', 'baseline_days', 'bf_multiplier'])
const DATES = new Set(['bf_start', 'bf_end', 'cover_until'])
const LIMITS = { lead_days: [0, 120], safety_days: [0, 60], baseline_days: [3, 90], bf_multiplier: [1, 20] }

export async function getSettings() {
  await ensureSerentia()
  const rows = await q('SELECT key, value, updated_at, updated_by FROM ser_settings')
  const out = { ...DEFAULTS }
  const meta = {}
  for (const r of rows) {
    if (r.key in DEFAULTS) {
      out[r.key] = r.value
      meta[r.key] = { at: new Date(r.updated_at).toISOString(), by: r.updated_by }
    }
  }
  return { settings: out, meta }
}

// Validates a partial update against the defaults' shape; unknown keys are
// dropped, numbers are coerced and range-checked, nulls clear a value.
export function sanitise(patch) {
  const clean = {}
  const errors = []
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue
    if (v === null || v === '') { clean[k] = null; continue }
    if (NUMERIC.has(k)) {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) { errors.push(`${k} must be a number`); continue }
      const [lo, hi] = LIMITS[k] || [0, 1e9]
      if (n < lo || n > hi) { errors.push(`${k} must be between ${lo} and ${hi}`); continue }
      clean[k] = n
    } else if (k === 'stock_source') {
      if (v !== 'zendrop' && v !== 'shopify') { errors.push('stock_source must be zendrop or shopify'); continue }
      clean[k] = v
    } else if (DATES.has(k)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) { errors.push(`${k} must be YYYY-MM-DD`); continue }
      clean[k] = String(v)
    } else if (k === 'shades') {
      const list = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim().slice(0, 40)).filter(Boolean)
      if (!list.length) { errors.push('shades needs at least one name'); continue }
      clean[k] = list.slice(0, 30)
    } else if (k === 'zendrop_inventory_products') {
      const list = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter((x) => /^[0-9]{3,20}$/.test(x))
      if (!list.length) { errors.push('zendrop_inventory_products needs at least one product id'); continue }
      clean[k] = list.slice(0, 20)
    } else if (k === 'zendrop_inventory_gid') {
      if (!/^[0-9]{1,15}$/.test(String(v))) { errors.push('zendrop_inventory_gid must be the number after gid= in the tab URL'); continue }
      clean[k] = String(v)
    } else if (k === 'clickup_lists') {
      if (!Array.isArray(v)) { errors.push('clickup_lists must be a list'); continue }
      clean[k] = v
        .filter((x) => x && /^[0-9]{6,20}$/.test(String(x.id)))
        .map((x) => ({ id: String(x.id), name: String(x.name || '').slice(0, 80) }))
        .slice(0, 12)
    } else if (k === 'zendrop_sheet_id') {
      if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(v))) { errors.push('zendrop_sheet_id does not look like a Google Sheet id'); continue }
      clean[k] = String(v)
    } else if (typeof v === 'string') {
      clean[k] = v.slice(0, 500)
    }
  }
  return { clean, errors }
}

export async function saveSettings(patch, actor) {
  await ensureSerentia()
  const { clean, errors } = sanitise(patch)
  const keys = Object.keys(clean)
  if (!keys.length) return { saved: [], errors: errors.length ? errors : ['nothing to save'] }
  for (const k of keys) {
    await q(
      `INSERT INTO ser_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [k, JSON.stringify(clean[k]), actor],
    )
  }
  await logEvent(actor, 'settings.update', clean)
  return { saved: keys, errors }
}
