import { q } from '../db'
import { ensureInnaderm, logEvent } from './db'

// Operating inputs the dashboard cannot read from any system: stock the team
// counted, lead times the supplier quoted, MOQs. Defaults come from Calvin's
// brief (12 Oct call); anything marked null must be filled in before the
// reorder panel will commit to a date.
export const DEFAULTS = {
  // Stock on hand
  finished_source: 'shopify',          // 'shopify' = sum tracked variants, 'manual' = finished_on_hand
  finished_on_hand: null,              // units, used when finished_source = 'manual'
  finished_counted_at: null,
  packaging_on_hand: null,             // units of packaging
  packaging_counted_at: null,
  // Lead times (days)
  lead_finished_with_packaging: 10,    // "if we have packaging, they only need like 10 days"
  lead_finished_without_packaging: 22, // "it takes 22 days ... because they can't start unless they have the packaging"
  lead_packaging: null,                // never given in the brief - confirm with Calvin
  // Order sizes
  moq_finished: null,
  moq_packaging: null,
  unit_cost_finished: null,
  unit_cost_packaging: null,
  // Demand model
  baseline_days: 14,                   // run-rate window for new (non-renewal) orders
  scale_pct: 20,                       // "we scale budgets by 20% per day"
  scale_days_default: 3,               // last breakthrough ran 3 days
  safety_days: 7,                      // buffer added on top of lead time
  packaging_per_unit: 1,               // packaging units consumed per finished unit shipped
  // Sources
  tracked_variant_ids: [],             // empty = every tracked variant counts as finished goods
  // Stock on its way that Shopify does not show yet. Never counted as on hand:
  // an entry stays "pending" until the team marks it received once the units
  // appear in Shopify (finished goods) or are counted at the factory (packaging).
  // Seeded from Ava's (supplier) Slack message to Calvin, 26 Oct 2026.
  inbound_stock: [
    { id: 'fg-2026-10-25', item: 'finished', units: 2374, status: 'in_transit', to: 'Zendrop', shipped: '2026-10-25', eta: '2026-11-03',
      eta_text: 'early next week (week of 2 Nov)', note: 'Shipped to Zendrop 25 Oct. Part 1 of 3,000.', source: 'Ava on Slack, 26 Oct', received_at: null },
    { id: 'fg-batch-2', item: 'finished', units: 626, status: 'waiting_packaging', to: 'Zendrop', shipped: null, eta: null,
      eta_text: 'next batch, after the bags reach the capsule factory (early Nov)', note: 'Rest of the 3,000. Held back because there were not enough bags.', source: 'Ava on Slack, 26 Oct', received_at: null },
    { id: 'bags-2026-11', item: 'packaging', units: 4000, status: 'ordered', to: 'Capsule factory', shipped: null, eta: '2026-11-06',
      eta_text: 'early November', note: 'The "4K" bags, plus extra bags the producer is adding to cover the 626. Confirm with Ava that 4K means 4,000 bags and how many extra.', source: 'Ava on Slack, 26 Oct', received_at: null },
  ],
  clickup_lists: [
    { id: '1500890000000464', name: 'Founder Escalations' },
    { id: '901216052461', name: 'Ops Overview' },
  ],
  zendrop_sheet_id: '1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY',
  zendrop_note: 'Sheet currently shared is the Serentia (SER) Zendrop sheet. Point this at the Innaderm sheet when Zendrop provides one.',
  // Customer service (support Gmail)
  cs_response_target_hours: 24,        // Calvin: "keep it under 24 hours"
  cs_timezone: 'Africa/Johannesburg',  // hour-of-day chart is shown in the team's time
  dispute_rate_pct: 0.9,               // Innaderm on the 12 Oct call; update from Shopify Payments
  dispute_threshold_pct: 1,            // processor hold at 1%
  dispute_rate_at: '2026-10-12',
  // Support board
  cs_ship_eta_text: '',                // e.g. "Friday 31 October"; blank = drafts ask the agent to confirm with Calvin
  cs_discount_code: 'WELCOME15',       // handover doc, 4 Oct
  cs_minutes_per_ticket: 6,            // handling time used for hours-saved estimates
  cs_autodraft_signature: 'The Innaderm Team',
  cs_founder_list_id: '1500890000000464', // ClickUp Operations > Innaderm > Founder Escalations (Serentia's is 901222538715)
  cs_founder_user_id: 278464620,       // Calvin
}

export const INBOUND_STATUS = ['ordered', 'waiting_packaging', 'in_transit', 'received']

