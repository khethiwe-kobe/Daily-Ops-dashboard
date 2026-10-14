import { parseCsv } from '../csv'
import { cached } from './db'

// ---------- Loop Subscriptions: committed renewals in the next 30 days ----------
// Admin API token from Loop admin > Settings > API Tokens, set as
// INNADERM_LOOP_TOKEN. Rate limit is 2 requests per 3 seconds, so pages are
// walked slowly and the result is cached for 30 minutes.
const LOOP_BASE = 'https://api.loopsubscriptions.com/admin/2026-04'
export const loopConfigured = () => !!process.env.INNADERM_LOOP_TOKEN

export function loopRenewals() {
  return cached('loop_renewals_30d', 1800, async () => {
    const now = Math.floor(Date.now() / 1000)
    const end = now + 30 * 86400
    const weeks = [0, 0, 0, 0, 0] // units due per 7-day bucket (5th = days 29-30)
    let subs = 0, units = 0, pages = 0, cursor = null
    while (pages < 15) {
      const url = new URL(LOOP_BASE + '/subscription')
      url.searchParams.set('status', 'ACTIVE')
      url.searchParams.set('pageSize', '100')
      url.searchParams.set('nextBillingStartEpoch', String(now))
      url.searchParams.set('nextBillingEndEpoch', String(end))
      if (cursor) url.searchParams.set('afterCursor', cursor)
      const r = await fetch(url, { headers: { 'X-Loop-Token': process.env.INNADERM_LOOP_TOKEN, 'Content-Type': 'application/json' } })
      if (!r.ok) throw new Error(`Loop HTTP ${r.status}`)
      const json = await r.json()
      for (const s of json.data || []) {
        const qty = (s.lines || []).reduce((a, l) => a + Number(l.quantity || 0), 0) || 1
        subs += 1
        units += qty
        const days = Math.max(0, Math.floor((Number(s.nextBillingDateEpoch || now) - now) / 86400))
        weeks[Math.min(4, Math.floor(days / 7))] += qty
      }
      pages += 1
      if (!json.pageInfo?.hasNextPage) break
      cursor = json.pageInfo.nextCursor
      await new Promise((res) => setTimeout(res, 1600))
    }
    return { subscriptions: subs, units, weeks, source: 'loop' }
  })
}

// ---------- ClickUp: open work in the Operations lists ----------
export const clickupConfigured = () => !!process.env.INNADERM_CLICKUP_TOKEN

export function clickupLists(lists) {
  const key = 'clickup_' + lists.map((l) => l.id).join('_')
  return cached(key, 300, async () => {
    const out = []
    for (const l of lists) {
      const url = `https://api.clickup.com/api/v2/list/${l.id}/task?include_closed=false&subtasks=true&order_by=due_date&page=0`
      const r = await fetch(url, { headers: { Authorization: process.env.INNADERM_CLICKUP_TOKEN } })
      if (!r.ok) { out.push({ id: l.id, name: l.name, error: `HTTP ${r.status}` }); continue }
      const json = await r.json()
      const now = Date.now()
      const byStatus = {}
      let overdue = 0, unassigned = 0
      const tasks = (json.tasks || []).map((t) => {
        const status = t.status?.status || 'open'
        byStatus[status] = (byStatus[status] || 0) + 1
        const due = t.due_date ? Number(t.due_date) : null
        if (due && due < now) overdue += 1
        if (!t.assignees?.length) unassigned += 1
        return {
          id: t.id, name: String(t.name || '').slice(0, 140), status, url: t.url,
          due: due ? new Date(due).toISOString() : null, overdue: !!(due && due < now),
          priority: t.priority?.priority || null,
          assignees: (t.assignees || []).map((a) => a.username || a.email || '').filter(Boolean).slice(0, 3),
        }
      })
      out.push({ id: l.id, name: l.name, total: tasks.length, overdue, unassigned, byStatus, tasks: tasks.slice(0, 12) })
    }
    return { lists: out }
  })
}

// ---------- Zendrop ops sheet: open issues ----------
// Same sheet the support board reads. Two issue tabs, one row per issue, col A
// is the resolved tick. The sheet is link-shared, so CSV export needs no auth.
const TABS = [
  { name: 'Fulfillment Issues', gid: '1279079658', topic: 3, date: 1, order: 2, resolution: 7 },
  { name: 'Zendrop Order Issues', gid: '124374285', topic: 5, date: 1, order: 2, resolution: 10 },
]

// The shared Zendrop sheet also carries Serentia orders (#SER12345 / SER12345).
// This dashboard is Innaderm only, so those rows are skipped and counted.
const SERENTIA_ORDER = /^#?\s*SER/i

function parseSheetDate(s) {
  // "5/31/2025" or "05/29" (current year assumed)
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/)
  if (!m) return null
  let y = m[3] ? Number(m[3]) : new Date().getFullYear()
  if (y < 100) y += 2000
  const d = new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2])))
  if (d.getTime() > Date.now() + 86400e3) d.setUTCFullYear(d.getUTCFullYear() - 1)
  return d
}

export function zendropIssues(sheetId) {
  return cached('zendrop_v2_' + sheetId, 900, async () => {
    const now = Date.now()
    const tabs = []
    for (const t of TABS) {
      const r = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${t.gid}`, { redirect: 'follow' })
      if (!r.ok) { tabs.push({ name: t.name, error: `HTTP ${r.status}` }); continue }
      const rows = parseCsv(await r.text())
      const byTopic = {}
      let open = 0, raised7 = 0, resolved7 = 0, oldestDays = 0, rowsInnaderm = 0, skippedSerentia = 0
      const openRows = []
      for (let i = 1; i < rows.length; i++) {
        const c = rows[i]
        const order = String(c[t.order] || '').trim()
        if (!order) continue
        if (SERENTIA_ORDER.test(order)) { skippedSerentia += 1; continue }
        rowsInnaderm += 1
        const resolved = String(c[0] || '').trim().toUpperCase() === 'TRUE'
        const topic = String(c[t.topic] || 'Other').trim() || 'Other'
        const d = parseSheetDate(c[t.date])
        let ageDays = d ? Math.floor((now - d.getTime()) / 86400e3) : null
        // a mistyped year ("5/31/0025") would otherwise read as decades old
        if (ageDays != null && (ageDays < 0 || ageDays > 730)) ageDays = null
        if (d && ageDays <= 7) raised7 += 1
        if (!resolved) {
          open += 1
          byTopic[topic] = (byTopic[topic] || 0) + 1
          if (ageDays != null && ageDays > oldestDays) oldestDays = ageDays
          if (openRows.length < 10) openRows.push({ order, topic, ageDays, row: i + 1 })
        } else if (d && ageDays <= 7) {
          resolved7 += 1
        }
      }
      openRows.sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0))
      tabs.push({ name: t.name, open, raised7, resolved7, oldestDays, byTopic, openRows, gid: t.gid, rowsInnaderm, skippedSerentia })
    }
    return { tabs, sheetId }
  })
}
