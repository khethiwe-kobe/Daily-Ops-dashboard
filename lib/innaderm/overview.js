import * as shopify from './shopify'
import { fulfilment, runRate, renewalsEstimate } from './metrics'
import { loopConfigured, loopRenewals, clickupConfigured, clickupLists, zendropIssues } from './sources'
import { getSettings } from './settings'
import { ensureInnaderm } from './db'

// One call assembles the whole board. Every source is isolated: a failing
// upstream returns {error} for its own block and the rest still renders.
const safe = (p) => p.then((v) => v).catch((e) => ({ error: String(e?.message || e).slice(0, 240) }))

export async function overview({ days = 7 } = {}) {
  await ensureInnaderm()
  const { settings, meta } = await getSettings()
  const shopifyOn = shopify.configured()

  const [sync, ful, rate, est, inv, loop, cu, zd] = await Promise.all([
    safe(shopify.syncState()),
    shopifyOn ? safe(fulfilment(days)) : Promise.resolve(null),
    shopifyOn ? safe(runRate(settings.baseline_days)) : Promise.resolve(null),
    shopifyOn ? safe(renewalsEstimate()) : Promise.resolve(null),
    shopifyOn ? safe(shopify.inventory()) : Promise.resolve(null),
    loopConfigured() ? safe(loopRenewals()) : Promise.resolve(null),
    clickupConfigured() && settings.clickup_lists.length ? safe(clickupLists(settings.clickup_lists)) : Promise.resolve(null),
    safe(zendropIssues(settings.zendrop_sheet_id)),
  ])

  // Finished goods on hand: Shopify tracked variants (optionally filtered) or a manual count.
  let finished = { units: null, source: settings.finished_source, variants: [], countedAt: null }
  if (inv && !inv.error) {
    const tracked = inv.variants.filter((v) => v.tracked && (!settings.tracked_variant_ids.length || settings.tracked_variant_ids.includes(v.id)))
    finished.variants = inv.variants
    if (settings.finished_source === 'shopify') {
      finished.units = tracked.reduce((a, v) => a + v.onHand, 0)
      finished.countedAt = inv.cachedAt
    }
  }
  if (settings.finished_source === 'manual') {
    finished.units = settings.finished_on_hand
    finished.countedAt = settings.finished_counted_at || meta.finished_on_hand?.at || null
  }

  const renewals = loop && !loop.error ? loop : est && !est.error ? est : null

  return {
    generatedAt: new Date().toISOString(),
    days,
    integrations: {
      shopify: { configured: shopifyOn, store: shopify.store(), sync: sync && !sync.error ? sync : null, error: sync?.error || null },
      loop: { configured: loopConfigured(), error: loop?.error || null },
      clickup: { configured: clickupConfigured(), error: cu?.error || null },
      zendrop: { configured: true, error: zd?.error || null, sheetId: settings.zendrop_sheet_id },
    },
    fulfilment: ful,
    runRate: rate && !rate.error ? rate : null,
    renewals,
    inventory: {
      finished,
      packaging: { units: settings.packaging_on_hand, countedAt: settings.packaging_counted_at || meta.packaging_on_hand?.at || null },
    },
    ops: { clickup: cu, zendrop: zd },
    settings,
    settingsMeta: meta,
  }
}