const NUMERIC = new Set([
  'finished_on_hand', 'packaging_on_hand', 'lead_finished_with_packaging', 'lead_finished_without_packaging',
  'lead_packaging', 'moq_finished', 'moq_packaging', 'unit_cost_finished', 'unit_cost_packaging',
  'baseline_days', 'scale_pct', 'scale_days_default', 'safety_days', 'packaging_per_unit',
  'cs_response_target_hours', 'dispute_rate_pct', 'dispute_threshold_pct', 'cs_minutes_per_ticket', 'cs_founder_user_id',
])
const LIMITS = {
  baseline_days: [3, 90], scale_pct: [0, 100], scale_days_default: [0, 30], safety_days: [0, 60], packaging_per_unit: [0, 20],
  cs_response_target_hours: [1, 168], dispute_rate_pct: [0, 100], dispute_threshold_pct: [0, 100], cs_minutes_per_ticket: [1, 60],
  cs_founder_user_id: [1, 1e12],
}

export async function getSettings() {
  await ensureInnaderm()
  const rows = await q('SELECT key, value, updated_at, updated_by FROM inn_settings')
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
    } else if (k === 'finished_source') {
      if (v !== 'shopify' && v !== 'manual') { errors.push('finished_source must be shopify or manual'); continue }
      clean[k] = v
    } else if (k === 'inbound_stock') {
      if (!Array.isArray(v)) { errors.push('inbound_stock must be a list'); continue }
      const day = (x) => (x && /^\d{4}-\d{2}-\d{2}$/.test(String(x)) ? String(x) : null)
      clean[k] = v.slice(0, 30).map((x, i) => ({
        id: String(x?.id || `in-${Date.now()}-${i}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
        item: x?.item === 'packaging' ? 'packaging' : 'finished',
        units: Math.max(0, Math.round(Number(x?.units) || 0)),
        status: INBOUND_STATUS.includes(x?.status) ? x.status : 'ordered',
        to: String(x?.to || '').slice(0, 60), shipped: day(x?.shipped), eta: day(x?.eta),
        eta_text: String(x?.eta_text || '').slice(0, 120), note: String(x?.note || '').slice(0, 300), source: String(x?.source || '').slice(0, 120),
        received_at: x?.status === 'received' ? (x?.received_at || new Date().toISOString()) : null,
      })).filter((x) => x.units > 0)
    } else if (k === 'tracked_variant_ids') {
      if (!Array.isArray(v)) { errors.push('tracked_variant_ids must be a list'); continue }
      clean[k] = v.map(String).filter((s) => /^[0-9]{3,20}$/.test(s)).slice(0, 200)
    } else if (k === 'clickup_lists') {
      if (!Array.isArray(v)) { errors.push('clickup_lists must be a list'); continue }
      clean[k] = v
        .filter((x) => x && /^[0-9]{6,20}$/.test(String(x.id)))
        .map((x) => ({ id: String(x.id), name: String(x.name || '').slice(0, 80) }))
        .slice(0, 12)
    } else if (k === 'zendrop_sheet_id') {
      if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(v))) { errors.push('zendrop_sheet_id does not look like a Google Sheet id'); continue }
      clean[k] = String(v)
    } else if (k === 'cs_timezone') {
      try { new Intl.DateTimeFormat('en-GB', { timeZone: String(v) }) } catch { errors.push('cs_timezone is not a valid time zone'); continue }
      clean[k] = String(v)
    } else if (k === 'cs_founder_list_id') {
      if (!/^[0-9]{6,20}$/.test(String(v))) { errors.push('cs_founder_list_id must be a ClickUp list id'); continue }
      clean[k] = String(v)
    } else if (k === 'dispute_rate_at') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) { errors.push('dispute_rate_at must be YYYY-MM-DD'); continue }
      clean[k] = String(v)
    } else if (typeof v === 'string') {
      clean[k] = v.slice(0, 500)
    }
  }
  return { clean, errors }
}

export async function saveSettings(patch, actor) {
  await ensureInnaderm()
  const { clean, errors } = sanitise(patch)
  const keys = Object.keys(clean)
  if (!keys.length) return { saved: [], errors: errors.length ? errors : ['nothing to save'] }
  for (const k of keys) {
    await q(
      `INSERT INTO inn_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [k, JSON.stringify(clean[k]), actor],
    )
  }
  await logEvent(actor, 'settings.update', clean)
  return { saved: keys, errors }
}
