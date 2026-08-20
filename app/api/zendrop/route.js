import { parseCsv } from '../../../lib/csv'
import { authed, unauthorized } from '../../../lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SHEET = '1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY'
// paired tabs lay out order/note side by side instead of one row per issue.
const TABS = [
  { name: 'Zendrop Order Issues', gid: '124374285', noteCol: 6, resolvedCol: 0 },
  { name: 'Fulfillment Issues',   gid: '1279079658', noteCol: 6, resolvedCol: 0 },
  { name: 'Unfulfilled Orders',   gid: '36396618',  paired: true },
]
const ORDER = /SER\s?(\d{4,6})/i

async function tab(t) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET}/export?format=csv&gid=${t.gid}`
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok) throw new Error(`${t.name}: HTTP ${r.status}`)
  const rows = parseCsv(await r.text())
  const hits = []
  // skip the header, and number rows the way the sheet does so a flagged row
  // can be found by eye.
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i]
    const sheetRow = i + 1
    if (t.paired) {
      for (let c = 0; c < cells.length; c++) {
        const m = ORDER.exec(cells[c] || '')
        if (!m) continue
        hits.push({ order: 'SER' + m[1], tab: t.name, row: sheetRow, resolved: null, note: (cells[c + 1] || '').trim() })
      }
    } else {
      const joined = cells.join(' ')
      const m = ORDER.exec(joined)
      if (!m) continue
      const flag = (cells[t.resolvedCol] || '').trim().toUpperCase()
      hits.push({
        order: 'SER' + m[1], tab: t.name, row: sheetRow,
        resolved: flag === 'TRUE' ? true : flag === 'FALSE' ? false : null,
        note: (cells[t.noteCol] || '').trim(),
      })
    }
  }
  return hits
}

export async function GET(request) {
  if (!(await authed(request))) return unauthorized()
  const orders = {}, unresolvedCounts = {}, errors = []
  const results = await Promise.all(TABS.map((t) => tab(t).catch((e) => { errors.push(String(e.message || e)); return [] })))
  results.forEach((hits, i) => {
    unresolvedCounts[TABS[i].name] = hits.filter((h) => h.resolved !== true).length
    for (const h of hits) (orders[h.order] ||= []).push({ tab: h.tab, row: h.row, resolved: h.resolved, note: h.note })
  })
  return Response.json({ orders, unresolvedCounts, fetchedAt: new Date().toISOString(), errors },
    { headers: { 'Cache-Control': 'no-store' } })
}
