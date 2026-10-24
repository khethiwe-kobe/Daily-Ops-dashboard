import * as shopify from './shopify'
import { fulfilment, runRate, variantDemand } from './metrics'
import { loopConfigured, loopRenewals, clickupConfigured, clickupLists, zendropIssues, zendropInventory } from './sources'
import { getSettings } from './settings'
import { ensureSerentia } from './db'

// One call assembles the whole board. Every source is isolated: a failing
// upstream returns {error} for its own block and the rest still renders.
const safe = (p) => p.then((v) => v).catch((e) => ({ error: String(e?.message || e).slice(0, 240) }))

// Shades are matched by name across Shopify line items, Shopify variants, the
// Zendrop sheet and Loop lines, which all spell them differently ("Buff
// Beige", "buff beige", "...-version 02nature"). Longest name first so "Warm
// Honey" never claims a "Honey Almond" row.
const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')
function matcher(shades) {
  const list = shades.map((name) => ({ name, key: norm(name) })).filter((s) => s.key).sort((a, b) => b.key.length - a.key.length)
  return (...texts) => {
    const t = norm(texts.filter(Boolean).join(' '))
    return list.find((s) => t.includes(s.key))?.name || null
  }
}

export async function overview({ days = 7 } = {}) {
  await ensureSerentia()
  const { settings, meta } = await getSettings()
  const shopifyOn = shopify.configured()
  const S = settings

  const [sync, ful, rate, demand, inv, zinv, loop, cu, zd] = await Promise.all([
    safe(shopify.syncState()),
    shopifyOn ? safe(fulfilment(days)) : Promise.resolve(null),
    shopifyOn ? safe(runRate(S.baseline_days)) : Promise.resolve(null),
    shopifyOn ? safe(variantDemand(S.baseline_days)) : Promise.resolve(null),
    shopifyOn && S.stock_source === 'shopify' ? safe(shopify.inventory()) : Promise.resolve(null),
    S.stock_source === 'zendrop'
      ? safe(zendropInventory(S.zendrop_sheet_id, { gid: S.zendrop_inventory_gid, tab: S.zendrop_inventory_tab, products: S.zendrop_inventory_products }))
      : Promise.resolve(null),
    loopConfigured() ? safe(loopRenewals()) : Promise.resolve(null),
    clickupConfigured() && S.clickup_lists.length ? safe(clickupLists(S.clickup_lists)) : Promise.resolve(null),
    safe(zendropIssues(S.zendrop_sheet_id)),
  ])

  const shadeOf = matcher(S.shades)
  const shades = Object.fromEntries(S.shades.map((name) => [name, {
    name, onHand: null, stockDate: null, newUnits: 0, priorNewUnits: 0, renewals30: 0, variantIds: [],
  }]))

  // Stock on hand
  let stock = { source: S.stock_source, error: null, url: null, countedAt: null, unmatched: [] }
  if (S.stock_source === 'zendrop') {
    if (zinv?.error) stock.error = zinv.error
    stock.url = zinv?.url || null
    stock.countedAt = zinv?.cachedAt || null
    for (const it of zinv?.items || []) {
      const name = shadeOf(it.variant, it.sku)
      if (!name) { stock.unmatched.push({ label: it.variant || it.sku, units: it.units }); continue }
      shades[name].onHand = (shades[name].onHand || 0) + it.units
      if (it.updated) shades[name].stockDate = it.updated
    }
  } else {
    if (inv?.error) stock.error = inv.error
    stock.countedAt = inv?.cachedAt || null
    for (const v of (inv?.variants || []).filter((x) => x.tracked)) {
      const name = shadeOf(v.title, v.sku)
      if (!name) continue
      shades[name].onHand = (shades[name].onHand || 0) + v.onHand
    }
  }

  // Demand from order line items
  const unmatchedDemand = []
  const variantShade = {}
  for (const r of Array.isArray(demand) ? demand : []) {
    const name = shadeOf(r.variant_title, r.title, r.sku)
    if (!name) { if (r.new_units) unmatchedDemand.push({ label: [r.title, r.variant_title].filter(Boolean).join(' · '), units: r.new_units }); continue }
    const sh = shades[name]
    sh.newUnits += r.new_units
    sh.priorNewUnits += r.prior_new_units
    sh.renewals30 += r.renewal_units_30
    if (r.variant_id) { sh.variantIds.push(String(r.variant_id)); variantShade[String(r.variant_id)] = name }
  }

  // Renewals: Loop's schedule when connected (exact, next 30 days), else the
  // renewal orders billed in the last 30 days as an estimate of the next 30.
  let renewalsSource = 'estimate'
  let renewalsUnmatched = 0
  if (loop && !loop.error) {
    renewalsSource = 'loop'
    for (const sh of Object.values(shades)) sh.renewals30 = 0
    for (const l of loop.byVariant || []) {
      const name = (l.variantId && variantShade[l.variantId]) || shadeOf(l.label)
      if (name) shades[name].renewals30 += l.units
      else renewalsUnmatched += l.units
    }
  }

  const b = S.baseline_days
  return {
    generatedAt: new Date().toISOString(),
    days,
    integrations: {
      shopify: { configured: shopifyOn, store: shopify.store() || null, sync: sync && !sync.error ? sync : null, error: sync?.error || null },
      loop: { configured: loopConfigured(), error: loop?.error || null, subscriptions: loop && !loop.error ? loop.subscriptions : null },
      clickup: { configured: clickupConfigured(), error: cu?.error || null },
      zendrop: { configured: true, error: zd?.error || null, sheetId: S.zendrop_sheet_id },
    },
    fulfilment: ful,
    runRate: rate && !rate.error ? rate : null,
    demandError: demand?.error || null,
    shades: Object.values(shades).map((sh) => ({
      ...sh,
      newPerDay: sh.newUnits / b,
      priorNewPerDay: sh.priorNewUnits / b,
    })),
    stock,
    renewals: { source: renewalsSource, unmatched: renewalsUnmatched, subscriptions: loop && !loop.error ? loop.subscriptions : null },
    unmatchedDemand: unmatchedDemand.sort((x, y) => y.units - x.units).slice(0, 8),
    ops: { clickup: cu, zendrop: zd },
    settings,
    settingsMeta: meta,
  }
}
