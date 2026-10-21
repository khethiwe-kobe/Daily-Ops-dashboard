/* Innaderm Ops dashboard. Plain JS, no build step. Talks to /api/innaderm/*.
   Everything data-driven is inserted with textContent / createElement so a
   product name or ClickUp task title can never become markup. */
;(() => {
  'use strict'

  const API = '/api/innaderm'
  const LS_TOKEN = 'innaderm.token'
  const LS_DAYS = 'innaderm.days'
  const LS_THEME = 'innaderm.theme'
  const LS_VIEW = 'innaderm.view'
  const PERIODS = [7, 14, 30, 60, 90]
  const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)']
  const params = new URLSearchParams(location.search)
  const DEMO = params.get('demo') === '1'

  const state = {
    token: safeGet(LS_TOKEN),
    me: null,
    days: PERIODS.includes(Number(safeGet(LS_DAYS))) ? Number(safeGet(LS_DAYS)) : 7,
    data: null,
    loading: false,
    error: null,
    scaleDays: null,
    tables: {},
    syncing: false,
    drawer: false,
    keys: null,
    newKey: null,
    view: params.get('tab') === 'cs' || (params.get('tab') !== 'ops' && safeGet(LS_VIEW) === 'cs') ? 'cs' : 'ops',
    cs: null,
    csLoading: false,
    csError: null,
  }

  function safeGet(k) { try { return localStorage.getItem(k) } catch { return null } }
  function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch {} }

  // ---------- tiny DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel)
  function h(tag, props, ...kids) {
    const el = document.createElement(tag)
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k === 'html') el.innerHTML = v // only ever static markup from this file
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else if (k === 'style') el.style.cssText = v
      else el.setAttribute(k, v === true ? '' : v)
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
    }
    return el
  }
  const svgNS = 'http://www.w3.org/2000/svg'
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(svgNS, tag)
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue
      if (k === 'text') el.textContent = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v)
    }
    for (const kid of kids.flat()) if (kid) el.append(kid)
    return el
  }

  // ---------- formatting ----------
  const fmtInt = (n) => (n == null || !isFinite(n) ? '–' : Math.round(n).toLocaleString('en-US'))
  const fmtCompact = (n) => {
    if (n == null || !isFinite(n)) return '–'
    const a = Math.abs(n)
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
    if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
    return Math.round(n).toLocaleString('en-US')
  }
  const fmt1 = (n) => (n == null || !isFinite(n) ? '–' : (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 }))
  const fmtMoney = (n) => (n == null ? '–' : '$' + Math.round(n).toLocaleString('en-US'))
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '–')
  const fmtDateLong = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '–')
  const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '–')
  const hours = (hrs) => (hrs == null ? '–' : hrs < 48 ? fmt1(hrs) + ' h' : fmt1(hrs / 24) + ' d')
  const addDays = (n) => new Date(Date.now() + n * 86400e3)
  const dayLabel = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) }
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null)
  const inDays = (dt) => { const n = Math.round((dt - Date.now()) / 86400e3); return n < 0 ? 'overdue' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `${n} days from now` }

  function delta(cur, prev, { upGood = true, suffix = '%' } = {}) {
    if (cur == null || prev == null || !prev) return h('div', { class: 'delta' }, h('span', { class: 'flat', text: 'no prior period' }))
    const p = pct(cur, prev)
    const dir = p > 0 ? 'up' : p < 0 ? 'down' : 'flat'
    const good = dir === 'flat' ? 'flat' : (dir === 'up') === upGood ? 'up' : 'down'
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•'
    return h('div', { class: 'delta' }, h('span', { class: good, text: `${arrow} ${Math.abs(p)}${suffix}` }), h('span', { class: 'muted', text: `vs prior ${state.days}d` }))
  }

  // ---------- API ----------
  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }
    if (state.token) headers.Authorization = 'Bearer ' + state.token
    const r = await fetch(API + path, { ...opts, headers, credentials: 'include', body: opts.body ? JSON.stringify(opts.body) : undefined })
    let json = null
    try { json = await r.json() } catch { json = null }
    if (r.status === 401) { state.token = null; safeSet(LS_TOKEN, null); state.me = null; render(); throw new Error('Signed out') }
    if (!r.ok) throw new Error(json?.error || `HTTP ${r.status}`)
    return json
  }

  async function boot() {
    applyTheme()
    if (DEMO) { state.me = { name: 'Demo viewer', role: 'admin' }; state.data = demoData(); state.cs = demoCs(); render(); return }
    if (state.token || document.cookie.includes('inn_session')) {
      try { state.me = await api('/auth/me') } catch { state.me = null }
    }
    render()
    if (state.me) load()
  }

  async function load() {
    if (state.view === 'cs') return loadCs()
    if (DEMO) { state.data = demoData(); render(); return }
    state.loading = true; state.error = null; render()
    try {
      state.data = await api(`/overview?days=${state.days}`)
      state.loading = false
      render()
      maybeSync()
    } catch (e) {
      state.loading = false; state.error = e.message; render()
    }
  }

  // Keep pulling Shopify history until the backfill is complete, then refresh.
  async function maybeSync(force) {
    const sh = state.data?.integrations?.shopify
    if (!sh?.configured || state.syncing) return
    const st = sh.sync || {}
    const stale = !st.lastRunAt || Date.now() - new Date(st.lastRunAt).getTime() > 10 * 60e3
    if (!force && st.backfilled && !stale) return
    state.syncing = true; render()
    try {
      for (let i = 0; i < 12; i++) {
        const r = await api('/sync', { method: 'POST' })
        if (r.complete || r.error) break
      }
      state.data = await api(`/overview?days=${state.days}`)
    } catch (e) { state.error = e.message }
    state.syncing = false; render()
  }

  // ---------- theme ----------
  function applyTheme() {
    const t = safeGet(LS_THEME)
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t)
    else document.documentElement.removeAttribute('data-theme')
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    const next = cur === 'dark' ? 'light' : 'dark'
    safeSet(LS_THEME, next); applyTheme()
  }

  // ---------- model: the reorder maths ----------
  // Daily demand curve for the next `horizon` days: committed renewals spread
  // over 30 days + new orders at run rate, which grow scale_pct/day for N days
  // (the ad-scaling scenario) and then hold at the scaled level.
  const HORIZON = 365 // days the forecast looks ahead; cover at this value means "more than a year"
  const MAX_SCALE = 14 // longest scale run checked
  function demandCurve(d, N, horizon = HORIZON) {
    const S = d.settings
    const B = d.runRate?.newUnitsPerDay || 0
    const g = (S.scale_pct || 0) / 100
    const R = (d.renewals?.units || 0) / 30
    const out = []
    let level = B
    for (let k = 1; k <= horizon; k++) {
      if (k <= N) level = B * Math.pow(1 + g, k)
      out.push(level + (k <= 30 ? R : R)) // renewals assumed to continue at the same monthly cadence
    }
    return out
  }
  function daysOfCover(onHand, curve) {
    if (onHand == null) return null
    let left = onHand
    for (let i = 0; i < curve.length; i++) {
      if (curve[i] <= 0) continue
      if (left <= curve[i]) return i + left / curve[i]
      left -= curve[i]
    }
    return curve.length
  }
  function sum(arr, n) { let t = 0; for (let i = 0; i < Math.min(n, arr.length); i++) t += arr[i]; return t }

  function decide(d, N) {
    const S = d.settings
    const curve = demandCurve(d, N)
    const base = demandCurve(d, 0)
    const backlog = d.fulfilment?.unfulfilled?.units || 0
    const finishedRaw = d.inventory.finished.units
    const finished = finishedRaw == null ? null : Math.max(0, finishedRaw - backlog)
    const packaging = d.inventory.packaging.units
    const perUnit = S.packaging_per_unit ?? 1
    const safety = S.safety_days ?? 7
    const need30 = { committed: d.renewals?.units || 0, baseline: sum(base, 30) - (d.renewals?.units || 0), scaled: sum(curve, 30) - sum(base, 30) }
    need30.total = need30.committed + need30.baseline + need30.scaled

    // Units a day selling right now (new orders + renewals, no scaling). With
    // no sales measured, cover is unknowable, not "a year": every figure that
    // divides by demand is withheld instead of showing the horizon.
    const sellPerDay = sum(base, 30) / 30
    const noSales = !!d.runRate && !(sellPerDay > 0)
    const coverF = noSales ? null : daysOfCover(finished, curve)
    const coverF0 = noSales ? null : daysOfCover(finished, base)
    const coverP = noSales || packaging == null || !perUnit ? null : daysOfCover(packaging / perUnit, curve)
    const capped = coverF != null && coverF >= HORIZON

    // How much finished stock the next order should be: demand through the
    // lead time plus 30 days of cover and the safety buffer, less what is here.
    const leadP = S.lead_packaging
    // Packaging counts as "on hand" when it covers most of a month of baseline
    // demand - judged on the no-scale curve so the baseline verdict does not
    // move when the slider does.
    const packagingOk = packaging != null && perUnit > 0 && (packaging / perUnit) >= 0.8 * sum(base, 30)
    const leadF = packagingOk ? S.lead_finished_with_packaging : S.lead_finished_without_packaging
    const horizonF = Math.ceil(leadF + 30 + safety)
    let orderFinished = Math.max(0, Math.ceil(sum(curve, horizonF) - (finished ?? 0)))
    if (S.moq_finished) orderFinished = orderFinished > 0 ? Math.max(S.moq_finished, orderFinished) : 0
    let orderPackaging = packaging == null ? null : Math.max(0, Math.ceil(orderFinished * perUnit + sum(curve, leadP ? leadP + safety : 30) * perUnit - packaging))
    if (orderPackaging != null && S.moq_packaging) orderPackaging = orderPackaging > 0 ? Math.max(S.moq_packaging, orderPackaging) : 0

    // Past the horizon there is no reorder date to give, only "not this year".
    const orderFinishedBy = coverF == null || capped ? null : addDays(Math.floor(coverF - leadF - safety))
    const orderPackagingBy = coverP == null || coverP >= HORIZON || leadP == null ? null : addDays(Math.floor(coverP - leadP - safety))

    // The one answer he will use: is stock selling out faster than a new
    // batch can land?
    const rate = `Selling ~${fmt1(sellPerDay)} units/day now.`
    const restock = `${leadF}-day restock + ${safety}-day buffer`
    let verdict = 'unknown', reason = ''
    if (finished == null || !d.runRate) {
      reason = finished == null ? 'Finished-goods on hand is not known yet. Connect Shopify inventory or enter a count in Settings.' : 'No order history yet - the run rate is still syncing.'
    } else if (noSales) {
      // Orders sync oldest first, so recent sales land last: until the
      // backfill completes, zero demand means "still loading", not "no sales".
      const sync = d.integrations?.shopify?.sync
      reason = !sync?.backfilled
        ? `Shopify orders are still loading${sync?.orders ? ` (${fmtInt(sync.orders)} so far, oldest first)` : ''}, so the last ${S.baseline_days} days of sales are not in yet. Days of cover appears once they are.`
        : `No sales in the last ${S.baseline_days} days, so there is no sell rate to measure stock against.`
    } else if (coverF0 < leadF + safety) {
      verdict = 'no'
      reason = `${rate} That is faster than we can restock: finished goods run out in ${fmt1(coverF0)} days without scaling, inside the ${restock}${packagingOk ? '' : ' (no packaging on hand)'}. Order now, do not scale.`
    } else if (coverF < leadF + safety) {
      verdict = 'no'
      reason = `${rate} Scaling ${N} day${N === 1 ? '' : 's'} at ${S.scale_pct}%/day empties finished goods in ${fmt1(coverF)} days, inside the ${restock}. Stock would run out around ${fmtDate(addDays(coverF))}.`
    } else {
      verdict = 'yes'
      reason = `${rate} Under the ${N}-day scale, finished goods last ${capped ? 'more than a year' : fmt1(coverF) + ' days'}, ${capped ? 'well' : fmt1(coverF - leadF - safety) + ' days'} past the ${restock}.${packagingOk ? '' : ' Packaging is the constraint: without it the lead time is ' + S.lead_finished_without_packaging + ' days.'}`
    }
    // Largest N that still clears the lead time.
    let maxN = null
    if (finished != null && d.runRate && !noSales) {
      maxN = 0
      for (let n = 0; n <= MAX_SCALE; n++) { if (daysOfCover(finished, demandCurve(d, n)) >= leadF + safety) maxN = n; else break }
    }
    const maxNLabel = maxN == null ? null : `${maxN}${maxN === MAX_SCALE ? '+' : ''} day${maxN === 1 ? '' : 's'}`
    const stockout = coverF == null || capped ? null : addDays(coverF)
    const coverLabel = coverF == null ? '–' : capped ? `${HORIZON}+` : fmt1(coverF)
    return { curve, base, backlog, finished, finishedRaw, packaging, perUnit, safety, need30, sellPerDay, noSales, capped, coverLabel, coverF, coverF0, coverP, leadF, leadP, packagingOk, orderFinished, orderPackaging, orderFinishedBy, orderPackagingBy, verdict, reason, maxN, maxNLabel, stockout }
  }

  // ---------- charts ----------
  const tip = $('#tooltip')
  function showTip(x, y, title, rows) {
    tip.replaceChildren(h('div', { class: 't', text: title }), ...rows.map((r) => h('div', { class: 'r' }, h('i', { style: `background:${r.color}` }), h('span', { text: r.label }), h('b', { text: r.value }))))
    tip.hidden = false
    const w = tip.offsetWidth, hh = tip.offsetHeight
    tip.style.left = Math.min(innerWidth - w - 8, x + 14) + 'px'
    tip.style.top = Math.max(8, Math.min(innerHeight - hh - 8, y - hh / 2)) + 'px'
  }
  function hideTip() { tip.hidden = true }

  // Multi-series line chart with crosshair + one tooltip for every series.
  function lineChart({ labels, series, height = 200, yFormat = fmtCompact, bandIdx = null, sparse = false }) {
    const W = sparse ? 320 : 640, H = height, m = { t: 14, r: 14, b: 26, l: 36 }
    const iw = W - m.l - m.r, ih = H - m.t - m.b
    const n = labels.length
    const max = Math.max(1, ...series.flatMap((sr) => sr.values)) * 1.1
    const x = (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw)
    const y = (v) => m.t + ih - (v / max) * ih
    const ticks = niceTicks(max, sparse ? 2 : 4)
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' })
    const grid = s('g', { class: 'grid' })
    ticks.forEach((t) => grid.append(s('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) })))
    svg.append(grid)
    svg.append(s('line', { class: 'base', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }))
    const ax = s('g', { class: 'axis' })
    ticks.forEach((t) => ax.append(s('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end', text: yFormat(t) })))
    // Label every `step`th day plus the last; drop a stepped label that would
    // sit on top of the last one. Small (sparse) charts label the ends only.
    const step = sparse ? n : Math.ceil(n / 7)
    labels.forEach((l, i) => {
      const last = i === n - 1
      if (!(i % step === 0 || last)) return
      if (!last && n - 1 - i < step / 2) return
      ax.append(s('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : last ? 'end' : 'middle', text: dayLabel(l) }))
    })
    svg.append(ax)
    if (bandIdx != null) svg.append(s('rect', { x: x(bandIdx), y: m.t, width: Math.max(0, W - m.r - x(bandIdx)), height: ih, fill: 'var(--surface-2)', opacity: .6 }))
    series.forEach((sr, si) => {
      const pts = sr.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')
      if (sr.area) svg.append(s('polygon', { points: `${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`, fill: sr.color, opacity: .1 }))
      svg.append(s('polyline', { class: 'ser', points: pts, stroke: sr.color, 'stroke-dasharray': sr.dashed ? '5 4' : null }))
      // end label + end dot (selective direct labelling)
      const last = sr.values[n - 1]
      svg.append(s('circle', { class: 'dot', cx: x(n - 1), cy: y(last), r: 4, fill: sr.color }))
    })
    const xh = s('line', { class: 'xh', x1: 0, x2: 0, y1: m.t, y2: m.t + ih, opacity: 0 })
    svg.append(xh)
    const dots = series.map((sr) => { const c = s('circle', { class: 'dot', r: 5, fill: sr.color, opacity: 0 }); svg.append(c); return c })
    const hit = s('rect', { class: 'hit', x: m.l, y: m.t, width: iw, height: ih })
    const move = (ev) => {
      const r = svg.getBoundingClientRect()
      const px = ((ev.clientX - r.left) / r.width) * W
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))))
      xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('opacity', 1)
      series.forEach((sr, si) => { dots[si].setAttribute('cx', x(i)); dots[si].setAttribute('cy', y(sr.values[i])); dots[si].setAttribute('opacity', 1) })
      showTip(ev.clientX, ev.clientY, dayLabel(labels[i]), series.map((sr) => ({ color: sr.color, label: sr.name, value: (sr.format || fmtInt)(sr.values[i]) })))
    }
    hit.addEventListener('pointermove', move)
    hit.addEventListener('pointerleave', () => { xh.setAttribute('opacity', 0); dots.forEach((d) => d.setAttribute('opacity', 0)); hideTip() })
    svg.append(hit)
    return svg
  }
  function niceTicks(max, count) {
    const raw = max / count
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const stepN = [1, 2, 2.5, 5, 10].find((k) => k * mag >= raw) * mag
    const out = []
    for (let v = 0; v <= max + 1e-9; v += stepN) out.push(Math.round(v * 1000) / 1000)
    return out
  }
  function sparkline(values, color = 'var(--s1)') {
    const W = 120, H = 28, n = values.length
    const max = Math.max(1, ...values)
    const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W)
    const y = (v) => H - 2 - (v / max) * (H - 4)
    const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ')
    return s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      s('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }))
  }
  // Horizontal bars, single hue (magnitude), value at the tip.
  function hbars(rows, { color = 'var(--s1)', total } = {}) {
    const max = Math.max(1, ...rows.map((r) => r.value))
    return h('div', { class: 'hbars' }, rows.map((r) => {
      const el = h('div', { class: 'hbar' },
        h('span', { class: 'n', text: r.label, title: r.label }),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(r.value / max) * 100}%;background:${r.color || color}` })),
        h('span', { class: 'v', text: fmtInt(r.value) }))
      el.addEventListener('pointermove', (ev) => showTip(ev.clientX, ev.clientY, r.label, [{ color: r.color || color, label: total ? `${Math.round((r.value / total) * 100)}% of ${fmtInt(total)}` : 'count', value: fmtInt(r.value) }]))
      el.addEventListener('pointerleave', hideTip)
      return el
    }))
  }
  function tableView(headers, rows) {
    return h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, headers.map((th, i) => h('th', { class: i ? 'num' : '', text: th })))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i ? 'num' : '', text: c }))))))
  }
  // Card with a chart/table toggle (the accessibility twin of every chart).
  function chartCard(id, title, hint, build, { headers, rows, span = 'c8', legend } = {}) {
    const showTable = !!state.tables[id]
    const card = h('div', { class: `card ${span}` })
    card.append(h('div', { class: 'card-head' },
      h('div', null, h('h3', { text: title }), hint ? h('div', { class: 'hint', text: hint }) : null),
      h('div', { class: 'tools' },
        h('button', { class: 'tbtn', 'aria-pressed': String(!showTable), text: 'Chart', onclick: () => { state.tables[id] = false; render() } }),
        h('button', { class: 'tbtn', 'aria-pressed': String(showTable), text: 'Table', onclick: () => { state.tables[id] = true; render() } }))))
    if (showTable && headers) card.append(h('div', { style: 'max-height:280px;overflow:auto' }, tableView(headers, rows)))
    else {
      card.append(h('div', { class: 'chart' }, build()))
      if (legend) card.append(h('div', { class: 'legend' }, legend.map((l) => h('span', { class: 'k' }, h('i', { class: l.square ? 'sq' : '', style: `background:${l.color}` }), l.name))))
    }
    return card
  }

  // ---------- views ----------
  function render() {
    const app = $('#app')
    app.replaceChildren()
    if (!state.me) return app.append(loginView())
    app.append(topBar(), state.view === 'cs' ? csView() : mainView(), drawer())
  }

  function loginView() {
    const err = h('div', { class: 'err', text: '' })
    const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'inn_xxxxxxxx-xxxxxxxx-…', 'aria-label': 'Access key', autofocus: true })
    const btn = h('button', { class: 'btn', text: 'Open dashboard' })
    const submit = async (ev) => {
      ev.preventDefault()
      btn.disabled = true; err.textContent = ''
      try {
        const r = await api('/auth/login', { method: 'POST', body: { key: input.value } })
        state.token = r.token; safeSet(LS_TOKEN, r.token)
        state.me = { name: r.name, role: r.role }
        render(); load()
      } catch (e) { err.textContent = e.message; btn.disabled = false }
    }
    return h('div', { class: 'login' }, h('form', { class: 'box', onsubmit: submit },
      h('div', { class: 'brand' }, h('div', { class: 'mark', text: 'IN' }), h('div', null, h('div', { class: 'name', text: 'Innaderm' }), h('div', { class: 'sub', text: 'Operations dashboard' }))),
      h('h1', { text: 'Enter your access key' }),
      h('p', { text: 'Keys are personal and issued by the Ops team. You stay signed in on this device for 90 days.' }),
      h('div', { class: 'field' }, h('label', { text: 'Access key' }), input),
      err, btn,
      h('div', { class: 'foot', text: 'Lost your key? Ask Khethiwe for a new one; the old one can be revoked.' })))
  }

  function topBar() {
    const d = state.data
    const sh = d?.integrations?.shopify
    let sync
    if (DEMO) sync = h('span', { class: 'pill warn' }, h('i', { class: 'dot' }), 'Demo data')
    else if (state.syncing) sync = h('span', { class: 'pill busy' }, h('i', { class: 'dot' }), 'Syncing Shopify…')
    else if (sh && !sh.configured) sync = h('span', { class: 'pill bad' }, h('i', { class: 'dot' }), 'Shopify not connected')
    else if (sh?.sync?.lastRunAt) sync = h('span', { class: 'pill', title: 'Click to refresh now', onclick: () => maybeSync(true), style: 'cursor:pointer' }, h('i', { class: 'dot' }), `Updated ${fmtTime(sh.sync.lastRunAt)}`)
    else sync = h('span', { class: 'pill' }, h('i', { class: 'dot' }), state.loading ? 'Loading…' : 'Live')
    if (state.view === 'cs' && !DEMO) {
      const c = state.cs
      if (state.csLoading && !c) sync = h('span', { class: 'pill busy' }, h('i', { class: 'dot' }), 'Loading…')
      else if (c && !c.connected) sync = h('span', { class: 'pill bad' }, h('i', { class: 'dot' }), 'Gmail not connected')
      else if (c?.sync?.lastIngestAt) {
        const stale = Date.now() - new Date(c.sync.lastIngestAt).getTime() > 60 * 60e3
        sync = h('span', { class: 'pill' + (stale ? ' warn' : ''), title: stale ? 'No sync for over an hour: check the Apps Script executions' : 'Click to refresh', onclick: loadCs, style: 'cursor:pointer' }, h('i', { class: 'dot' }), `Gmail ${fmtTime(c.sync.lastIngestAt)}`)
      }
    }
    const setView = (v) => { if (state.view === v) return; state.view = v; safeSet(LS_VIEW, v); render(); if (v === 'cs' ? !state.cs : !state.data) load(); else render() }
    const tabs = h('div', { class: 'seg tabs', role: 'tablist', 'aria-label': 'Dashboard' }, [['ops', 'Operations'], ['cs', 'Customer service']].map(([v, l]) => h('button', { role: 'tab', 'aria-selected': String(state.view === v), 'aria-pressed': String(state.view === v), text: l, onclick: () => setView(v) })))
    return h('header', { class: 'top' }, h('div', { class: 'top-in' },
      h('div', { class: 'brand' }, h('div', { class: 'mark', text: 'IN' }), h('div', null, h('span', { class: 'name', text: 'Innaderm' }), h('span', { class: 'sub', text: ' Ops' }))),
      tabs,
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, PERIODS.map((p) => h('button', { 'aria-pressed': String(p === state.days), text: `${p}d`, onclick: () => { state.days = p; safeSet(LS_DAYS, String(p)); if (state.view === 'cs') state.data = null; else state.cs = null; load() } }))),
      sync,
      h('div', { class: 'user' },
        h('div', null, h('div', { class: 'who', text: state.me.name }), h('div', { class: 'role', text: state.me.role })),
        state.me.role === 'admin' ? h('button', { class: 'icon-btn', title: 'Settings & access keys', 'aria-label': 'Settings', onclick: openDrawer, html: gear }) : null,
        h('button', { class: 'icon-btn', title: 'Light / dark', 'aria-label': 'Toggle theme', onclick: toggleTheme, html: sun }),
        h('button', { class: 'icon-btn', title: 'Sign out', 'aria-label': 'Sign out', onclick: signOut, html: exit }))))
  }
  const gear = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
  const sun = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  const exit = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>'

  async function signOut() {
    try { if (!DEMO) await api('/auth/logout', { method: 'POST' }) } catch {}
    state.token = null; safeSet(LS_TOKEN, null); state.me = null; state.data = null; render()
  }

  function mainView() {
    const wrap = h('div', { class: 'wrap' + (state.loading && state.data ? ' fade' : '') })
    if (state.error) wrap.append(h('div', { class: 'banner bad' }, `Could not load: ${state.error}`, h('button', { class: 'btn sm ghost', text: 'Retry', onclick: load })))
    const d = state.data
    if (!d) { if (!state.error) wrap.append(h('div', { class: 'banner info', text: 'Loading the board…' })); return wrap }
    if (state.scaleDays == null) state.scaleDays = d.settings.scale_days_default ?? 3
    const dec = decide(d, state.scaleDays)
    wrap.append(decisionStrip(d, dec))
    wrap.append(setupBanners(d))
    wrap.append(fulfilmentSection(d))
    wrap.append(inventorySection(d, dec))
    wrap.append(needSection(d, dec))
    wrap.append(reorderSection(d, dec))
    wrap.append(opsSection(d))
    wrap.append(h('footer', { class: 'foot' },
      h('span', { text: `Generated ${fmtDateLong(d.generatedAt)} ${fmtTime(d.generatedAt)}` }),
      h('span', { text: `Store: ${d.integrations.shopify.store}` }),
      d.integrations.shopify.sync?.orders ? h('span', { text: `${fmtInt(d.integrations.shopify.sync.orders)} orders synced since ${fmtDate(d.integrations.shopify.sync.oldest)}` }) : null,
      h('span', { text: 'Period changes every chart, tile and table on this page.' })))
    return wrap
  }

  function decisionStrip(d, dec) {
    const chip = dec.verdict === 'yes' ? ['yes', 'YES'] : dec.verdict === 'no' ? ['no', 'NO'] : ['unknown', 'UNKNOWN']
    const missing = dec.finished == null ? 'needs finished-goods count' : 'needs sales history'
    const coverSub = dec.stockout ? `at ~${fmt1(dec.sellPerDay)}/day now · runs out ~${fmtDate(dec.stockout)} under this scenario`
      : dec.capped ? `at ~${fmt1(dec.sellPerDay)}/day now · lasts beyond the 1-year forecast` : missing
    const packSub = dec.orderPackagingBy ? inDays(dec.orderPackagingBy) : dec.leadP == null ? 'packaging lead time not set'
      : dec.packaging == null ? 'packaging count not set' : dec.noSales ? 'needs sales history' : 'not needed within a year'
    const finSub = dec.orderFinishedBy ? `${inDays(dec.orderFinishedBy)} · ${dec.leadF}-day lead` : dec.capped ? 'not needed within a year' : missing
    // Which stock count the answer rests on and how old it is, so a stale
    // count is visible before anyone acts on the verdict.
    const fin = d.inventory.finished
    const ageDays = fin.countedAt ? Math.floor((Date.now() - new Date(fin.countedAt)) / 86400e3) : null
    const basis = dec.finishedRaw == null ? null
      : `Based on ${fmtInt(dec.finishedRaw)} units on hand (${fin.source === 'shopify' ? 'Shopify inventory' : 'manual count'}${ageDays == null ? ', count date unknown' : ageDays === 0 ? ', counted today' : `, counted ${fmtDate(fin.countedAt)}`})${dec.backlog ? `, less ${fmtInt(dec.backlog)} owed to unfulfilled orders` : ''}.${ageDays != null && ageDays > 7 ? ` The count is ${ageDays} days old: recount before acting.` : ''}`
    return h('section', { class: 'section' }, h('div', { class: 'decision' },
      h('div', null,
        h('div', { class: 'q', text: `Can we scale ads right now? (${state.scaleDays}-day scale at ${d.settings.scale_pct}%/day)` }),
        h('div', { class: 'verdict' }, h('span', { class: `chip ${chip[0]}`, text: chip[1] }), h('span', { text: dec.verdict === 'yes' ? 'Inventory can take it' : dec.verdict === 'no' ? 'Scaling now causes a stockout' : dec.noSales ? 'No sales data yet' : 'Inputs missing' })),
        h('div', { class: 'reason', text: dec.reason + (dec.maxNLabel && dec.verdict !== 'unknown' ? ` Longest safe scale: ${dec.maxNLabel}.` : '') }),
        basis ? h('div', { class: 'reason basis', text: basis }) : null),
      h('div', { class: 'mini' }, h('div', { class: 'l', text: 'Days of cover (finished goods)' }), h('div', { class: 'v hero', text: dec.coverLabel }), h('div', { class: 's', text: coverSub })),
      h('div', { class: 'mini' }, h('div', { class: 'l', text: 'Order packaging by' }), h('div', { class: 'v', text: dec.orderPackagingBy ? fmtDate(dec.orderPackagingBy) : '–' }), h('div', { class: 's', text: packSub })),
      h('div', { class: 'mini' }, h('div', { class: 'l', text: 'Order finished goods by' }), h('div', { class: 'v', text: dec.orderFinishedBy ? fmtDate(dec.orderFinishedBy) : '–' }), h('div', { class: 's', text: finSub }))))
  }

  function setupBanners(d) {
    const box = h('div')
    const I = d.integrations
    if (!I.shopify.configured) box.append(h('div', { class: 'banner bad' }, h('span', null, h('b', null, 'Shopify is not connected. '), 'Add ', h('code', null, 'INNADERM_SHOPIFY_CLIENT_ID'), ' and ', h('code', null, 'INNADERM_SHOPIFY_CLIENT_SECRET'), ' in Vercel (Dev Dashboard app installed on the store, read orders / fulfillments / products / inventory / locations) and redeploy. Until then the fulfilment, run-rate and stock panels stay empty.')))
    if (I.shopify.configured && I.shopify.sync && !I.shopify.sync.backfilled) box.append(h('div', { class: 'banner' }, `Loading 120 days of Shopify history (${fmtInt(I.shopify.sync.orders || 0)} orders so far). Numbers firm up as it completes.`))
    if (I.shopify.error) box.append(h('div', { class: 'banner bad', text: `Shopify: ${I.shopify.error}` }))
    if (!I.loop.configured) box.append(h('div', { class: 'banner' }, h('span', null, h('b', null, 'Loop is not connected: '), 'committed renewals are estimated from recurring orders in the last 30 days. Add ', h('code', null, 'INNADERM_LOOP_TOKEN'), ' for exact renewal dates.')))
    if (I.loop.error) box.append(h('div', { class: 'banner', text: `Loop: ${I.loop.error}` }))
    if (d.inventory.packaging.units == null || d.settings.lead_packaging == null) box.append(h('div', { class: 'banner' }, h('span', null, h('b', null, 'Packaging inputs missing: '), `${d.inventory.packaging.units == null ? 'packaging on hand' : ''}${d.inventory.packaging.units == null && d.settings.lead_packaging == null ? ' and ' : ''}${d.settings.lead_packaging == null ? 'packaging lead time' : ''}. The reorder dates for packaging need both.`), state.me.role === 'admin' ? h('button', { class: 'btn sm', text: 'Enter in Settings', onclick: openDrawer }) : null))
    return box
  }

  // ----- Panel 1: fulfilment & shipping -----
  function fulfilmentSection(d) {
    const f = d.fulfilment
    const sec = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'Fulfilment & shipping' }), h('span', { class: 'why', text: `What is moving, what is stuck. Period: last ${state.days} days.` })))
    if (!f || f.error) { sec.append(h('div', { class: 'setup' }, h('h3', { text: 'Waiting for Shopify' }), h('p', { text: f?.error || 'Orders, fulfilments and deliveries appear here once the Shopify token is set and the first sync has run.' }))); return sec }
    const placed = f.series.map((r) => r.placed), fulfilled = f.series.map((r) => r.fulfilled), delivered = f.series.map((r) => r.delivered)
    const tiles = h('div', { class: 'kpis' },
      tile('Orders in transit', fmtInt(f.inTransit.count), null, h('div', { class: 'delta' }, h('span', { class: f.inTransit.buckets['15+ days'] ? 'down' : 'flat', text: `${f.inTransit.buckets['15+ days']} over 15 days` })), null),
      tile('Orders unfulfilled', fmtInt(f.unfulfilled.count), null, h('div', { class: 'delta' }, h('span', { class: f.unfulfilled.buckets['4-7 days'] + f.unfulfilled.buckets['8-14 days'] + f.unfulfilled.buckets['15+ days'] ? 'down' : 'up', text: `${fmtInt(f.unfulfilled.units)} units owed · ${f.unfulfilled.buckets['0-3 days']} under 3 days` })), null),
      tile('Delivered', fmtInt(f.delivered.count), `in ${state.days}d`, delta(f.delivered.count, f.delivered.prior), sparkline(delivered, SERIES[2])),
      tile('Avg fulfilment time', hours(f.avgFulfilHours), 'paid → fulfilled', f.priorAvgFulfilHours ? delta(f.avgFulfilHours, f.priorAvgFulfilHours, { upGood: false }) : h('div', { class: 'delta' }, h('span', { class: 'muted', text: `median ${hours(f.medFulfilHours)}` })), null),
      tile('Avg delivery time', f.avgDeliveryDays == null ? '–' : fmt1(f.avgDeliveryDays), f.avgDeliveryDays == null ? '' : 'days, fulfilled → delivered', f.priorAvgDeliveryDays ? delta(f.avgDeliveryDays, f.priorAvgDeliveryDays, { upGood: false }) : h('div', { class: 'delta' }, h('span', { class: 'muted', text: f.avgDoorDays ? `${fmt1(f.avgDoorDays)} d order → door` : 'no deliveries yet' })), null))
    sec.append(tiles)
    const grid = h('div', { class: 'grid', style: 'margin-top:14px' })
    grid.append(chartCard('flow', 'Orders per day', 'Placed, fulfilled and delivered, by day', () => lineChart({
      labels: f.series.map((r) => r.day),
      series: [{ name: 'Placed', values: placed, color: SERIES[0] }, { name: 'Fulfilled', values: fulfilled, color: SERIES[1] }, { name: 'Delivered', values: delivered, color: SERIES[2] }],
    }), { headers: ['Day', 'Placed', 'Units', 'Fulfilled', 'Delivered'], rows: f.series.map((r) => [dayLabel(r.day), fmtInt(r.placed), fmtInt(r.units), fmtInt(r.fulfilled), fmtInt(r.delivered)]), legend: [{ name: 'Placed', color: SERIES[0] }, { name: 'Fulfilled', color: SERIES[1] }, { name: 'Delivered', color: SERIES[2] }] }))
    const ageing = h('div', { class: 'card c4' },
      h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Ageing' }), h('div', { class: 'hint', text: 'How long open orders have been waiting' }))),
      h('div', { class: 'note', style: 'margin:0 0 6px' }, h('b', null, 'In transit'), ` · ${fmtInt(f.inTransit.count)} shipments`),
      hbars(Object.entries(f.inTransit.buckets).map(([k, v]) => ({ label: k, value: v })), { color: SERIES[0], total: f.inTransit.count }),
      h('div', { class: 'note', style: 'margin:14px 0 6px' }, h('b', null, 'Unfulfilled'), ` · ${fmtInt(f.unfulfilled.count)} orders`),
      hbars(Object.entries(f.unfulfilled.buckets).map(([k, v]) => ({ label: k, value: v })), { color: SERIES[1], total: f.unfulfilled.count }))
    grid.append(ageing)
    const oldestT = h('div', { class: 'card c6' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Longest in transit' }), h('div', { class: 'hint', text: 'Chase these with the carrier / Zendrop first' }))),
      f.inTransit.oldest.length ? tableView(['Order', 'Days', 'Status', 'Carrier', 'Country'], f.inTransit.oldest.map((o) => [o.name, fmtInt(o.days), (o.status || '').replace(/_/g, ' ').toLowerCase(), o.carrier || '–', o.country || '–'])) : h('p', { class: 'muted', text: 'Nothing in transit.' }))
    const oldestU = h('div', { class: 'card c6' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Oldest unfulfilled' }), h('div', { class: 'hint', text: 'Paid, not yet shipped' }))),
      f.unfulfilled.oldest.length ? tableView(['Order', 'Days', 'Units', 'Status', 'Payment'], f.unfulfilled.oldest.map((o) => [o.name, fmtInt(o.days), fmtInt(o.units), (o.status || '').replace(/_/g, ' ').toLowerCase(), (o.financial || '').toLowerCase()])) : h('p', { class: 'muted', text: 'Everything paid has shipped.' }))
    grid.append(oldestT, oldestU)
    const carriers = Object.entries(f.inTransit.carriers).sort((a, b) => b[1] - a[1]).slice(0, 6)
    if (carriers.length) grid.append(h('div', { class: 'card c4' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'In transit by carrier' }))), hbars(carriers.map(([k, v]) => ({ label: k, value: v })), { color: SERIES[0], total: f.inTransit.count })))
    grid.append(h('div', { class: 'card c8' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: `Period summary · ${state.days} days` }))),
      h('div', { class: 'kpis', style: 'grid-template-columns:repeat(auto-fit,minmax(120px,1fr))' },
        mini('Orders', fmtInt(f.period.orders), delta(f.period.orders, f.prior.orders)),
        mini('Units', fmtInt(f.period.units), delta(f.period.units, f.prior.units)),
        mini('Revenue', fmtMoney(f.period.revenue), null),
        mini('Renewal orders', fmtInt(f.period.renewals), h('div', { class: 'delta' }, h('span', { class: 'muted', text: `${f.period.orders ? Math.round((f.period.renewals / f.period.orders) * 100) : 0}% of orders` }))),
        mini('New subscriptions', fmtInt(f.period.newSubs), null),
        mini('Fulfilled of placed', f.period.orders ? Math.round((f.period.fulfilledOfCreated / f.period.orders) * 100) + '%' : '–', null))))
    sec.append(grid)
    return sec
  }
  function tile(label, value, unit, deltaEl, spark) {
    return h('div', { class: 'card tile' }, h('div', { class: 'label', text: label }), h('div', { class: 'value' }, value, unit ? h('small', { text: unit }) : null), deltaEl, spark ? h('div', { class: 'spark' }, spark) : null)
  }
  function mini(label, value, deltaEl) {
    return h('div', { class: 'tile' }, h('div', { class: 'label', text: label }), h('div', { class: 'value', style: 'font-size:22px', text: value }), deltaEl)
  }

  // ----- Panel 2: inventory on hand -----
  function inventorySection(d, dec) {
    const sec = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'Inventory on hand' }), h('span', { class: 'why', text: 'Two stock lines, two lead times. Packaging on hand is what turns a 22-day reorder into a 10-day one.' })))
    const grid = h('div', { class: 'grid' })
    const need30 = dec.need30.total
    grid.append(stockCard('Packaging', dec.packaging, dec.packaging == null ? null : dec.packaging / (dec.perUnit || 1), need30, d.inventory.packaging.countedAt, 'manual count', dec.coverP, d.settings.lead_packaging, dec.perUnit !== 1 ? `${dec.perUnit} per finished unit` : null))
    grid.append(stockCard('Finished goods', dec.finishedRaw, dec.finished, need30, d.inventory.finished.countedAt, d.inventory.finished.source === 'shopify' ? 'Shopify inventory' : 'manual count', dec.coverF, dec.leadF, dec.backlog ? `${fmtInt(dec.backlog)} units already owed to unfulfilled orders are subtracted` : null))
    const vars = d.inventory.finished.variants || []
    const tracked = vars.filter((v) => v.tracked)
    grid.append(h('div', { class: 'card c4' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'By variant (Shopify)' }), h('div', { class: 'hint', text: tracked.length ? `${tracked.length} tracked variant${tracked.length === 1 ? '' : 's'}` : 'No tracked variants returned' }))),
      tracked.length ? h('div', { style: 'max-height:230px;overflow:auto' }, tableView(['Variant', 'On hand'], tracked.sort((a, b) => b.onHand - a.onHand).map((v) => [v.title || v.sku || v.id, fmtInt(v.onHand)]))) : h('p', { class: 'muted', text: d.integrations.shopify.configured ? 'Turn on inventory tracking for the product in Shopify, or switch finished goods to a manual count in Settings.' : 'Connect Shopify to list variants.' })))
    sec.append(grid)
    return sec
  }
  function stockCard(name, units, effective, need30, countedAt, source, cover, lead, note) {
    const ratio = units == null || !need30 ? null : Math.min(1, effective / need30)
    const cls = cover == null ? 'na' : cover < (lead || 0) ? 'bad' : cover < (lead || 0) + 14 ? 'warn' : 'good'
    const label = cover == null ? 'needs input' : cover < (lead || 0) ? 'below lead time' : cover < (lead || 0) + 14 ? 'reorder window' : 'healthy'
    return h('div', { class: 'card c4 tile' },
      h('div', { class: 'card-head' }, h('div', null, h('h3', { text: name }), h('div', { class: 'hint', text: `${source}${countedAt ? ' · ' + fmtDate(countedAt) + ' ' + fmtTime(countedAt) : ''}` })), h('div', { class: 'tools' }, h('span', { class: `status ${cls}`, text: label }))),
      h('div', { class: 'value' }, units == null ? '–' : fmtInt(units), h('small', { text: 'units' })),
      h('div', { class: `meter ${cls === 'na' ? '' : cls}` },
        h('div', { class: 'row' }, h('span', { text: 'vs 30-day need' }), h('span', { text: need30 ? `${fmtInt(need30)} needed` : 'need unknown' })),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${ratio == null ? 0 : ratio * 100}%` }))),
      h('div', { class: 'note' }, h('b', null, cover == null ? '–' : (cover >= HORIZON ? `${HORIZON}+` : fmt1(cover)) + ' days'), ' of cover under the current scenario', lead != null ? ` · lead time ${lead} d` : ' · lead time not set'),
      note ? h('div', { class: 'note', text: note }) : null)
  }

  // ----- Panel 3: the 30-day need -----
  function needSection(d, dec) {
    const S = d.settings
    const sec = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'The 30-day need' }), h('span', { class: 'why', text: 'Committed renewals (known) + new orders at run rate + what scaling adds. Drag the slider to test a scale.' })))
    const grid = h('div', { class: 'grid' })
    const n = dec.need30
    const total = Math.max(1, n.total)
    const parts = [
      { name: 'Committed renewals', v: n.committed, c: SERIES[2], src: d.renewals ? (d.renewals.source === 'loop' ? `Loop · ${fmtInt(d.renewals.subscriptions)} subscriptions due` : `estimate from ${fmtInt(d.renewals.subscriptions)} renewal orders in the last 30 d`) : 'no data' },
      { name: 'Baseline new orders', v: n.baseline, c: SERIES[0], src: d.runRate ? `${fmt1(d.runRate.newUnitsPerDay)} units/day over the last ${d.runRate.baselineDays} d` : 'no data' },
      { name: `Scale uplift (${state.scaleDays} d at ${S.scale_pct}%/day)`, v: n.scaled, c: SERIES[1], src: state.scaleDays ? `demand holds at ${fmt1((d.runRate?.newUnitsPerDay || 0) * Math.pow(1 + S.scale_pct / 100, state.scaleDays))} units/day after the run` : 'no scale selected' },
    ]
    const slider = h('input', { type: 'range', min: 0, max: 10, step: 1, value: state.scaleDays, 'aria-label': 'Days of scaling' })
    slider.addEventListener('input', () => { state.scaleDays = Number(slider.value); render() })
    grid.append(h('div', { class: 'card c6' },
      h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Units needed in the next 30 days' }), h('div', { class: 'hint', text: 'Three inputs, summed' }))),
      h('div', { class: 'value', style: 'font-size:34px;font-weight:600' }, fmtInt(n.total), h('small', { text: 'units' })),
      h('div', { class: 'stack' }, parts.map((p) => h('div', { style: `width:${(p.v / total) * 100}%;background:${p.c}`, title: p.name }))),
      h('div', { class: 'stack-key' }, parts.map((p) => h('div', { class: 'r' }, h('i', { style: `background:${p.c}` }), h('span', null, p.name, ' ', h('span', { class: 'src', text: '· ' + p.src })), h('b', { text: fmtInt(p.v) })))),
      h('h3', { style: 'margin-top:18px', text: 'Scale scenario' }),
      h('div', { class: 'slider' }, slider, h('div', { class: 'n' }, String(state.scaleDays), h('small', { text: ' days' }))),
      h('div', { class: 'ticks' }, ['0', '3', '7', '10'].map((t) => h('span', { text: t }))),
      h('div', { class: 'note' }, 'Budgets scale ', h('b', null, `${S.scale_pct}% per day`), ' while ads hit KPI, then hold. Last breakthrough ran 3 days; "we could technically do 7, 10 days in a row."'),
      dec.maxN != null ? h('div', { class: 'note' }, h('b', null, `Longest safe scale: ${dec.maxNLabel}`), ' before finished goods fall inside the lead time.') : null))
    // Projection: cumulative demand vs stock, next 45 days
    const H = 45
    const labels = Array.from({ length: H }, (_, i) => new Date(Date.now() + (i + 1) * 86400e3).toISOString().slice(0, 10))
    let cum = 0, cum0 = 0
    const cumS = dec.curve.slice(0, H).map((v) => (cum += v))
    const cumB = dec.base.slice(0, H).map((v) => (cum0 += v))
    const stock = labels.map(() => dec.finished ?? 0)
    const series = [{ name: 'Cumulative demand (scenario)', values: cumS, color: SERIES[1], format: fmtInt }, { name: 'Cumulative demand (no scale)', values: cumB, color: SERIES[0], format: fmtInt }]
    if (dec.finished != null) series.push({ name: 'Finished goods on hand', values: stock, color: SERIES[3], dashed: true, format: fmtInt })
    grid.append(chartCard('proj', 'Stock vs demand, next 45 days', dec.stockout ? `Scenario line crosses stock around ${fmtDate(dec.stockout)}` : 'Where the demand line crosses the stock line is the stockout', () => lineChart({ labels, series, height: 230, bandIdx: dec.coverF != null && dec.coverF < H ? Math.floor(dec.coverF) : null }),
      { span: 'c6', headers: ['Day', 'Scenario', 'No scale', 'Stock'], rows: labels.map((l, i) => [dayLabel(l), fmtInt(cumS[i]), fmtInt(cumB[i]), fmtInt(stock[i])]), legend: series.map((sr) => ({ name: sr.name, color: sr.color })) }))
    // Renewals by week
    if (d.renewals) grid.append(h('div', { class: 'card c4' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Renewals due by week' }), h('div', { class: 'hint', text: d.renewals.source === 'loop' ? 'From Loop Subscriptions' : 'Estimate: recurring orders billed in the last 30 days, by week' }))),
      hbars(d.renewals.weeks.slice(0, 5).map((v, i) => ({ label: i < 4 ? `Week ${i + 1}` : 'Days 29-30', value: v })), { color: SERIES[2], total: d.renewals.units })))
    grid.append(h('div', { class: 'card c4' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Run rate' }), h('div', { class: 'hint', text: `New (non-renewal) demand, last ${S.baseline_days} days` }))),
      h('div', { class: 'value', style: 'font-size:28px;font-weight:600' }, d.runRate ? fmt1(d.runRate.newUnitsPerDay) : '–', h('small', { text: 'units / day' })),
      d.runRate ? delta(d.runRate.newUnitsPerDay, d.runRate.priorNewUnitsPerDay) : null,
      h('div', { class: 'note' }, d.runRate ? `${fmt1(d.runRate.newOrdersPerDay)} orders/day · ${fmt1(d.runRate.unitsPerNewOrder)} units per order` : 'Waiting for order history')))
    grid.append(h('div', { class: 'card c4' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Daily demand after scaling' }), h('div', { class: 'hint', text: 'Units per day, day 1 to 30' }))),
      h('div', { class: 'chart' }, lineChart({ labels: labels.slice(0, 30), height: 150, sparse: true, series: [{ name: 'Scenario', values: dec.curve.slice(0, 30), color: SERIES[1], format: fmt1 }, { name: 'No scale', values: dec.base.slice(0, 30), color: SERIES[0], format: fmt1 }] })),
      h('div', { class: 'legend' }, h('span', { class: 'k' }, h('i', { style: `background:${SERIES[1]}` }), 'Scenario'), h('span', { class: 'k' }, h('i', { style: `background:${SERIES[0]}` }), 'No scale'))))
    sec.append(grid)
    return sec
  }

  // ----- Panel 4: the reorder decision -----
  function reorderSection(d, dec) {
    const S = d.settings
    const sec = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'Reorder decision' }), h('span', { class: 'why', text: 'The automated suggestions. Everything above is input to this table.' })))
    const grid = h('div', { class: 'grid' })
    const rows = [
      ['Days of cover remaining', dec.coverF == null ? (dec.noSales ? 'needs sales history' : '–') : `${dec.coverLabel} days`, `Finished goods on hand (${fmtInt(dec.finished)}${dec.backlog ? ', after ' + fmtInt(dec.backlog) + ' owed' : ''}) ÷ projected daily demand`, dec.coverF == null ? 'na' : dec.coverF < dec.leadF ? 'bad' : dec.coverF < dec.leadF + 14 ? 'warn' : 'good'],
      ['Order packaging by', dec.orderPackagingBy ? fmtDateLong(dec.orderPackagingBy) : 'needs packaging count + lead time', `Days of cover (packaging${dec.coverP != null ? ': ' + (dec.coverP >= HORIZON ? `${HORIZON}+` : fmt1(dec.coverP)) + ' d' : ''}) minus packaging lead time${S.lead_packaging != null ? ' (' + S.lead_packaging + ' d)' : ' (not set)'} minus ${dec.safety} d safety`, dec.orderPackagingBy ? (dec.orderPackagingBy < new Date() ? 'bad' : (dec.orderPackagingBy - Date.now()) / 86400e3 < 7 ? 'warn' : 'good') : 'na'],
      ['Order finished goods by', dec.orderFinishedBy ? fmtDateLong(dec.orderFinishedBy) : 'needs finished-goods count', `Days of cover minus ${dec.leadF} days (${dec.packagingOk ? 'packaging on hand' : 'no packaging on hand, so the full ' + S.lead_finished_without_packaging + ' d'}) minus ${dec.safety} d safety`, dec.orderFinishedBy ? (dec.orderFinishedBy < new Date() ? 'bad' : (dec.orderFinishedBy - Date.now()) / 86400e3 < 7 ? 'warn' : 'good') : 'na'],
      ['Can we scale?', dec.verdict === 'yes' ? 'Yes' : dec.verdict === 'no' ? 'No' : 'Unknown', dec.reason, dec.verdict === 'yes' ? 'good' : dec.verdict === 'no' ? 'bad' : 'na'],
    ]
    grid.append(h('div', { class: 'card c7', style: 'grid-column: span 12' },
      h('table', { class: 'dtable' }, h('thead', null, h('tr', null, h('th', { text: 'Output' }), h('th', { text: 'Today' }), h('th', { text: 'Logic' }))),
        h('tbody', null, rows.map((r, i) => h('tr', null, h('td', { class: 'out', text: r[0] }), h('td', null, h('span', { class: `status ${r[3]}`, text: r[1] })), h('td', { class: 'logic', text: r[2] })))))))
    // Suggestions
    const sug = []
    const daysTo = (dt) => Math.round((dt - Date.now()) / 86400e3)
    if (dec.verdict === 'no') sug.push({ cls: 'bad', ic: '!', t: `Do not scale ${state.scaleDays} days right now.`, s: dec.maxN != null && dec.maxN > 0 ? `Up to ${dec.maxNLabel} is safe. Re-check after the next batch lands.` : 'Place the finished-goods order first.' })
    if (dec.verdict === 'yes' && dec.maxN != null) sug.push({ cls: 'good', ic: '✓', t: `Scaling ${state.scaleDays} days is covered.`, s: dec.maxN === MAX_SCALE ? `Stock covers at least ${MAX_SCALE} days of scaling.` : `Longest safe run is ${dec.maxNLabel}. Beyond that, stock runs out before a reorder could land.` })
    if (dec.orderFinished > 0 && dec.orderFinishedBy) sug.push({ cls: daysTo(dec.orderFinishedBy) <= 7 ? 'warn' : '', ic: 'F', t: `Order ${fmtInt(dec.orderFinished)} finished units by ${fmtDateLong(dec.orderFinishedBy)}${daysTo(dec.orderFinishedBy) < 0 ? ' (overdue)' : ''}.`, s: `Covers the ${dec.leadF}-day lead time plus 30 days plus ${dec.safety} days safety under the current scenario${S.moq_finished ? ', rounded up to the ' + fmtInt(S.moq_finished) + ' MOQ' : ''}${S.unit_cost_finished ? ' · ~' + fmtMoney(dec.orderFinished * S.unit_cost_finished) : ''}.` })
    if (dec.orderPackaging != null && dec.orderPackaging > 0) sug.push({ cls: dec.orderPackagingBy && daysTo(dec.orderPackagingBy) <= 7 ? 'warn' : '', ic: 'P', t: `Order ${fmtInt(dec.orderPackaging)} packaging units${dec.orderPackagingBy ? ' by ' + fmtDateLong(dec.orderPackagingBy) : ''}.`, s: `Enough for the next finished-goods batch plus packaging lead time${S.moq_packaging ? ', rounded up to the ' + fmtInt(S.moq_packaging) + ' MOQ' : ''}. Packaging on hand is what keeps the finished-goods lead time at ${S.lead_finished_with_packaging} days instead of ${S.lead_finished_without_packaging}.` })
    if (!dec.packagingOk && dec.packaging != null) sug.push({ cls: 'warn', ic: 'P', t: 'Packaging is below one month of demand.', s: `Until it is replenished the finished-goods lead time is ${S.lead_finished_without_packaging} days, not ${S.lead_finished_with_packaging}.` })
    if (dec.packaging == null) sug.push({ cls: 'warn', ic: '?', t: 'Enter packaging on hand.', s: 'Settings → Stock on hand. Without it the packaging reorder date cannot be computed.' })
    if (S.lead_packaging == null) sug.push({ cls: 'warn', ic: '?', t: 'Confirm the packaging lead time with Calvin.', s: 'He gave 22 days for product and 10 with packaging in hand, but not how long packaging itself takes.' })
    if (!S.moq_finished || !S.moq_packaging) sug.push({ cls: '', ic: '?', t: 'Add minimum order quantities and unit costs.', s: 'Suggested quantities then round up to the MOQ and show the cash needed.' })
    if (d.fulfilment && d.fulfilment.unfulfilled.buckets['4-7 days'] + d.fulfilment.unfulfilled.buckets['8-14 days'] + d.fulfilment.unfulfilled.buckets['15+ days'] > 0) sug.push({ cls: 'warn', ic: 'Z', t: `${fmtInt(d.fulfilment.unfulfilled.count - d.fulfilment.unfulfilled.buckets['0-3 days'])} orders unfulfilled for more than 3 days.`, s: 'Raise with Zendrop today; these are the ones that turn into chargebacks.' })
    grid.append(h('div', { class: 'card', style: 'grid-column: span 12' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Suggested actions' }), h('div', { class: 'hint', text: 'Recomputed on every refresh and every slider move' }))),
      h('div', { class: 'suggest' }, sug.map((x) => h('div', { class: `s ${x.cls}` }, h('span', { class: 'ic', text: x.ic }), h('div', null, x.t, h('small', { text: x.s })))))))
    sec.append(grid)
    return sec
  }

  // ----- Panel 5: ops queues -----
  function opsSection(d) {
    const sec = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'Ops queues' }), h('span', { class: 'why', text: 'Open issues with Zendrop and escalations in ClickUp.' })))
    const grid = h('div', { class: 'grid' })
    const zd = d.ops.zendrop
    const noInnadermRows = zd && !zd.error && zd.tabs && zd.tabs.every((t) => t.error || !t.rowsInnaderm)
    if (noInnadermRows) {
      const skipped = zd.tabs.reduce((n, t) => n + (t.skippedSerentia || 0), 0)
      grid.append(h('div', { class: 'card c4 setup' }, h('h3', { text: 'Zendrop issues' }), h('p', { text: `No Innaderm orders in this Zendrop sheet yet${skipped ? ` (${fmtInt(skipped)} Serentia #SER rows hidden)` : ''}. When Zendrop shares an Innaderm sheet, paste its id in Settings → Sources and open issues show here.` })))
    } else if (zd && !zd.error && zd.tabs) {
      for (const t of zd.tabs) {
        if (t.error) { grid.append(h('div', { class: 'card c4' }, h('h3', { text: t.name }), h('p', { class: 'muted', text: t.error }))); continue }
        const topics = Object.entries(t.byTopic).sort((a, b) => b[1] - a[1]).slice(0, 7)
        grid.append(h('div', { class: 'card c4' },
          h('div', { class: 'card-head' }, h('div', null, h('h3', { text: `Zendrop · ${t.name}` }), h('div', { class: 'hint', text: `${fmtInt(t.open)} open · ${fmtInt(t.raised7)} raised and ${fmtInt(t.resolved7)} resolved in 7 d · oldest ${fmtInt(t.oldestDays)} d` })), h('div', { class: 'tools' }, h('a', { class: 'tbtn', href: `https://docs.google.com/spreadsheets/d/${zd.sheetId}/edit#gid=${t.gid}`, target: '_blank', rel: 'noopener', text: 'Open sheet' }))),
          topics.length ? hbars(topics.map(([k, v]) => ({ label: k, value: v })), { color: SERIES[2], total: t.open }) : h('p', { class: 'muted', text: 'No open issues.' }),
          t.openRows.length ? h('div', { class: 'list', style: 'margin-top:10px' }, t.openRows.slice(0, 5).map((r) => h('div', { class: 'it' }, h('span', null, h('b', { text: r.order }), ' ', h('span', { class: 'm', text: r.topic })), h('span', { class: 'age' + (r.ageDays > 14 ? ' bad' : ''), text: r.ageDays == null ? '' : r.ageDays + ' d' })))) : null))
      }
    } else grid.append(h('div', { class: 'card c4' }, h('h3', { text: 'Zendrop sheet' }), h('p', { class: 'muted', text: zd?.error || 'Not available' })))
    const cu = d.ops.clickup
    if (!d.integrations.clickup.configured) grid.append(h('div', { class: 'card c4 setup' }, h('h3', { text: 'ClickUp escalations' }), h('p', null, 'Add ', h('code', null, 'INNADERM_CLICKUP_TOKEN'), ' (a personal API token) in Vercel to show open Founder Escalations and Ops Overview tasks here.')))
    else if (cu?.error) grid.append(h('div', { class: 'card c4' }, h('h3', { text: 'ClickUp' }), h('p', { class: 'muted', text: cu.error })))
    else for (const l of cu?.lists || []) {
      grid.append(h('div', { class: 'card c4' },
        h('div', { class: 'card-head' }, h('div', null, h('h3', { text: `ClickUp · ${l.name}` }), h('div', { class: 'hint', text: l.error || `${fmtInt(l.total)} open · ${fmtInt(l.overdue)} overdue · ${fmtInt(l.unassigned)} unassigned` })), h('div', { class: 'tools' }, h('a', { class: 'tbtn', href: `https://app.clickup.com/90121504327/v/l/li/${l.id}`, target: '_blank', rel: 'noopener', text: 'Open list' }))),
        l.byStatus ? hbars(Object.entries(l.byStatus).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => ({ label: k, value: v })), { color: SERIES[0], total: l.total }) : null,
        l.tasks?.length ? h('div', { class: 'list', style: 'margin-top:10px' }, l.tasks.slice(0, 6).map((t) => h('div', { class: 'it' }, h('span', null, h('a', { href: t.url, target: '_blank', rel: 'noopener', text: t.name }), ' ', h('span', { class: 'm', text: t.status + (t.assignees.length ? ' · ' + t.assignees.join(', ') : '') })), h('span', { class: 'age' + (t.overdue ? ' bad' : ''), text: t.due ? (t.overdue ? 'overdue ' : 'due ') + fmtDate(t.due) : '' })))) : h('p', { class: 'muted', text: 'Nothing open.' })))
    }
    sec.append(grid)
    return sec
  }

  // ---------- settings drawer (admin) ----------
  function openDrawer() { state.drawer = true; state.newKey = null; render(); if (!DEMO) api('/keys').then((r) => { state.keys = r.keys; render() }).catch(() => {}) }
  function closeDrawer() { state.drawer = false; render() }
  function drawer() {
    if (!state.drawer || state.me.role !== 'admin') return h('div')
    const S = state.data?.settings || state.cs?.settings || {}
    const meta = state.data?.settingsMeta || state.cs?.settingsMeta || {}
    const form = {}
    const F = (key, label, help, type = 'number', opts) => {
      let input
      if (opts) { input = h('select', null, opts.map(([v, l]) => h('option', { value: v, selected: S[key] === v, text: l }))) }
      else input = h('input', { type, value: S[key] ?? '', step: 'any', min: 0, placeholder: '–' })
      form[key] = input
      const m = meta[key]
      return h('div', { class: 'field' }, h('label', { text: label }), input, h('div', { class: 'help', text: help + (m ? ` · set ${fmtDate(m.at)} by ${m.by || '?'}` : '') }))
    }
    const msg = h('div', { class: 'msg' })
    const save = async () => {
      const patch = {}
      for (const [k, el] of Object.entries(form)) patch[k] = el.value === '' ? null : el.tagName === 'SELECT' || el.type !== 'number' ? el.value : Number(el.value)
      if (patch.finished_on_hand != null) patch.finished_counted_at = new Date().toISOString()
      if (patch.packaging_on_hand != null && patch.packaging_on_hand !== S.packaging_on_hand) patch.packaging_counted_at = new Date().toISOString()
      msg.textContent = 'Saving…'
      try {
        if (DEMO) { Object.assign(S, patch); msg.textContent = 'Saved (demo, not persisted)'; render(); return }
        const r = await api('/settings', { method: 'PUT', body: patch })
        msg.textContent = r.errors?.length ? 'Saved with notes: ' + r.errors.join('; ') : 'Saved'
        if (state.view === 'cs') { state.data = null; await loadCs() } else { state.cs = null; await load() }
        state.drawer = true; render()
      } catch (e) { msg.textContent = e.message }
    }
    const keyName = h('input', { type: 'text', placeholder: 'Who is this key for? e.g. Calvin' })
    const keyRole = h('select', null, h('option', { value: 'viewer', text: 'Viewer' }), h('option', { value: 'admin', text: 'Admin (can edit inputs and keys)' }))
    const issue = async () => {
      try {
        const r = DEMO ? { key: 'inn_demo0000-demo0000-demo0000-demo0000', name: keyName.value } : await api('/keys', { method: 'POST', body: { name: keyName.value, role: keyRole.value } })
        state.newKey = r
        if (!DEMO) state.keys = (await api('/keys')).keys
        render()
      } catch (e) { alert(e.message) }
    }
    const revoke = async (k) => {
      if (!confirm(`Revoke the key for ${k.name}? They will be signed out everywhere.`)) return
      try { await api(`/keys?id=${k.id}`, { method: 'DELETE' }); state.keys = (await api('/keys')).keys; render() } catch (e) { alert(e.message) }
    }
    const panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Settings' },
      h('div', { style: 'display:flex;align-items:center;gap:10px' }, h('h2', { text: 'Settings' }), h('button', { class: 'btn ghost sm', style: 'margin-left:auto', text: 'Close', onclick: closeDrawer })),
      h('h3', { text: 'Stock on hand' }),
      h('div', { class: 'form' },
        F('finished_source', 'Finished goods source', 'Shopify sums every tracked variant; manual uses the count below', null, [['shopify', 'Shopify inventory'], ['manual', 'Manual count']]),
        F('finished_on_hand', 'Finished goods on hand (manual)', 'units counted; only used when source is manual'),
        F('packaging_on_hand', 'Packaging on hand', 'units of packaging ready for the manufacturer'),
        F('packaging_per_unit', 'Packaging per finished unit', 'usually 1')),
      h('h3', { text: 'Lead times (days)' }),
      h('div', { class: 'form' },
        F('lead_finished_with_packaging', 'Finished goods, packaging on hand', 'Calvin: "they only need like 10 days"'),
        F('lead_finished_without_packaging', 'Finished goods, no packaging', 'Calvin: "it takes 22 days"'),
        F('lead_packaging', 'Packaging lead time', 'not given in the brief - confirm with Calvin'),
        F('safety_days', 'Safety buffer', 'days added on top of every lead time')),
      h('h3', { text: 'Order sizes & cost' }),
      h('div', { class: 'form' },
        F('moq_finished', 'MOQ finished goods', 'suggested quantities round up to this'),
        F('moq_packaging', 'MOQ packaging', ''),
        F('unit_cost_finished', 'Unit cost finished ($)', 'shows cash needed per suggestion'),
        F('unit_cost_packaging', 'Unit cost packaging ($)', '')),
      h('h3', { text: 'Demand model' }),
      h('div', { class: 'form' },
        F('baseline_days', 'Run-rate window (days)', 'new-order units per day are averaged over this window'),
        F('scale_pct', 'Scale % per day', 'Calvin: "we scale budgets by 20% per day"'),
        F('scale_days_default', 'Default scale days', 'where the slider starts')),
      h('h3', { text: 'Customer service' }),
      h('div', { class: 'form' },
        F('cs_response_target_hours', 'Reply within (hours)', 'Calvin: "keep it under 24 hours"'),
        F('dispute_rate_pct', 'Dispute rate (%)', 'from Shopify Payments; 0.9% on 12 Oct'),
        F('dispute_threshold_pct', 'Hold threshold (%)', 'processor hold at 1%'),
        F('dispute_rate_at', 'Dispute rate as of', 'date you read the rate', 'date')),
      h('div', { class: 'actions' }, h('button', { class: 'btn', text: 'Save inputs', onclick: save }), msg),
      h('h3', { text: 'Access keys' }),
      h('p', { class: 'muted', style: 'font-size:12.5px;margin:0 0 8px', text: 'One key per person. Revoking a key signs that person out everywhere. The admin key from Vercel (INNADERM_ADMIN_KEY) is listed once it has been used.' }),
      h('div', { class: 'form' }, h('div', { class: 'field' }, h('label', { text: 'Name' }), keyName), h('div', { class: 'field' }, h('label', { text: 'Role' }), keyRole)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', text: 'Issue key', onclick: issue })),
      state.newKey ? h('div', { class: 'newkey' }, `New key for ${state.newKey.name}. Copy it now; it is not shown again.`, h('code', { text: state.newKey.key }), h('button', { class: 'btn sm ghost', text: 'Copy', onclick: () => navigator.clipboard?.writeText(state.newKey.key) })) : null,
      h('div', { style: 'margin-top:12px' }, (state.keys || []).map((k) => h('div', { class: 'keyrow' },
        h('div', null, h('b', { text: k.name }), k.you ? ' (you)' : '', h('div', { class: 'm', text: `${k.role} · created ${fmtDate(k.createdAt)}${k.lastUsedAt ? ' · last used ' + fmtDate(k.lastUsedAt) : ' · never used'}${k.revokedAt ? ' · REVOKED ' + fmtDate(k.revokedAt) : ''}` })),
        !k.revokedAt && !k.you ? h('button', { class: 'btn sm danger', text: 'Revoke', onclick: () => revoke(k) }) : h('span')))),
      h('h3', { text: 'Sources' }),
      h('p', { class: 'muted', style: 'font-size:12.5px', text: `Shopify store: ${state.data?.integrations.shopify.store}. Zendrop sheet id: ${S.zendrop_sheet_id}. ClickUp lists: ${(S.clickup_lists || []).map((l) => l.name).join(', ')}. Change these in Vercel env / the settings API.` }))
    return h('div', { class: 'drawer open' }, h('div', { class: 'scrim', onclick: closeDrawer }), panel)
  }

  // ---------- Customer service tab (support Gmail) ----------
  // Calvin, 12 Oct: % of tickets by type, ageing buckets, average response
  // time per agent, abnormal spikes, and which types to automate.
  async function loadCs() {
    if (DEMO) { state.cs = demoCs(); render(); return }
    state.csLoading = true; state.csError = null; render()
    try { state.cs = await api(`/cs?days=${state.days}`) } catch (e) { state.csError = e.message }
    state.csLoading = false; render()
  }

  const hrsTxt = (v) => (v == null ? '–' : v < 1 ? Math.round(v * 60) + ' min' : hours(v))
  const pctTxt = (v) => (v == null ? '–' : Math.round(v) + '%')
  const FLAG_LABEL = { chargeback: 'Chargeback', legal: 'Legal / BBB', reaction: 'Reaction', angry: 'Angry' }
  const AUTO_LABEL = { high: 'Automate', medium: 'Macro + check', low: 'Human', never: 'Never automate' }
  function tag(text, cls = '') { return h('span', { class: 'tag ' + cls, text }) }
  function ppDelta(cur, prev, upGood = false) {
    if (prev == null || cur == null) return h('span', { class: 'muted', text: 'new' })
    const d = Math.round(cur - prev)
    return h('span', { class: d === 0 ? 'flat' : (d > 0) === upGood ? 'up' : 'down', text: d === 0 ? '±0 pts' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} pts` })
  }

  // Vertical bars for a 24-hour profile, hover per bar.
  function columnChart(values, labels, { color = 'var(--s1)', height = 160, name = 'Messages' } = {}) {
    const W = 380, H = height, m = { t: 10, r: 6, b: 22, l: 28 }
    const iw = W - m.l - m.r, ih = H - m.t - m.b, n = values.length
    const max = Math.max(1, ...values) * 1.1
    const bw = iw / n
    const y = (v) => m.t + ih - (v / max) * ih
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' })
    const grid = s('g', { class: 'grid' }); const ax = s('g', { class: 'axis' })
    niceTicks(max, 3).forEach((t) => { grid.append(s('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) })); ax.append(s('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end', text: fmtCompact(t) })) })
    svg.append(grid)
    values.forEach((v, i) => {
      const x = m.l + i * bw + 1, w = Math.max(1, bw - 2), top = y(v), hgt = m.t + ih - top
      const r = Math.min(4, w / 2, hgt)
      svg.append(s('path', { d: hgt <= 0 ? '' : `M${x},${m.t + ih}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${m.t + ih}Z`, fill: color }))
      if (i % 6 === 0) ax.append(s('text', { x: x + w / 2, y: H - 6, 'text-anchor': 'middle', text: labels[i] }))
      const hit = s('rect', { class: 'hit', x: m.l + i * bw, y: m.t, width: bw, height: ih })
      hit.addEventListener('pointermove', (ev) => showTip(ev.clientX, ev.clientY, labels[i], [{ color, label: name, value: fmtInt(v) }]))
      hit.addEventListener('pointerleave', hideTip)
      svg.append(hit)
    })
    svg.append(s('line', { class: 'base', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }))
    svg.append(ax)
    return svg
  }

  function csView() {
    const wrap = h('div', { class: 'wrap' + (state.csLoading && state.cs ? ' fade' : '') })
    if (state.csError) wrap.append(h('div', { class: 'banner bad' }, `Could not load: ${state.csError}`, h('button', { class: 'btn sm ghost', text: 'Retry', onclick: loadCs })))
    const c = state.cs
    if (!c) { if (!state.csError) wrap.append(h('div', { class: 'banner info', text: 'Loading customer service…' })); return wrap }
    if (!c.connected) { wrap.append(csSetup(c)); return wrap }
    const T = c.totals, target = c.target
    const tz = c.timezone

    // Headline
    const headline = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'Response time' }), h('span', { class: 'why', text: `Calvin's rule: every customer answered within ${target} hours. Slow replies turn into chargebacks.` })))
    headline.append(h('div', { class: 'kpis' },
      tile(`Answered within ${target} h`, pctTxt(T.withinTargetPct), null, T.withinTargetPctPrior != null ? h('div', { class: 'delta' }, ppDelta(T.withinTargetPct, T.withinTargetPctPrior, true), h('span', { class: 'muted', text: `vs prior ${state.days}d` })) : h('div', { class: 'delta' }, h('span', { class: 'muted', text: `${fmtInt(T.withinTargetOk)} of ${fmtInt(T.withinTargetJudged)} tickets` })), null),
      tile('Avg first response', hrsTxt(T.avgFrtHours), null, T.avgFrtHoursPrior != null ? delta(T.avgFrtHours, T.avgFrtHoursPrior, { upGood: false }) : h('div', { class: 'delta' }, h('span', { class: 'muted', text: `median ${hrsTxt(T.medFrtHours)}` })), null),
      tile('Avg response, every reply', hrsTxt(T.avgResponseHours), null, T.avgResponseHoursPrior != null ? delta(T.avgResponseHours, T.avgResponseHoursPrior, { upGood: false }) : h('div', { class: 'delta' }, h('span', { class: 'muted', text: `median ${hrsTxt(T.medResponseHours)}` })), null),
      tile('Waiting for a reply now', fmtInt(T.awaiting), null, h('div', { class: 'delta' }, h('span', { class: T.overTarget ? 'down' : 'up', text: T.overTarget ? `${fmtInt(T.overTarget)} over ${target} h` : `none over ${target} h` })), null),
      tile('New tickets', fmtInt(T.tickets), `${fmt1(T.perDay)}/day`, delta(T.tickets, T.ticketsPrior, { upGood: false }), sparkline(c.series.map((r) => r.tickets), SERIES[0]))))
    headline.append(h('div', { class: 'kpis', style: 'margin-top:14px' },
      mini('Solved in one reply', pctTxt(T.fcrPct), h('div', { class: 'delta' }, h('span', { class: 'muted', text: 'customer did not write again · target 60%' }))),
      mini('Replies sent', fmtInt(T.replies), delta(T.replies, T.repliesPrior)),
      mini('Repeat customers', fmtInt(T.repeatCustomers), h('div', { class: 'delta' }, h('span', { class: 'muted', text: `of ${fmtInt(T.uniqueCustomers)} wrote 2+ tickets` }))),
      mini('Risk-flagged tickets', fmtInt(T.flagged), h('div', { class: 'delta' }, h('span', { class: T.flaggedWaiting ? 'down' : 'flat', text: T.flaggedWaiting ? `${fmtInt(T.flaggedWaiting)} still waiting` : 'none waiting' }))),
      disputeMini(c.dispute)))
    wrap.append(headline)

    // What customers write about
    const cats = c.categories
    const topics = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'What customers write about' }), h('span', { class: 'why', text: 'Share of new tickets by type. A jump against the prior period is flagged.' })))
    const tg = h('div', { class: 'grid' })
    tg.append(chartCard('cs-cats', 'Tickets by type', `${fmtInt(T.tickets)} new tickets in ${state.days} days`, () => catBars(cats),
      { span: 'c8', headers: ['Type', 'Tickets', 'Share', 'Prior share', 'Avg first reply', 'Automation'], rows: cats.map((x) => [x.name, fmtInt(x.count), pctTxt(x.share), pctTxt(x.priorShare), hrsTxt(x.avgFrtHours), AUTO_LABEL[x.auto] || '']) }))
    const spikes = cats.filter((x) => x.spike)
    tg.append(h('div', { class: 'card c4' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Abnormal spikes' }), h('div', { class: 'hint', text: 'Types up 5+ points and 1.5x their usual share; days over twice the normal spread' }))),
      spikes.length || c.spikeDays.length
        ? h('div', { class: 'list' },
          spikes.map((x) => h('div', { class: 'it' }, h('span', null, h('b', { text: x.name }), ' ', h('span', { class: 'm', text: `${pctTxt(x.priorShare)} → ${pctTxt(x.share)} of tickets` })), tag('Spike', 'bad'))),
          c.spikeDays.map((d2) => h('div', { class: 'it' }, h('span', null, h('b', { text: dayLabel(d2.day) }), ' ', h('span', { class: 'm', text: `${fmtInt(d2.tickets)} tickets (normal ≈ ${fmtInt(d2.normal)})` })), tag('Busy day', 'warn'))))
        : h('p', { class: 'muted', text: 'Nothing abnormal in this period.' })))
    topics.append(tg)
    wrap.append(topics)

    // Automation candidates
    const autoRows = cats.filter((x) => x.auto === 'high' || x.auto === 'medium').slice(0, 6)
    const weekly = (n) => (n / state.days) * 7
    const autoTotal = autoRows.filter((x) => x.auto === 'high').reduce((a, x) => a + x.count, 0)
    const autoSec = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'What to automate first' }), h('span', { class: 'why', text: `Biggest repeatable types. Fully automatable types are ${pctTxt(T.tickets ? (autoTotal / T.tickets) * 100 : null)} of tickets (≈${fmtInt(weekly(autoTotal))} a week).` })))
    autoSec.append(h('div', { class: 'card' }, autoRows.length
      ? h('table', { class: 'dtable' }, h('thead', null, h('tr', null, h('th', { text: 'Type' }), h('th', { text: 'Share' }), h('th', { text: 'Per week' }), h('th', { text: 'How' }), h('th', { text: 'Suggested move' }))),
        h('tbody', null, autoRows.map((x) => h('tr', null, h('td', null, h('b', { text: x.name })), h('td', { text: pctTxt(x.share) }), h('td', { text: fmtInt(weekly(x.count)) }), h('td', null, tag(AUTO_LABEL[x.auto], x.auto === 'high' ? 'good' : 'warn')), h('td', { class: 'logic', text: x.play })))))
      : h('p', { class: 'muted', text: 'Not enough tickets yet.' })))
    wrap.append(autoSec)

    // Backlog & ageing
    const back = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'Backlog & ageing' }), h('span', { class: 'why', text: 'Tickets where the customer wrote last and nobody has replied. Archiving in Gmail takes a ticket off this list.' })))
    const bg = h('div', { class: 'grid' })
    bg.append(h('div', { class: 'card c4' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Waiting by age' }), h('div', { class: 'hint', text: `${fmtInt(T.awaiting)} tickets waiting · time since the customer last wrote` }))),
      hbars(Object.entries(c.ageing).map(([k, v], i) => ({ label: k, value: v, color: i === 0 ? SERIES[0] : 'var(--s4)' })), { total: T.awaiting }),
      h('div', { class: 'note', style: 'margin-top:10px;font-size:12px', text: 'Blue is inside the 24-hour rule; red is over it.' })))
    bg.append(h('div', { class: 'card c8' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Oldest waiting' }), h('div', { class: 'hint', text: 'Answer these first. Opens the thread in Gmail.' }))),
      c.oldest.length ? h('div', { class: 'list', style: 'max-height:340px;overflow:auto' }, c.oldest.map((t) => h('div', { class: 'it' },
        h('span', null, h('a', { href: t.link, target: '_blank', rel: 'noopener', text: t.subject }), ' ', h('span', { class: 'm', text: `${t.category}${t.customer ? ' · ' + t.customer : ''}${t.followUps ? ` · ${t.followUps} follow-up${t.followUps > 1 ? 's' : ''}` : ''}` }), ' ', (t.flags || []).map((f) => tag(FLAG_LABEL[f] || f, 'bad'))),
        h('span', { class: 'age' + (t.waitingHours > target ? ' bad' : ''), text: hrsTxt(t.waitingHours) }))))
        : h('p', { class: 'muted', text: 'Inbox zero. Nobody is waiting.' })))
    back.append(bg)
    wrap.append(back)

    // Team performance
    const team = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'Team & workload' }), h('span', { class: 'why', text: 'Who replied and how fast, taken from the name in each reply\'s sign-off.' })))
    const pg = h('div', { class: 'grid' })
    pg.append(chartCard('cs-flow', 'Tickets in, replies out', 'New tickets and replies sent per day', () => lineChart({
      labels: c.series.map((r) => r.day),
      series: [{ name: 'New tickets', values: c.series.map((r) => r.tickets), color: SERIES[0] }, { name: 'Replies sent', values: c.series.map((r) => r.replies), color: SERIES[1] }],
    }), { span: 'c8', headers: ['Day', 'New tickets', 'Customer messages', 'Replies sent'], rows: c.series.map((r) => [dayLabel(r.day), fmtInt(r.tickets), fmtInt(r.customerMsgs), fmtInt(r.replies)]), legend: [{ name: 'New tickets', color: SERIES[0] }, { name: 'Replies sent', color: SERIES[1] }] }))
    const fb = Object.entries(c.frtBuckets)
    pg.append(h('div', { class: 'card c4' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'First reply speed' }), h('div', { class: 'hint', text: 'New tickets in the period, by time to first reply' }))),
      hbars(fb.map(([k, v]) => ({ label: k, value: v, color: /24-48|48 h|No reply/.test(k) ? 'var(--s4)' : SERIES[0] })), { total: T.tickets })))
    pg.append(h('div', { class: 'card c8' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'By agent' }), h('div', { class: 'hint', text: 'Unattributed = replies with no agent name in the sign-off' }))),
      c.agents.length ? h('div', { style: 'overflow:auto' }, tableView(['Agent', 'Replies', 'Avg response', 'Median', 'First replies', 'Avg first reply', `Within ${target} h`],
        c.agents.map((a) => [a.agent, fmtInt(a.replies), hrsTxt(a.avgResponseHours), hrsTxt(a.medResponseHours), fmtInt(a.firstReplies), hrsTxt(a.avgFrtHours), pctTxt(a.withinTargetPct)])))
        : h('p', { class: 'muted', text: 'No replies in this period.' })))
    const hourLabels = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + ':00')
    pg.append(chartCard('cs-hours', 'When customers write', `Customer messages by hour, ${tz.replace('_', ' ')} time`, () => columnChart(c.byHour, hourLabels, { color: SERIES[2], name: 'Customer messages', height: 190 }),
      { span: 'c4', headers: ['Hour', 'Messages'], rows: c.byHour.map((v, i) => [hourLabels[i], fmtInt(v)]) }))
    team.append(pg)
    wrap.append(team)

    // Risk
    const risk = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'Dispute risk' }), h('span', { class: 'why', text: 'Tickets mentioning a chargeback, the bank, the BBB, a lawyer or a skin/stomach reaction. These go to Calvin the same day.' })))
    risk.append(h('div', { class: 'card' }, c.risk.length ? h('div', { class: 'list' }, c.risk.map((r) => h('div', { class: 'it' },
      h('span', null, h('a', { href: r.link, target: '_blank', rel: 'noopener', text: r.subject }), ' ', h('span', { class: 'm', text: `${r.category}${r.customer ? ' · ' + r.customer : ''} · ${fmtDate(r.at)}` }), ' ', r.flags.map((f) => tag(FLAG_LABEL[f] || f, 'bad'))),
      r.waiting ? tag('Waiting', 'bad') : tag('Replied', 'good'))))
      : h('p', { class: 'muted', text: 'No risk-flagged tickets in this period.' })))
    wrap.append(risk)

    wrap.append(h('footer', { class: 'foot' },
      h('span', { text: c.sync?.lastIngestAt ? `Gmail synced ${fmtDateLong(c.sync.lastIngestAt)} ${fmtTime(c.sync.lastIngestAt)}` : 'Gmail not synced yet' }),
      c.sync?.mailbox ? h('span', { text: `Inbox: ${c.sync.mailbox}` }) : null,
      h('span', { text: `${fmtInt(c.totalThreads)} tickets stored${c.sync?.backfillDone ? '' : ' · history still loading'}` }),
      h('span', { text: 'Ticket types are matched from the subject and the customer\'s first message.' })))
    return wrap
  }

  function catBars(cats) {
    const max = Math.max(1, ...cats.map((x) => x.count))
    return h('div', { class: 'hbars cat' }, cats.map((x) => {
      const el = h('div', { class: 'hbar' },
        h('span', { class: 'n', text: x.name, title: x.name }),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(x.count / max) * 100}%;background:${x.auto === 'never' ? 'var(--s4)' : SERIES[0]}` })),
        h('span', { class: 'v', text: pctTxt(x.share) }),
        h('span', { class: 'dd' }, ppDelta(x.share, x.priorShare)),
        h('span', { class: 'sp' }, x.spike ? tag('Spike', 'bad') : null))
      el.addEventListener('pointermove', (ev) => showTip(ev.clientX, ev.clientY, x.name, [{ color: x.auto === 'never' ? 'var(--s4)' : SERIES[0], label: 'Tickets', value: fmtInt(x.count) }, { color: 'transparent', label: 'Share now / before', value: `${pctTxt(x.share)} / ${pctTxt(x.priorShare)}` }, { color: 'transparent', label: 'Avg first reply', value: hrsTxt(x.avgFrtHours) }]))
      el.addEventListener('pointerleave', hideTip)
      return el
    }))
  }

  function disputeMini(dp) {
    if (!dp || dp.ratePct == null) return mini('Dispute rate', '–', h('div', { class: 'delta' }, h('span', { class: 'muted', text: 'enter it in Settings' })))
    const room = dp.thresholdPct - dp.ratePct
    const cls = room <= 0 ? 'down' : room <= 0.2 ? 'down' : 'flat'
    return mini('Dispute rate', `${fmt1(dp.ratePct)}%`, h('div', { class: 'delta' }, h('span', { class: cls, text: room <= 0 ? `at the ${fmt1(dp.thresholdPct)}% hold line` : `${fmt1(room)} pts under the ${fmt1(dp.thresholdPct)}% hold` }), dp.at ? h('span', { class: 'muted', text: `as of ${fmtDate(dp.at)}` }) : null))
  }

  function csSetup(c) {
    const isAdmin = state.me?.role === 'admin'
    return h('section', { class: 'section' }, h('div', { class: 'setup' },
      h('h3', { text: 'Connect the support Gmail' }),
      h('p', { text: 'Innaderm support runs on Gmail, so a small Google script inside the support inbox sends ticket timings, subjects and agent names here every 15 minutes. No full emails are stored.' }),
      isAdmin ? h('ol', { style: 'margin:10px 0 0;padding-left:18px;font-size:13px;color:var(--ink-2);display:grid;gap:4px' },
        h('li', null, 'In Vercel, add ', h('code', null, 'INNADERM_CS_INGEST_KEY'), ' (a long random string) and redeploy.'),
        h('li', null, 'Signed in as the support Gmail, open script.google.com → New project, paste ', h('code', null, 'scripts/innaderm-gmail-sync.gs'), ' from the repo, and fill in the key.'),
        h('li', null, 'Run ', h('code', null, 'setup'), ' once and approve the Gmail permission. The last 90 days load within the hour.')) : h('p', { text: 'Ask Khethiwe to finish the Gmail connection.' }),
      h('p', { style: 'margin-top:10px' }, h('a', { href: '?demo=1', text: 'Preview this tab with sample data' }))))
  }

  function demoCs() {
    const days = state.days
    let seed = 11
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280
    const series = []
    for (let i = days - 1; i >= 0; i--) {
      const t = Math.round(24 + rnd() * 14 + (i === Math.min(4, days - 1) ? 22 : 0))
      series.push({ day: new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10), tickets: t, customerMsgs: Math.round(t * 1.6), replies: Math.round(t * 1.5 + rnd() * 6) })
    }
    const tickets = series.reduce((a, r) => a + r.tickets, 0)
    const mix = [['Where is my order', 31, 24, 'high', 'Auto-reply with live tracking from Shopify and the delivery window. Biggest automation win if high.', 9.2],
      ['Subscription', 17, 15, 'high', 'Auto-reply with the Loop self-serve link (pause, skip, swap, cancel) and the retention offer.', 7.4],
      ['Refund / return', 12, 11, 'medium', 'Macro with the 90-day guarantee terms; refund itself stays with a person.', 11.8],
      ['Product question', 10, 12, 'high', 'FAQ auto-reply: how to take it, ingredients, timeline to results, safe with other meds (with a disclaimer).', 6.1],
      ['Not working / results', 8, 9, 'low', 'Retention reply: consistency and the 90-day timeline, then the guarantee. Personal tone.', 14.5],
      ['Cancel order', 7, 8, 'medium', 'Auto-check fulfilment status: unfulfilled = cancel form, shipped = explain and offer return path.', 5.3],
      ['Marked delivered, not received', 5, 6, 'medium', 'Macro asking neighbours/mailbox check, then request proof of delivery from the carrier.', 10.2],
      ['Billing / payment', 4, 5, 'medium', 'Macro explaining the charge with the order lookup; double charges go to a person.', 8.8],
      ['Adverse reaction', 2, 2, 'never', 'Escalate the same day with photos. Personal reply only.', 3.1],
      ['Chargeback / dispute threat', 2, 1, 'never', 'Escalate to the Founder the same day. Never automate.', 2.4],
      ['Other', 2, 7, 'low', 'Read a sample weekly; new patterns become a category.', 12.0]]
    const categories = mix.map(([name, share, prior, auto, play, frt]) => ({ name, count: Math.round((tickets * share) / 100), prior: Math.round((tickets * prior) / 100), share, priorShare: prior, spike: share - prior >= 5 && share >= prior * 1.5, auto, play, avgFrtHours: frt }))
    const subj = [['Where is my order #IN2291?', 'Where is my order', []], ['Charged twice this month', 'Subscription', ['angry']], ['Tracking hasn’t moved in 9 days', 'Where is my order', []], ['Opening a dispute with my bank', 'Chargeback / dispute threat', ['chargeback']], ['Rash after week 2', 'Adverse reaction', ['reaction']], ['How many capsules a day?', 'Product question', []], ['Cancel my subscription please', 'Subscription', []], ['Says delivered but nothing here', 'Marked delivered, not received', []]]
    const oldest = subj.map(([subject, category, flags], i) => ({ id: 'demo' + i, subject, category, flags, customer: ['j****@gmail.com', 'm***@yahoo.com', 'r*****@icloud.com'][i % 3], waitingHours: [52, 37, 30, 26, 19, 9, 4, 1.5][i], followUps: [2, 1, 1, 0, 0, 0, 0, 0][i], link: 'https://mail.google.com' }))
    return {
      connected: true, days, target: 24, timezone: 'Africa/Johannesburg',
      sync: { lastIngestAt: new Date().toISOString(), mailbox: 'support@innaderm.com', backfillDone: true },
      totals: { tickets, ticketsPrior: Math.round(tickets * 0.88), perDay: tickets / days, perDayPrior: (tickets * 0.88) / days, avgFrtHours: 9.4, medFrtHours: 6.2, avgFrtHoursPrior: 12.8, avgResponseHours: 7.1, medResponseHours: 4.9, avgResponseHoursPrior: 8.3, withinTargetPct: 91, withinTargetOk: Math.round(tickets * 0.88), withinTargetJudged: Math.round(tickets * 0.97), withinTargetPctPrior: 84, awaiting: 23, overTarget: 4, replies: Math.round(tickets * 1.5), repliesPrior: Math.round(tickets * 1.32), fcrPct: 58, fcrPctPrior: 54, repeatCustomers: Math.round(tickets * 0.09), uniqueCustomers: Math.round(tickets * 0.86), flagged: 5, flaggedWaiting: 2 },
      series, spikeDays: [{ day: series[Math.max(0, days - 5)].day, tickets: series[Math.max(0, days - 5)].tickets, normal: 30 }],
      categories,
      ageing: { '0-24 hours': 19, '1-7 days': 4, '7-14 days': 0, '14-90 days': 0, '90+ days': 0 }, ageingByCat: {},
      oldest,
      frtBuckets: { 'Under 1 h': Math.round(tickets * 0.18), '1-6 h': Math.round(tickets * 0.31), '6-24 h': Math.round(tickets * 0.39), '24-48 h': Math.round(tickets * 0.07), '48 h +': Math.round(tickets * 0.02), 'No reply yet': Math.round(tickets * 0.03) },
      agents: [{ agent: 'Kashif', replies: Math.round(tickets * 0.9), avgResponseHours: 6.4, medResponseHours: 4.1, firstReplies: Math.round(tickets * 0.6), avgFrtHours: 8.7, withinTargetPct: 92 }, { agent: 'Khethiwe', replies: Math.round(tickets * 0.5), avgResponseHours: 8.2, medResponseHours: 5.6, firstReplies: Math.round(tickets * 0.33), avgFrtHours: 10.9, withinTargetPct: 89 }, { agent: 'Unattributed', replies: Math.round(tickets * 0.1), avgResponseHours: 9.0, medResponseHours: 7.5, firstReplies: Math.round(tickets * 0.04), avgFrtHours: 11.2, withinTargetPct: 85 }],
      byHour: [3, 2, 2, 1, 1, 1, 2, 4, 6, 8, 9, 10, 12, 14, 18, 22, 25, 24, 21, 18, 14, 10, 7, 5].map((v) => Math.round((v * tickets) / 250)),
      risk: oldest.filter((o) => o.flags.length).map((o, i) => ({ ...o, waiting: i < 2, at: new Date(Date.now() - o.waitingHours * 3600e3).toISOString() })),
      dispute: { ratePct: 0.9, thresholdPct: 1, at: '2026-10-12' },
      totalThreads: 2140,
      settings: demoData().settings, settingsMeta: {},
    }
  }

  // ---------- demo data (layout check without secrets: /innaderm?demo=1) ----------
  function demoData() {
    const days = state.days
    let seed = 7
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280
    const series = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10)
      const placed = Math.round(38 + rnd() * 22 + (i < 3 ? 15 : 0))
      series.push({ day: d, placed, units: Math.round(placed * 1.3), fulfilled: Math.round(placed * (0.8 + rnd() * 0.3)), delivered: Math.round(placed * (0.7 + rnd() * 0.4)) })
    }
    return {
      generatedAt: new Date().toISOString(), days,
      integrations: { shopify: { configured: true, store: 'f4f3a5-ad.myshopify.com', sync: { lastRunAt: new Date().toISOString(), backfilled: true, orders: 4812, oldest: new Date(Date.now() - 120 * 86400e3).toISOString() } }, loop: { configured: true }, clickup: { configured: true }, zendrop: { configured: true } },
      fulfilment: {
        days, period: { orders: 412, units: 536, revenue: 24870, renewals: 131, newSubs: 64, fulfilledOfCreated: 371 }, prior: { orders: 358, units: 462 },
        inTransit: { count: 287, buckets: { '0-3 days': 96, '4-7 days': 112, '8-14 days': 61, '15+ days': 18 }, carriers: { 'USPS': 141, 'YunExpress': 88, 'UPS': 40, 'Unknown': 18 }, oldest: [{ name: '#IN2041', days: 23, status: 'IN_TRANSIT', carrier: 'YunExpress', tracking: 'YT25…', country: 'US' }, { name: '#IN2106', days: 19, status: 'IN_TRANSIT', carrier: 'USPS', country: 'US' }, { name: '#IN2133', days: 17, status: 'ATTEMPTED_DELIVERY', carrier: 'USPS', country: 'CA' }] },
        unfulfilled: { count: 54, units: 71, buckets: { '0-3 days': 41, '4-7 days': 9, '8-14 days': 3, '15+ days': 1 }, oldest: [{ name: '#IN2310', days: 16, status: 'UNFULFILLED', units: 2, financial: 'PAID' }, { name: '#IN2388', days: 9, status: 'ON_HOLD', units: 1, financial: 'PAID' }] },
        delivered: { count: 338, prior: 301 }, avgFulfilHours: 31.4, medFulfilHours: 26, priorAvgFulfilHours: 36.9, avgDeliveryDays: 8.7, medDeliveryDays: 8, priorAvgDeliveryDays: 9.4, avgDoorDays: 10.1, series,
      },
      runRate: { baselineDays: 14, newUnitsPerDay: 41.2, priorNewUnitsPerDay: 33.5, newOrdersPerDay: 31.8, unitsPerNewOrder: 1.3 },
      renewals: { subscriptions: 1180, units: 1294, weeks: [310, 335, 298, 301, 50], source: 'loop' },
      inventory: { finished: { units: 2140, source: 'shopify', countedAt: new Date().toISOString(), variants: [{ id: '1', title: 'Gut Skin Support · 60 caps', sku: 'GSS-60', onHand: 1710, tracked: true }, { id: '2', title: 'Gut Skin Support · 3-pack', sku: 'GSS-180', onHand: 430, tracked: true }] }, packaging: { units: 3600, countedAt: new Date(Date.now() - 2 * 86400e3).toISOString() } },
      ops: {
        zendrop: { sheetId: '1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY', tabs: [{ name: 'Fulfillment Issues', gid: '1279079658', open: 23, raised7: 9, resolved7: 12, oldestDays: 31, byTopic: { 'Stuck In Transit': 9, 'Unfulfilled': 7, 'Cancellation': 4, 'HOLD': 3 }, rowsInnaderm: 40, skippedSerentia: 0, openRows: [{ order: '#IN70312', topic: 'Stuck In Transit', ageDays: 31 }, { order: '#IN71044', topic: 'Unfulfilled', ageDays: 12 }] }, { name: 'Zendrop Order Issues', gid: '124374285', open: 11, raised7: 4, resolved7: 6, oldestDays: 19, byTopic: { 'Incomplete Shipping Address': 8, 'Customer Phone Number Needed': 3 }, rowsInnaderm: 17, skippedSerentia: 0, openRows: [{ order: '#IN70980', topic: 'Incomplete Shipping Address', ageDays: 19 }] }] },
        clickup: { lists: [{ id: '901222538715', name: 'Founder Escalations', total: 6, overdue: 2, unassigned: 1, byStatus: { 'to do': 4, 'in progress': 2 }, tasks: [{ id: 'a', name: 'Chargeback #IN1988 – evidence pack', status: 'in progress', url: 'https://app.clickup.com', due: new Date(Date.now() - 86400e3).toISOString(), overdue: true, assignees: ['Khethiwe'] }, { id: 'b', name: 'Pre-order button test on Serentia', status: 'to do', url: 'https://app.clickup.com', due: new Date(Date.now() + 3 * 86400e3).toISOString(), overdue: false, assignees: [] }] }, { id: '901216052461', name: 'Ops Overview', total: 14, overdue: 3, unassigned: 2, byStatus: { 'to do': 9, 'in progress': 5 }, tasks: [{ id: 'c', name: 'Weekly Zendrop reconciliation', status: 'to do', url: 'https://app.clickup.com', due: new Date(Date.now() + 86400e3).toISOString(), overdue: false, assignees: ['Khethiwe'] }] }] },
      },
      settings: { finished_source: 'shopify', finished_on_hand: null, packaging_on_hand: 3600, lead_finished_with_packaging: 10, lead_finished_without_packaging: 22, lead_packaging: 14, moq_finished: 2500, moq_packaging: 5000, unit_cost_finished: 4.1, unit_cost_packaging: 0.35, baseline_days: 14, scale_pct: 20, scale_days_default: 3, safety_days: 7, packaging_per_unit: 1, tracked_variant_ids: [], clickup_lists: [{ id: '901222538715', name: 'Founder Escalations' }, { id: '901216052461', name: 'Ops Overview' }], zendrop_sheet_id: '1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY' },
      settingsMeta: {},
      viewer: { name: 'Demo viewer', role: 'admin' },
    }
  }

  boot()
})()
