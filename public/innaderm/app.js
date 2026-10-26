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
    view: ['ops', 'cs', 'board', 'matrix'].includes(params.get('tab')) ? params.get('tab') : ['cs', 'board', 'matrix'].includes(safeGet(LS_VIEW)) ? safeGet(LS_VIEW) : 'ops',
    board: null,
    boardLoading: false,
    boardError: null,
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
    if (DEMO) { state.me = { name: 'Demo viewer', role: 'admin' }; state.data = demoData(); state.cs = demoCs(); state.board = demoBoard(); render(); return }
    if (state.token || document.cookie.includes('inn_session')) {
      try { state.me = await api('/auth/me') } catch { state.me = null }
    }
    render()
    if (state.me) load()
  }

  async function load() {
    if (state.view === 'cs') return loadCs()
    if (state.view === 'board') return loadBoard()
    if (state.view === 'matrix') return render()
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
    app.append(topBar(), state.view === 'cs' ? csView() : state.view === 'board' ? boardView() : state.view === 'matrix' ? matrixView() : mainView(), drawer())
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
    if (state.view === 'board' && !DEMO) {
      const at = state.board?.sync?.lastIngestAt
      sync = at ? h('span', { class: 'pill', title: 'Click to refresh', onclick: () => loadBoard(), style: 'cursor:pointer' }, h('i', { class: 'dot' }), `Gmail ${fmtTime(at)}`) : h('span', { class: 'pill' + (state.boardLoading ? ' busy' : ' bad') }, h('i', { class: 'dot' }), state.boardLoading ? 'Loading…' : 'Gmail not synced')
    }
    const setView = (v) => { if (state.view === v) return; state.view = v; safeSet(LS_VIEW, v); render(); if (v === 'matrix') return; if (v === 'cs' ? !state.cs : v === 'board' ? !state.board : !state.data) load(); else render() }
    const tabs = h('div', { class: 'seg tabs', role: 'tablist', 'aria-label': 'Dashboard' }, [['ops', 'Operations'], ['cs', 'CS metrics'], ['board', 'Support board'], ['matrix', 'Refund matrix']].map(([v, l]) => h('button', { role: 'tab', 'aria-selected': String(state.view === v), 'aria-pressed': String(state.view === v), text: l, onclick: () => setView(v) })))
    return h('header', { class: 'top' }, h('div', { class: 'top-in' },
      h('div', { class: 'brand' }, h('div', { class: 'mark', text: 'IN' }), h('div', null, h('span', { class: 'name', text: 'Innaderm' }), h('span', { class: 'sub', text: ' Ops' }))),
      tabs,
      state.view === 'board' || state.view === 'matrix' ? null : h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, PERIODS.map((p) => h('button', { 'aria-pressed': String(p === state.days), text: `${p}d`, onclick: () => { state.days = p; safeSet(LS_DAYS, String(p)); if (state.view === 'cs') state.data = null; else state.cs = null; load() } }))),
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
    const inb = inboundSummary(d.settings)
    const pendNote = (n, what) => (n ? `+${fmtInt(n)} ${what} on the way, not counted until ${what === 'units' ? 'they show in Shopify' : 'counted at the factory'}` : null)
    grid.append(stockCard('Packaging', dec.packaging, dec.packaging == null ? null : dec.packaging / (dec.perUnit || 1), need30, d.inventory.packaging.countedAt, 'manual count', dec.coverP, d.settings.lead_packaging, [dec.perUnit !== 1 ? `${dec.perUnit} per finished unit` : null, pendNote(inb.packaging, 'bags')].filter(Boolean).join(' · ') || null))
    grid.append(stockCard('Finished goods', dec.finishedRaw, dec.finished, need30, d.inventory.finished.countedAt, d.inventory.finished.source === 'shopify' ? 'Shopify inventory' : 'manual count', dec.coverF, dec.leadF, [dec.backlog ? `${fmtInt(dec.backlog)} units already owed to unfulfilled orders are subtracted` : null, pendNote(inb.finished, 'units')].filter(Boolean).join(' · ') || null))
    const vars = d.inventory.finished.variants || []
    const tracked = vars.filter((v) => v.tracked)
    grid.append(h('div', { class: 'card c4' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'By variant (Shopify)' }), h('div', { class: 'hint', text: tracked.length ? `${tracked.length} tracked variant${tracked.length === 1 ? '' : 's'}` : 'No tracked variants returned' }))),
      tracked.length ? h('div', { style: 'max-height:230px;overflow:auto' }, tableView(['Variant', 'On hand'], tracked.sort((a, b) => b.onHand - a.onHand).map((v) => [v.title || v.sku || v.id, fmtInt(v.onHand)]))) : h('p', { class: 'muted', text: d.integrations.shopify.configured ? 'Turn on inventory tracking for the product in Shopify, or switch finished goods to a manual count in Settings.' : 'Connect Shopify to list variants.' })))
    if (inb.pending.length) grid.append(inboundCard(d, inb))
    sec.append(grid)
    return sec
  }

  // Stock on its way. Pending until it shows in Shopify; never part of on-hand or cover.
  const INBOUND_LABEL = { ordered: 'Ordered', waiting_packaging: 'Waiting for packaging', in_transit: 'In transit', received: 'Received' }
  function inboundSummary(S) {
    const list = Array.isArray(S.inbound_stock) ? S.inbound_stock : []
    const pending = list.filter((x) => x.status !== 'received')
    const sum = (item) => pending.filter((x) => x.item === item).reduce((a, x) => a + (x.units || 0), 0)
    return { list, pending, finished: sum('finished'), packaging: sum('packaging') }
  }
  function inboundCard(d, inb) {
    const today = new Date().toISOString().slice(0, 10)
    return h('div', { class: 'card c12' },
      h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Inbound stock: pending until it shows in Shopify' }),
        h('div', { class: 'hint', text: `${fmtInt(inb.finished)} finished units and ${fmtInt(inb.packaging)} bags on the way. Not counted in stock on hand, days of cover or the scale decision until marked received in Settings.` }))),
      h('div', { style: 'overflow:auto' }, h('table', { class: 'dtable' },
        h('thead', null, h('tr', null, ['What', 'Units', 'Status', 'Going to', 'Expected', 'Note'].map((x) => h('th', { text: x })))),
        h('tbody', null, inb.pending.map((x) => {
          const late = x.eta && x.eta < today
          return h('tr', null,
            h('td', null, h('b', { text: x.item === 'packaging' ? 'Packaging (bags)' : 'Finished goods' })),
            h('td', { text: fmtInt(x.units) }),
            h('td', null, h('span', { class: `status ${x.status === 'in_transit' ? 'good' : x.status === 'waiting_packaging' ? 'warn' : 'na'}`, text: INBOUND_LABEL[x.status] || x.status }), ' ', h('span', { class: 'status warn', text: 'Pending' })),
            h('td', { text: x.to || '–' }),
            h('td', null, x.eta ? fmtDateLong(x.eta + 'T12:00:00Z') : '–', x.eta_text ? h('div', { class: 'logic', text: x.eta_text }) : null, late ? h('div', { class: 'logic', style: 'color:var(--bad)', text: 'Past the expected date: check Shopify and mark received in Settings.' }) : null),
            h('td', { class: 'logic' }, x.note || '', x.source ? h('div', { text: 'Source: ' + x.source }) : null))
        })))))
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
    const inbS = inboundSummary(S)
    if (inbS.finished) sug.push({ cls: 'warn', ic: 'I', t: `${fmtInt(inbS.finished)} finished units are already on the way (not in Shopify yet).`, s: 'The suggestions below do not count them. Check the inbound list before placing another order.' })
    if (inbS.packaging) sug.push({ cls: '', ic: 'I', t: `${fmtInt(inbS.packaging)} bags are on the way to the capsule factory.`, s: 'Not counted in packaging on hand until they arrive and are counted.' })
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
      const skipped = zd.tabs.reduce((n, t) => n + (t.skippedOther || 0), 0)
      grid.append(h('div', { class: 'card c4 setup' }, h('h3', { text: 'Zendrop issues' }), h('p', { text: `No Innaderm (#INN) orders in this Zendrop sheet${skipped ? `: ${fmtInt(skipped)} rows from other stores are hidden` : ''}. If Innaderm has its own Zendrop sheet, paste its id in Settings → Sources and open issues show here.` })))
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
  function openDrawer() { state.drawer = true; state.newKey = null; if (!DEMO && !state.data && !state.cs && !state.boardSettings) api('/settings').then((r) => { state.boardSettings = r.settings; state.boardMeta = r.meta; render() }).catch(() => {}); if (DEMO && !state.data) state.data = demoData(); render(); if (!DEMO) api('/keys').then((r) => { state.keys = r.keys; render() }).catch(() => {}) }
  function closeDrawer() { state.drawer = false; state.inboundEdit = null; render() }
  // Inbound stock editor: status, units, ETA; "received" once it shows in Shopify.
  function inboundEditor(S) {
    const list = (state.inboundEdit ||= JSON.parse(JSON.stringify(Array.isArray(S.inbound_stock) ? S.inbound_stock : [])))
    const msg = h('span', { class: 'msg' })
    const save = async () => {
      msg.textContent = 'Saving…'
      try {
        if (DEMO) { S.inbound_stock = JSON.parse(JSON.stringify(list)); msg.textContent = 'Saved (demo)'; render(); return }
        const r = await api('/settings', { method: 'PUT', body: { inbound_stock: list } })
        msg.textContent = r.errors?.length ? r.errors.join('; ') : 'Saved'
        state.inboundEdit = null; state.data = null; state.boardSettings = null
        await load(); state.drawer = true; render()
      } catch (e) { msg.textContent = e.message }
    }
    const row = (x, i) => h('div', { class: 'inrow' },
      h('select', { onchange: (e) => { x.item = e.target.value } }, [['finished', 'Finished goods'], ['packaging', 'Packaging']].map(([v, l]) => h('option', { value: v, selected: x.item === v, text: l }))),
      h('input', { type: 'number', min: 0, value: x.units, 'aria-label': 'Units', onchange: (e) => { x.units = Number(e.target.value) } }),
      h('select', { onchange: (e) => { x.status = e.target.value } }, Object.entries(INBOUND_LABEL).map(([v, l]) => h('option', { value: v, selected: x.status === v, text: v === 'received' ? 'Received (shows in Shopify)' : l }))),
      h('input', { type: 'date', value: x.eta || '', 'aria-label': 'Expected', onchange: (e) => { x.eta = e.target.value || null } }),
      h('input', { type: 'text', value: x.note || '', placeholder: 'note', onchange: (e) => { x.note = e.target.value } }),
      h('button', { class: 'tbtn', text: 'Remove', onclick: () => { list.splice(i, 1); render() } }))
    return h('div', null,
      h('h3', { text: 'Inbound stock (pending until it shows in Shopify)' }),
      h('div', { class: 'inlist' }, list.filter((x) => x.status !== 'received').map((x) => row(x, list.indexOf(x)))),
      list.some((x) => x.status === 'received') ? h('details', { style: 'font-size:12px;margin-top:6px' }, h('summary', { text: `${list.filter((x) => x.status === 'received').length} received` }), list.filter((x) => x.status === 'received').map((x) => row(x, list.indexOf(x)))) : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost sm', text: 'Add inbound', onclick: () => { list.push({ id: 'in-' + Date.now(), item: 'finished', units: 0, status: 'ordered', to: 'Zendrop', eta: null, note: '' }); render() } }), h('button', { class: 'btn sm', text: 'Save inbound', onclick: save }), msg))
  }
  function drawer() {
    if (!state.drawer || state.me.role !== 'admin') return h('div')
    const S = state.data?.settings || state.cs?.settings || state.boardSettings || {}
    const meta = state.data?.settingsMeta || state.cs?.settingsMeta || state.boardMeta || {}
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
        if (state.view === 'cs') { state.data = null; await loadCs() } else if (state.view === 'board') { const r = await api('/settings'); state.boardSettings = r.settings; state.boardMeta = r.meta; await loadBoard(true) } else { state.cs = null; await load() }
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
      inboundEditor(S),
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
      h('h3', { text: 'Support board' }),
      h('div', { class: 'form' },
        F('cs_ship_eta_text', 'Ship date for unshipped orders', 'e.g. Friday 31 October. Blank = drafts ask the agent to confirm with Calvin', 'text'),
        F('cs_discount_code', 'Discount code in replies', 'handover: WELCOME15', 'text'),
        F('cs_minutes_per_ticket', 'Minutes per ticket', 'used for hours-saved estimates'),
        F('cs_autodraft_signature', 'Auto-draft sign-off', 'name on drafts the system writes', 'text')),
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
  // Customer address; when the full address is known it opens all their mail.
  function customerEl(t) {
    if (!t.customer) return null
    return t.customerLink ? h('a', { class: 'cust', href: t.customerLink, target: '_blank', rel: 'noopener', title: 'All emails from this customer', text: t.customer }) : t.customer
  }
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
    bg.append(h('div', { class: 'card c8' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Oldest waiting' }), h('div', { class: 'hint', text: 'Answer these first. The subject opens the thread in Gmail; the address opens every email from that customer.' }))),
      c.oldest.length ? h('div', { class: 'list', style: 'max-height:340px;overflow:auto' }, c.oldest.map((t) => h('div', { class: 'it' },
        h('span', null, h('a', { href: t.link, target: '_blank', rel: 'noopener', text: t.subject }), ' ', h('span', { class: 'm' }, t.category, t.customer ? ' · ' : null, customerEl(t), t.followUps ? ` · ${t.followUps} follow-up${t.followUps > 1 ? 's' : ''}` : null), ' ', (t.flags || []).map((f) => tag(FLAG_LABEL[f] || f, 'bad'))),
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
      h('span', null, h('a', { href: r.link, target: '_blank', rel: 'noopener', text: r.subject }), ' ', h('span', { class: 'm' }, r.category, r.customer ? ' · ' : null, customerEl(r), ` · ${fmtDate(r.at)}`), ' ', r.flags.map((f) => tag(FLAG_LABEL[f] || f, 'bad'))),
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

  // ---------- Support board (work the Innaderm inbox, like the Serentia board) ----------
  const LS_SIGNER = 'innaderm.signer'
  const QUEUES = [
    ['reply', 'Needs reply', (t) => t.needsReply && t.status !== 'With Calvin'],
    ['back', 'They replied', (t) => t.needsReply && (t.reopened || (t.msgsOut > 0 && t.statusSet))],
    ['calvin', 'With Calvin', (t) => t.status === 'With Calvin'],
    ['drafted', 'Drafted', (t) => t.status === 'Drafted'],
    ['waiting', 'Waiting on customer', (t) => !t.needsReply && ['Replied', 'Waiting on customer', 'With Zendrop'].includes(t.status)],
    ['open', 'All open', (t) => t.needsReply || !['Done', 'Skip'].includes(t.status)],
    ['done', 'Done', (t) => ['Done', 'Skip'].includes(t.status) && !t.reopened],
  ]
  const STATUS_CLS = { New: '', Drafted: 'warn', Replied: 'good', 'Waiting on customer': '', 'With Calvin': 'bad', 'With Zendrop': 'warn', Done: 'good', Skip: '' }
  const PLACEHOLDER_RE = /\[[A-Z][A-Z0-9 ,.:;'’()/&+-]{2,}\]/g

  function signer() {
    const saved = safeGet(LS_SIGNER)
    if (saved) return saved
    const n = String(state.me?.name || '').replace(/\(.*\)/, '').trim()
    return /^admin$/i.test(n) ? '' : n.split(/\s+/)[0] || ''
  }
  const fillTpl = (body, vars) => String(body).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null && vars[k] !== '' ? vars[k] : m))

  async function loadBoard(quiet) {
    if (DEMO) { state.board = demoBoard(); render(); return }
    if (!quiet) { state.boardLoading = true; state.boardError = null; render() }
    try { state.board = await api('/cs/board') } catch (e) { state.boardError = e.message }
    state.boardLoading = false; render()
  }
  // Refresh in the background unless someone is mid-edit.
  setInterval(() => {
    if (state.view !== 'board' || !state.me || document.hidden || DEMO) return
    const a = document.activeElement
    if (a && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName)) return
    loadBoard(true)
  }, 120e3)

  async function saveTicket(t, patch) {
    Object.assign(t, patch.status ? { status: patch.status, statusSet: true, reopened: false, needsReply: ['Done', 'Skip', 'Replied', 'Waiting on customer'].includes(patch.status) ? false : t.needsReply } : {}, patch.note !== undefined ? { note: patch.note } : {}, patch.category ? { category: patch.category } : {})
    render()
    if (DEMO) return
    try { await api('/cs/board', { method: 'POST', body: { id: t.id, ...patch } }) } catch (e) { alert('Not saved: ' + e.message); loadBoard(true) }
  }

  function boardView() {
    const wrap = h('div', { class: 'wrap board' + (state.boardLoading && state.board ? ' fade' : '') })
    if (state.boardError) wrap.append(h('div', { class: 'banner bad' }, `Could not load: ${state.boardError}`, h('button', { class: 'btn sm ghost', text: 'Retry', onclick: () => loadBoard() })))
    const b = state.board
    if (!b) { if (!state.boardError) wrap.append(h('div', { class: 'banner info', text: 'Loading the support board…' })); return wrap }
    const sub = state.boardSub || 'tickets'
    wrap.append(h('div', { class: 'board-head' },
      h('div', { class: 'seg', role: 'tablist' }, [['tickets', 'Tickets'], ['auto', 'Automations'], ['templates', 'Templates']].map(([k, l]) => h('button', { 'aria-pressed': String(sub === k), text: l, onclick: () => { state.boardSub = k; render() } }))),
      h('label', { class: 'signer' }, 'Signing as ', h('input', { value: signer(), placeholder: 'your name', 'aria-label': 'Your sign-off name', onchange: (e) => { safeSet(LS_SIGNER, e.target.value.trim() || null); render() } }))))
    if (!b.sync?.lastIngestAt && !DEMO) wrap.append(h('div', { class: 'banner bad', text: 'No Gmail data yet. Check the Apps Script in the support inbox is running.' }))
    if (b.sync?.lastIngestAt && !b.draftScript && !DEMO) wrap.append(h('div', { class: 'banner', text: 'The Gmail script has not picked up drafts yet. Paste the updated script into script.google.com and run "upgrade" once, then "Put in Gmail" works.' }))
    if (sub === 'auto') wrap.append(automationView(b))
    else if (sub === 'templates') wrap.append(templatesView(b))
    else wrap.append(ticketsView(b))
    return wrap
  }

  function ticketsView(b) {
    const qKey = state.boardQueue || 'reply'
    const counts = Object.fromEntries(QUEUES.map(([k, , f]) => [k, b.tickets.filter(f).length]))
    const calvinNew = b.tickets.filter((t) => t.status === 'With Calvin' && t.clickup?.calvinReplied).length
    const frag = h('div')
    frag.append(h('div', { class: 'queues' }, QUEUES.map(([k, l]) => h('button', { class: 'q' + (k === qKey ? ' on' : ''), onclick: () => { state.boardQueue = k; state.openTicket = null; render() } },
      l, h('b', { text: fmtInt(counts[k]) }), k === 'calvin' && calvinNew ? h('span', { class: 'tag good', text: `${calvinNew} answered` }) : null)),
      h('input', { class: 'search', type: 'search', placeholder: 'Search name, email, subject, #INN…', value: state.boardSearch || '', oninput: (e) => { state.boardSearch = e.target.value; clearTimeout(state._st); state._st = setTimeout(() => { render(); const el = $('.board .search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }, 250) } })))
    const f = QUEUES.find(([k]) => k === qKey)[2]
    const needle = (state.boardSearch || '').trim().toLowerCase()
    let list = b.tickets.filter(f)
    if (needle) list = b.tickets.filter((t) => [t.customerName, t.customerEmail, t.subject, t.lastExcerpt, ...(t.orderNumbers || []), ...(t.orders || []).map((o) => o.name)].join(' ').toLowerCase().includes(needle))
    // Risky first, then the longest-waiting.
    const risk = (t) => (t.flags.some((x) => x === 'chargeback' || x === 'legal' || x === 'reaction') ? 1 : 0)
    list.sort((a, c) => (risk(c) - risk(a)) || (new Date(a.lastIn) - new Date(c.lastIn)))
    if (!list.length) { frag.append(h('div', { class: 'card empty', text: needle ? 'Nothing matches that search.' : qKey === 'reply' ? 'Inbox zero. Nobody is waiting on us.' : 'Nothing here.' })); return frag }
    const groups = new Map()
    for (const t of list) { if (!groups.has(t.category)) groups.set(t.category, []); groups.get(t.category).push(t) }
    const stageOf = Object.fromEntries((b.automation || []).map((a) => [a.category, a]))
    // Groups holding a dispute, legal or reaction ticket first, then the biggest.
    const ordered = [...groups.entries()].sort((a, c) => (Math.max(...c[1].map(risk)) - Math.max(...a[1].map(risk))) || (c[1].length - a[1].length))
    for (const [cat, items] of ordered) {
      const st = stageOf[cat]
      const stage = b.stages.find((s) => s.key === st?.stage)
      frag.append(h('section', { class: 'tgroup' },
        h('div', { class: 'tg-head' }, h('h3', { text: cat }), h('span', { class: 'n', text: fmtInt(items.length) }), stage && stage.key !== 'manual' ? tag(stage.label, 'good') : null),
        h('div', { class: 'tlist' }, items.map((t) => ticketRow(t, b)))))
    }
    return frag
  }

  function slaChip(t) {
    if (t.waitingHours == null) return h('span', { class: 'sla ok', text: t.lastOut ? 'replied ' + agoTxt(t.lastOut) : '' })
    const hrs = t.waitingHours
    const urgent = t.flags.some((x) => x === 'chargeback' || x === 'legal' || x === 'reaction') || t.vip
    const cls = hrs > 24 || (urgent && hrs > 4) ? 'bad' : hrs > 6 || (urgent && hrs > 2) ? 'warn' : 'ok'
    return h('span', { class: 'sla ' + cls, title: 'Time since the customer last wrote', text: hrsTxt(hrs) })
  }
  const agoTxt = (d) => { const hrs = (Date.now() - new Date(d)) / 3600e3; return hrs < 1 ? Math.max(1, Math.round(hrs * 60)) + 'm ago' : hrs < 48 ? Math.round(hrs) + 'h ago' : Math.round(hrs / 24) + 'd ago' }

  function ticketRow(t, b) {
    const open = state.openTicket === t.id
    const lastDraft = t.drafts[0]
    const row = h('div', { class: 'trow' + (open ? ' open' : '') + (t.reopened ? ' back' : '') })
    row.append(h('button', { class: 'tsum', 'aria-expanded': String(open), onclick: () => { state.openTicket = open ? null : t.id; render() } },
      slaChip(t),
      h('span', { class: 'who' }, h('b', { text: t.customerName || t.customerEmail || 'Unknown' }), t.vip ? tag('VIP', 'warn') : null),
      h('span', { class: 'subj', text: t.subject }),
      h('span', { class: 'tags' },
        t.reopened ? tag('Replied again', 'bad') : null,
        t.flags.map((x) => tag(FLAG_LABEL[x] || x, 'bad')),
        t.orders?.[0] ? tag(t.orders[0].name) : null,
        lastDraft && lastDraft.status === 'pending' ? tag('Draft → Gmail…', 'warn') : lastDraft && lastDraft.status === 'created' && new Date(lastDraft.at) >= new Date(t.lastIn) ? tag(lastDraft.source === 'auto' ? 'Auto-draft in Gmail' : 'Draft in Gmail', 'good') : null,
        t.clickup ? tag(t.clickup.calvinReplied ? 'Calvin answered' : 'With Calvin', t.clickup.calvinReplied ? 'good' : 'bad') : null),
      h('span', { class: 'st tag ' + (STATUS_CLS[t.status] || ''), text: t.status })))
    if (open) row.append(ticketDetail(t, b))
    return row
  }

  function ticketDetail(t, b) {
    const box = h('div', { class: 'tdetail' })
    // Left: what the customer said and who they are
    const left = h('div', { class: 'tleft' })
    left.append(h('div', { class: 'meta' },
      h('a', { href: t.link, target: '_blank', rel: 'noopener', class: 'btn sm ghost', text: 'Open thread in Gmail' }),
      t.customerLink ? h('a', { href: t.customerLink, target: '_blank', rel: 'noopener', class: 'btn sm ghost', text: 'All their emails' }) : null,
      h('span', { class: 'muted', text: `${t.customerEmail || ''} · first wrote ${fmtDate(t.firstIn)} · ${t.msgsIn} from them, ${t.msgsOut} from us` })))
    left.append(h('div', { class: 'msg' }, h('div', { class: 'lbl', text: `Their latest message · ${agoTxt(t.lastIn)}` }), h('p', { text: t.lastExcerpt || t.excerpt || '(message text arrives with the updated Gmail script)' })))
    if (t.excerpt && t.lastExcerpt && !t.lastExcerpt.startsWith(t.excerpt.slice(0, 60))) left.append(h('details', { class: 'msg first' }, h('summary', { text: 'First message' }), h('p', { text: t.excerpt })))
    left.append(h('div', { class: 'lbl', style: 'margin-top:12px', text: t.orders?.length ? `Orders${t.spent ? ` · $${Math.round(t.spent)} spent` : ''}${t.vip ? ' · VIP (2+ orders or $100+)' : ''}` : 'Orders' }))
    left.append(t.orders?.length ? h('div', { style: 'overflow:auto' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['Order', 'Placed', 'Payment', 'Fulfilment', 'Tracking', 'Total'].map((x, i) => h('th', { class: i > 4 ? 'num' : '', text: x })))),
      h('tbody', null, t.orders.map((o) => h('tr', null,
        h('td', null, h('b', { text: o.name }), o.subscription ? ' ' : null, o.subscription ? tag('Sub') : null),
        h('td', { text: fmtDate(o.createdAt) }),
        h('td', { text: o.cancelledAt ? 'Cancelled' : (o.financial || '').replace(/_/g, ' ').toLowerCase() }),
        h('td', { text: o.deliveredAt ? `Delivered ${fmtDate(o.deliveredAt)}` : o.fulfilledAt ? `Shipped ${fmtDate(o.fulfilledAt)}` : (o.status || 'unfulfilled').replace(/_/g, ' ').toLowerCase() }),
        h('td', null, o.trackingNumber ? h('a', { href: o.trackingUrl || `https://t.17track.net/en#nums=${encodeURIComponent(o.trackingNumber)}`, target: '_blank', rel: 'noopener', text: `${o.carrier ? o.carrier + ' ' : ''}${o.trackingNumber}` }) : '–'),
        h('td', { class: 'num', text: '$' + o.total.toFixed(2) })))))) : h('p', { class: 'muted', style: 'margin:4px 0', text: b.shopifyReady ? 'No order found for this email or order number. Ask for their #INN number.' : 'Shopify not connected yet: order details appear once the Shopify keys are in.' }))
    // Working state
    left.append(h('div', { class: 'work' },
      h('label', null, 'Status ', h('select', { onchange: (e) => saveTicket(t, { status: e.target.value }) }, b.statuses.map((s) => h('option', { value: s, selected: s === t.status, text: s })))),
      h('label', null, 'Type ', h('select', { onchange: (e) => saveTicket(t, { category: e.target.value === t.autoCategory ? '' : e.target.value }) }, Object.keys(b.defaults).map((c) => h('option', { value: c, selected: c === t.category, text: c })))),
      h('textarea', { class: 'note', rows: 2, placeholder: 'Internal note (not sent to the customer)', onchange: (e) => saveTicket(t, { note: e.target.value }) }, t.note || '')))
    if (t.statusBy) left.append(h('div', { class: 'muted', style: 'font-size:11.5px;margin-top:4px', text: `Last change by ${t.statusBy} ${agoTxt(t.statusAt)}` }))
    const ra = window.InnRefund ? window.InnRefund.assess(t) : null
    if (ra) left.append(refundBox(t, ra))
    left.append(calvinBox(t, b, ra))
    box.append(left, composer(t, b, ra))
    return box
  }

  function composer(t, b, ra) {
    state.compose = state.compose || {}
    const c = state.compose[t.id] || (state.compose[t.id] = { template: b.defaults[t.category] || 'general', text: null })
    const tpl = b.templates.find((x) => x.key === c.template) || b.templates[0]
    const me = signer()
    const vars = { ...t.vars, agent: me || '[YOUR NAME]' }
    if (c.text == null) c.text = fillTpl(tpl?.body || '', vars)
    const ta = h('textarea', { class: 'reply', rows: 14, spellcheck: 'true', oninput: (e) => { c.text = e.target.value; warn() } }, c.text)
    const warnBox = h('div', { class: 'warns' })
    const send = h('button', { class: 'btn', text: 'Put in Gmail as draft' })
    const msg = h('span', { class: 'msg' })
    function warn() {
      const ph = [...new Set(c.text.match(PLACEHOLDER_RE) || [])]
      const br = [...new Set(c.text.match(/\{\w+\}/g) || [])]
      warnBox.replaceChildren(...[...ph, ...br].map((p) => tag('Replace ' + p, 'bad')))
      send.disabled = !!(ph.length || br.length) || !c.text.trim()
    }
    warn()
    send.onclick = async () => {
      send.disabled = true; msg.textContent = 'Queuing…'
      try {
        if (!DEMO) await api('/cs/board/draft', { method: 'POST', body: { id: t.id, body: c.text, template: c.template, category: t.category } })
        t.drafts.unshift({ status: 'pending', source: 'agent', at: new Date().toISOString(), by: state.me.name })
        t.status = 'Drafted'; t.statusSet = true
        msg.textContent = 'Queued. It appears as a draft in the Gmail thread within 5 minutes; check it there and press Send.'
        setTimeout(render, 2500)
      } catch (e) { msg.textContent = e.message; send.disabled = false }
    }
    const copy = h('button', { class: 'btn ghost', text: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(c.text); msg.textContent = 'Copied.' } catch { ta.select(); msg.textContent = 'Press Ctrl+C to copy.' } } })
    const pick = h('select', { 'aria-label': 'Template', onchange: (e) => { c.template = e.target.value; c.text = null; render() } },
      b.templates.map((x) => h('option', { value: x.key, selected: x.key === c.template, text: `${x.title}${x.approved ? '' : ' (not approved)'}` })))
    const reset = h('button', { class: 'tbtn', text: 'Reset', title: 'Refill from the template', onclick: () => { c.text = null; render() } })
    const useMatrix = ra && ra.reply ? h('button', { class: 'tbtn', text: `Use ${ra.row} reply`, title: 'Fill in the refund-matrix reply for this ticket', onclick: () => { c.text = ra.reply.replace(/\{agent\}/g, me || '[YOUR NAME]'); render() } }) : null
    const box = h('div', { class: 'tright' },
      h('div', { class: 'lbl' }, 'Reply ', pick, ' ', reset, useMatrix ? ' ' : null, useMatrix),
      tpl?.checklist ? h('div', { class: 'check' }, h('b', { text: 'Before sending: ' }), tpl.checklist) : null,
      !me ? h('div', { class: 'banner', style: 'margin:6px 0', text: 'Set your sign-off name in "Signing as" above.' }) : null,
      ta, warnBox,
      h('div', { class: 'actions' }, send, copy, msg))
    const drafts = t.drafts.slice(0, 3)
    if (drafts.length) box.append(h('div', { class: 'muted', style: 'font-size:11.5px;margin-top:6px' }, drafts.map((d) => h('div', { text: `${d.source === 'auto' ? 'Auto-draft' : 'Draft by ' + (d.by || '?')} ${agoTxt(d.at)}: ${d.status === 'created' ? 'in Gmail' : d.status === 'pending' ? 'waiting for the Gmail script' : d.status}${d.error ? ' (' + d.error + ')' : ''}` }))))
    return box
  }

  function calvinBox(t, b, ra) {
    const box = h('div', { class: 'calvin' })
    if (t.clickup) {
      box.append(h('div', { class: 'lbl' }, 'With Calvin in ClickUp ', h('a', { href: t.clickup.url, target: '_blank', rel: 'noopener', text: 'Open task' }), t.clickup.status ? ` · ${t.clickup.status}` : ''))
      if (t.clickup.error) box.append(h('p', { class: 'muted', text: 'Could not read the task: ' + t.clickup.error }))
      for (const cm of t.clickup.comments || []) box.append(h('div', { class: 'cmt' + (cm.fromCalvin ? ' calvin' : '') }, h('b', { text: cm.by + ' ' }), h('span', { class: 'muted', text: agoTxt(cm.at) }), h('p', { text: cm.text })))
      if (!(t.clickup.comments || []).length) box.append(h('p', { class: 'muted', style: 'margin:4px 0', text: 'No reply from Calvin yet.' }))
      return box
    }
    if (!state.escalating || state.escalating !== t.id) {
      box.append(h('button', { class: 'btn ghost sm', text: 'Send to Calvin', title: b.clickupReady ? 'Creates a task in ClickUp Founder Escalations' : 'Needs INNADERM_CLICKUP_TOKEN in Vercel', disabled: !b.clickupReady && !DEMO, onclick: () => { state.escalating = t.id; render() } }),
        b.clickupReady || DEMO ? h('span', { class: 'muted', style: 'font-size:11.5px;margin-left:8px', text: 'Refunds, pausing subscriptions in Loop, anything you are unsure of.' }) : h('span', { class: 'muted', style: 'font-size:11.5px;margin-left:8px', text: 'Add INNADERM_CLICKUP_TOKEN in Vercel to turn this on.' }))
      return box
    }
    const preReason = ra?.escalate ? (ra.row === 'R7' ? 'Adverse reaction' : ['R12', 'R13'].includes(ra.row) ? 'Chargeback or dispute' : ['R3', 'R4', 'R5'].includes(ra.row) ? 'Replacement / reship' : 'Refund approval') : null
    const reason = h('select', null, ['Refund approval', 'Pause or cancel subscription (Loop)', 'Replacement / reship', 'Adverse reaction', 'Chargeback or dispute', 'Not sure how to answer', 'Other'].map((r) => h('option', { value: r, text: r, selected: preReason ? r === preReason : (r === 'Adverse reaction' && t.flags.includes('reaction')) || (r === 'Chargeback or dispute' && t.flags.includes('chargeback')) })))
    const question = h('textarea', { rows: 3, placeholder: 'What do you need Calvin to decide or do? e.g. "Approve a refund of the 1-pack ($59.99)?" or "Please pause her subscription in Loop."' }, ra?.escalate ? `Refund matrix ${ra.row} (${ra.def.title}). ${ra.escalate}. Recommended: ${ra.decision}${ra.order ? ` Order ${ra.order.name}, $${ra.order.total.toFixed(2)} incl. shipping.` : ''}` : '')
    const position = h('input', { type: 'text', placeholder: 'What the customer wants (optional)' })
    const msg = h('span', { class: 'msg' })
    const go = h('button', { class: 'btn sm', text: 'Create ClickUp task for Calvin', onclick: async () => {
      go.disabled = true; msg.textContent = 'Creating…'
      try {
        const r = DEMO ? { task: { id: 'demo', url: 'https://app.clickup.com' } } : await api('/cs/board/escalate', { method: 'POST', body: { id: t.id, reason: reason.value, question: question.value, customerPosition: position.value } })
        t.clickup = { id: r.task.id, url: r.task.url, status: 'new ticket', comments: [] }; t.status = 'With Calvin'; t.statusSet = true
        state.escalating = null; render()
      } catch (e) { msg.textContent = e.message; go.disabled = false }
    } })
    box.append(h('div', { class: 'esc' }, h('div', { class: 'lbl', text: 'Send to Calvin (ClickUp Founder Escalations)' }), reason, question, position,
      h('div', { class: 'actions' }, go, h('button', { class: 'btn ghost sm', text: 'Cancel', onclick: () => { state.escalating = null; render() } }), msg)))
    return box
  }

  function automationView(b) {
    const isAdmin = state.me?.role === 'admin'
    const rows = b.automation || []
    const saved = rows.reduce((a, r) => a + r.savedHoursPerWeek, 0)
    const total = rows.reduce((a, r) => a + r.hoursPerWeek, 0)
    const auto = b.stages.find((s) => s.key === 'autodraft').save
    const potential = rows.filter((r) => r.potential !== 'never' && r.potential !== 'low').reduce((a, r) => a + Math.max(r.savedHoursPerWeek, r.hoursPerWeek * auto), 0) + rows.filter((r) => r.potential === 'low' || r.potential === 'never').reduce((a, r) => a + r.savedHoursPerWeek, 0)
    const sec = h('div')
    sec.append(h('div', { class: 'kpis', style: 'margin-top:4px' },
      tile('Support hours per week', fmt1(total), 'h', h('div', { class: 'delta' }, h('span', { class: 'muted', text: `tickets × ${b.minutes || 6} min each` })), null),
      tile('Saved by automation now', fmt1(saved), 'h/wk', h('div', { class: 'delta' }, h('span', { class: saved ? 'up' : 'flat', text: total ? `${Math.round((saved / total) * 100)}% of support time` : '' })), null),
      tile('If every safe type is auto-drafted', fmt1(potential), 'h/wk', h('div', { class: 'delta' }, h('span', { class: 'muted', text: 'adverse reactions and disputes stay personal' })), null)))
    sec.append(h('div', { class: 'card', style: 'margin-top:14px' },
      h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Automation ladder' }), h('div', { class: 'hint', text: 'Move each ticket type up one step at a time. A type can only be auto-drafted once its template is approved. Auto-send comes after a Claude reply step.' }))),
      h('div', { class: 'ladder' }, b.stages.map((s, i) => h('div', { class: 'rung' }, h('b', { text: `${i}. ${s.label}` }), h('span', { text: s.help }), h('span', { class: 'muted', text: `saves about ${Math.round(s.save * 100)}% of handling time` })))),
      h('div', { style: 'overflow:auto;margin-top:12px' }, h('table', { class: 'dtable auto' },
        h('thead', null, h('tr', null, ['Ticket type', 'Per week', 'Stage', 'Template', 'Drafts (28 d)', 'Saved now', 'Owner / next step'].map((x) => h('th', { text: x })))),
        h('tbody', null, rows.map((r) => {
          const stageSel = isAdmin && r.potential !== 'never'
            ? h('select', { onchange: async (e) => { const v = e.target.value; try { if (!DEMO) await api('/cs/automation', { method: 'PUT', body: { category: r.category, stage: v } }); r.stage = v; loadBoard(true) } catch (err) { alert(err.message); render() } } },
              b.stages.map((s) => h('option', { value: s.key, selected: s.key === r.stage, disabled: s.key === 'autosend' || (s.key === 'autodraft' && !r.template?.approved), text: s.label })))
            : h('span', { text: r.potential === 'never' ? 'Never automate' : b.stages.find((s) => s.key === r.stage)?.label })
          const owner = isAdmin ? h('input', { value: r.owner || '', placeholder: 'owner', style: 'width:90px', onchange: (e) => DEMO || api('/cs/automation', { method: 'PUT', body: { category: r.category, owner: e.target.value } }) }) : h('span', { text: r.owner || '' })
          const next = isAdmin ? h('input', { value: r.nextStep || '', placeholder: 'next step', style: 'width:200px', onchange: (e) => DEMO || api('/cs/automation', { method: 'PUT', body: { category: r.category, nextStep: e.target.value } }) }) : h('span', { text: r.nextStep || '' })
          return h('tr', null,
            h('td', null, h('b', { text: r.category }), h('div', { class: 'logic', text: r.play })),
            h('td', { text: fmt1(r.perWeek) }),
            h('td', null, stageSel, r.stageSince && r.stage !== 'manual' ? h('div', { class: 'logic', text: 'since ' + fmtDate(r.stageSince) }) : null),
            h('td', null, r.template ? h('span', null, r.template.title, ' ', tag(r.template.approved ? 'Approved' : 'Not approved', r.template.approved ? 'good' : 'warn')) : '–'),
            h('td', { text: `${fmtInt(r.draftsAgent28)} agent · ${fmtInt(r.draftsAuto28)} auto` }),
            h('td', { text: r.savedHoursPerWeek ? fmt1(r.savedHoursPerWeek) + ' h/wk' : '–' }),
            h('td', null, owner, ' ', next))
        }))))))
    sec.append(h('p', { class: 'muted', style: 'font-size:12px;margin-top:10px', text: `Hours are estimates: tickets in the last 28 days, ${b.minutes || 6} minutes each (change in Settings), times the share each stage saves. Drafts counts what the team actually put into Gmail from the board, so you can see each step being used.` }))
    return sec
  }

  function templatesView(b) {
    const isAdmin = state.me?.role === 'admin'
    const sec = h('div')
    sec.append(h('p', { class: 'muted', style: 'font-size:12.5px', text: 'Templates fill in {first_name}, {order_status} (live from Shopify: shipped, tracking, delivered or not yet shipped), {order_number}, {order_or_ask}, {discount_code} and {agent}. Anything in [CAPITALS IN BRACKETS] must be replaced by the agent; drafts with one left are never put into Gmail. Only approved templates can be auto-drafted.' }))
    const sample = (b.tickets.find((t) => t.orders?.length) || b.tickets[0])?.vars || { first_name: 'Jamie', order_status: 'Your order #INN17489 shipped on October 20 with USPS.', order_number: '#INN17489', order_or_ask: 'Confirmation that the order is #INN17489', discount_code: b.settings.cs_discount_code }
    for (const t of b.templates) {
      const ed = (state.tplEdit ||= {})[t.key] || (state.tplEdit[t.key] = { ...t, categories: [...t.categories] })
      const msg = h('span', { class: 'msg' })
      const card = h('div', { class: 'card tpl' })
      card.append(h('div', { class: 'card-head' }, h('div', null, h('h3', { text: t.title }), h('div', { class: 'hint', text: (t.categories.join(', ') || 'Not the default for any type') + (t.updatedBy ? ` · edited by ${t.updatedBy} ${fmtDate(t.updatedAt)}` : '') })), h('div', { class: 'tools' }, tag(t.approved ? 'Approved' : 'Not approved', t.approved ? 'good' : 'warn'))))
      if (isAdmin) {
        card.append(h('div', { class: 'tpl-grid' },
          h('div', null,
            h('input', { value: ed.title, oninput: (e) => { ed.title = e.target.value } }),
            h('textarea', { rows: 10, oninput: (e) => { ed.body = e.target.value } }, ed.body),
            h('input', { value: ed.checklist || '', placeholder: 'Before-sending check shown to the agent', oninput: (e) => { ed.checklist = e.target.value } }),
            h('div', { class: 'cats' }, Object.keys(b.defaults).map((c) => h('label', null, h('input', { type: 'checkbox', checked: ed.categories.includes(c), onchange: (e) => { ed.categories = e.target.checked ? [...ed.categories, c] : ed.categories.filter((x) => x !== c) } }), c))),
            h('label', { class: 'appr' }, h('input', { type: 'checkbox', checked: ed.approved, onchange: (e) => { ed.approved = e.target.checked } }), ' Approved (safe to send after a quick check; allows auto-drafts)'),
            h('div', { class: 'actions' }, h('button', { class: 'btn sm', text: 'Save template', onclick: async () => { msg.textContent = 'Saving…'; try { if (!DEMO) await api('/cs/templates', { method: 'PUT', body: ed }); Object.assign(t, ed); msg.textContent = 'Saved'; loadBoard(true) } catch (e) { msg.textContent = e.message } } }), msg)),
          h('div', { class: 'preview' }, h('div', { class: 'lbl', text: 'Preview with a real ticket' }), h('pre', { text: fillTpl(ed.body, { ...sample, agent: signer() || 'Kashif' }) }))))
      } else card.append(h('pre', { class: 'preview', text: fillTpl(t.body, { ...sample, agent: signer() || 'Kashif' }) }))
      sec.append(card)
    }
    return sec
  }

  // ---------- Refund matrix (public/innaderm/refund.js) ----------
  const CHECK_CLS = { ok: 'good', bad: 'bad', warn: 'warn', info: '' }
  const CHECK_TXT = { ok: '✓', bad: '✕', warn: '?', info: '·' }

  function refundBox(t, ra) {
    const box = h('div', { class: 'refund' })
    box.append(h('div', { class: 'lbl' }, 'Refund check ', tag(ra.row, 'warn'), ' ', h('span', { text: ra.def.title }), ' ',
      h('a', { href: '#', class: 'muted', style: 'font-size:11.5px', text: 'see matrix', onclick: (e) => { e.preventDefault(); state.matrixRow = ra.row; state.view = 'matrix'; safeSet(LS_VIEW, 'matrix'); render(); window.scrollTo(0, 0) } })))
    box.append(h('ul', { class: 'rchecks' }, ra.checks.map((c) => h('li', null, h('span', { class: 'tag ' + (CHECK_CLS[c.state] || ''), text: CHECK_TXT[c.state] || '·' }), h('b', { text: ' ' + c.label + ' ' }), h('span', { text: c.value })))))
    box.append(h('p', { class: 'rdecide' }, h('b', { text: 'Policy: ' }), ra.def.policy))
    box.append(h('p', { class: 'rdecide' }, h('b', { text: 'Next step: ' }), ra.decision))
    if (ra.escalate) {
      box.append(h('div', { class: 'rcalvin' }, h('b', { text: 'Needs Calvin: ' }), ra.escalate,
        !t.clickup ? h('button', { class: 'btn sm ghost', style: 'margin-left:8px', text: 'Send to Calvin', onclick: () => { state.escalating = t.id; render() } }) : null))
    } else box.append(h('div', { class: 'rok', text: 'The team can handle this without Calvin.' }))
    return box
  }

  function matrixView() {
    const R = window.InnRefund
    const wrap = h('div', { class: 'wrap matrix' })
    if (!R) { wrap.append(h('div', { class: 'banner bad', text: 'The refund matrix did not load. Refresh the page.' })); return wrap }
    wrap.append(h('div', { class: 'banner' + (R.STATUS.approved ? ' info' : '') }, h('b', { text: R.STATUS.approved ? 'Approved by Calvin. ' : 'Draft. ' }), R.STATUS.note))
    wrap.append(h('div', { class: 'card', style: 'margin-top:16px' },
      h('h2', { text: 'Published refund policy' }),
      h('p', { class: 'muted', style: 'margin:2px 0 10px' }, `innaderm.com/policies/refund-policy, last updated ${R.STATUS.policyUpdated}. The page is what customers and card networks hold us to: where this tab and the page differ, the page wins.`),
      h('dl', { class: 'policy' }, R.POLICY.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))))
    const needle = (state.matrixSearch || '').toLowerCase()
    const rows = R.ROWS.filter((r) => !needle || [r.id, r.title, r.policy, r.team, r.calvin].join(' ').toLowerCase().includes(needle))
    const tbl = h('table', { class: 'tbl mtbl' },
      h('thead', null, h('tr', null, ['#', 'Situation', 'Policy says', 'Team decision (no Calvin)', 'Escalate to Calvin when'].map((x) => h('th', { text: x })))),
      h('tbody', null, rows.map((r) => h('tr', { id: 'm-' + r.id, class: state.matrixRow === r.id ? 'hl' : '' },
        h('td', null, h('b', { text: r.id })), h('td', null, h('b', { text: r.title })), h('td', { text: r.policy }), h('td', { text: r.team }), h('td', { text: r.calvin })))))
    wrap.append(h('div', { class: 'card', style: 'margin-top:16px' },
      h('div', { class: 'mhead' }, h('h2', { text: 'The matrix' }),
        h('input', { class: 'search', type: 'search', placeholder: 'Search: lost, renewal, rash, R8…', value: state.matrixSearch || '', oninput: (e) => { state.matrixSearch = e.target.value; clearTimeout(state._ms); state._ms = setTimeout(() => { render(); const el = $('.matrix .search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }, 200) } })),
      h('p', { class: 'muted', style: 'margin:2px 0 10px' }, 'Before any row, check: is it their first order, the carrier delivery date, any earlier guarantee refund (same person, household, address or card), any chargeback. Open a ticket on the Support board to see these filled in from Shopify.'),
      h('div', { style: 'overflow:auto' }, tbl)))
    wrap.append(h('div', { class: 'grid2', style: 'margin-top:16px' },
      h('div', { class: 'card' }, h('h2', { text: 'Always send to Calvin' }), h('ul', null, R.ALWAYS_CALVIN.map((x) => h('li', { text: x })))),
      h('div', { class: 'card' }, h('h2', { text: R.STATUS.approved ? 'Decided' : 'Waiting on Calvin' }), h('ol', null, R.DECISIONS.map((x) => h('li', { text: x }))))))
    wrap.append(h('p', { class: 'muted', style: 'margin-top:12px;font-size:11.5px', text: 'Built from the published policy and 116 past refund cases in support@innaderm.com (2 Jun to 24 Oct 2026). Suggestions only: nothing here refunds, cancels or sends anything. A person does the action, checks it happened, then sends.' }))
    if (state.matrixRow) setTimeout(() => { const el = document.getElementById('m-' + state.matrixRow); if (el) el.scrollIntoView({ block: 'center' }); state.matrixRow = null }, 50)
    return wrap
  }

  function demoBoard() {
    const ago = (h2) => new Date(Date.now() - h2 * 3600e3).toISOString()
    const mk = (id, name, email, subject, category, last, waiting, extra = {}) => ({
      id, subject, customerName: name, customerEmail: email, category, autoCategory: category, flags: [], excerpt: last, lastExcerpt: last,
      orderNumbers: [], firstIn: ago(waiting + 30), lastIn: ago(waiting), lastOut: ago(waiting + 20), lastFrom: 'in', msgsIn: 2, msgsOut: 1, inInbox: true,
      waitingHours: waiting, status: 'New', statusSet: false, note: '', reopened: false, needsReply: true, clickup: null, drafts: [], link: 'https://mail.google.com', customerLink: 'https://mail.google.com', orders: [], vip: false, spent: 0, ...extra,
    })
    const ord = (name, o) => ({ name, createdAt: ago(240), cancelledAt: null, financial: 'PAID', status: 'FULFILLED', total: 59.99, subscription: false, fulfilledAt: ago(150), deliveredAt: null, carrier: 'USPS', trackingNumber: '9400111899223344556677', trackingUrl: null, ...o })
    const tickets = [
      mk('d1', 'Diana Lopez', 'diana@example.com', 'Where is my order?', 'Where is my order', 'Hi, I ordered 10 days ago and still have nothing. Can you tell me where it is? Order #INN17481', 30, { orders: [ord('#INN17481', {})], orderNumbers: ['#INN17481'] }),
      mk('d2', 'Brittany Cole', 'brit@example.com', 'Cancel my subscription', 'Subscription', 'Please cancel, I have too many bottles at home right now.', 9, { orders: [ord('#INN17440', { subscription: true }), ord('#INN16012', { subscription: true, deliveredAt: ago(500) })], vip: true, spent: 119.98 }),
      mk('d3', 'Dawn Reyes', 'dawn@example.com', 'Bad reaction', 'Adverse reaction', 'I got a rash on my neck after a week of taking these. Should I stop?', 3, { flags: ['reaction'], orders: [ord('#INN17390', { deliveredAt: ago(200) })] }),
      mk('d4', 'Tyler Brooks', 'tyler@example.com', 'Refund', 'Refund / return', 'It has not done anything for my dandruff after 3 weeks, I want my money back.', 52, { status: 'With Calvin', statusSet: true, clickup: { id: 'x', url: 'https://app.clickup.com', status: 'founder responded', calvinReplied: true, comments: [{ by: 'Calvin Beck', fromCalvin: true, at: ago(2), text: 'Offer 3 packs at 50% first. If he insists, refund the 1-pack.' }] } }),
      mk('d5', 'Kevin Ng', 'kevin@example.com', 'Re: Your order', 'Where is my order', 'Thanks, but tracking has not moved in a week.', 1.5, { reopened: true, statusSet: true, status: 'Done', orders: [ord('#INN17501', { fulfilledAt: ago(170) })], drafts: [] }),
      mk('d6', 'Patrice Hall', 'patrice@example.com', 'Question before buying', 'Product question', 'Can I take this with my thyroid medication?', 20),
      mk('d7', 'Juhi Patel', 'juhi@example.com', '90 day refund request', 'Not working / results', 'I took it every morning for the full 90 days and my scalp is the same. I would like my money back under the guarantee.', 26, { orders: [ord('#INN16399', { total: 79.98, createdAt: ago(24 * 100), fulfilledAt: ago(24 * 92), deliveredAt: ago(24 * 82), subscription: true })], orderNumbers: ['#INN16399'], orderCount: 1 }),
      mk('d8', 'Steve Marsh', 'steve@example.com', 'Re: Order #INN18462 confirmed', 'Cancel order', 'I want to cancel this order please, I only placed it this morning.', 4, { orders: [ord('#INN18462', { total: 54.87, createdAt: ago(8), status: 'UNFULFILLED', fulfilledAt: null, trackingNumber: null })], orderNumbers: ['#INN18462'], orderCount: 1 }),
    ]
    const tplDemo = [
      { key: 'wismo', title: 'Where is my order', categories: ['Where is my order'], approved: true, checklist: 'Check the order line matches Shopify.', body: "Hi {first_name},\n\nThank you for reaching out, and sorry for the wait.\n\n{order_status}\n\nIf anything looks off, just reply here and I'll chase it for you.\n\n{agent}\nInnaderm" },
      { key: 'sub_change', title: 'Subscription: wants to cancel or pause', categories: ['Subscription'], approved: true, checklist: 'If they confirm: send to Calvin (Loop).', body: "Hi {first_name},\n\nThanks for letting me know. Before I make any changes, may I ask what prompted this? If it's timing or having too many on hand, I can pause your subscription or move your next delivery back instead, so nothing ships until you're ready.\n\n{agent}\nInnaderm" },
      { key: 'reaction', title: 'Adverse reaction', categories: ['Adverse reaction'], approved: false, checklist: 'Send to Calvin the same day.', body: "Hi {first_name},\n\nI'm really sorry to hear this. Please stop taking the capsules for now, and if the reaction is severe or doesn't settle, please speak to a doctor or pharmacist.\n\n{agent}\nInnaderm" },
      { key: 'refund', title: 'Refund request (first reply)', categories: ['Refund / return'], approved: false, checklist: 'Any refund needs Calvin.', body: 'Hi {first_name},\n\nThank you for getting in touch...\n\n{agent}\nInnaderm' },
      { key: 'product_q', title: 'Product question', categories: ['Product question'], approved: false, checklist: 'Only answer from innaderm.com.', body: "Hi {first_name},\n\nThanks for your question!\n\n[ANSWER FROM THE PRODUCT PAGE OR CALVIN]\n\nIf you'd like to give it a try, here's 15% off your order: {discount_code}.\n\n{agent}\nInnaderm" },
      { key: 'general', title: 'General reply', categories: ['Other'], approved: false, body: 'Hi {first_name},\n\n[YOUR REPLY]\n\n{agent}\nInnaderm' },
    ]
    const vars = (t) => ({ first_name: t.customerName.split(' ')[0], order_number: t.orders[0]?.name || '[ORDER NUMBER]', order_status: t.orders[0] ? (t.orders[0].fulfilledAt ? `Your order ${t.orders[0].name} shipped on ${fmtDate(t.orders[0].fulfilledAt)} with USPS. Your tracking number is ${t.orders[0].trackingNumber}.` : `Your order ${t.orders[0].name} hasn't shipped yet.`) : "Could you send me your order number (it starts with #INN)?", order_or_ask: 'Your order number', discount_code: 'WELCOME15' })
    for (const t of tickets) t.vars = vars(t)
    const cats = ['Where is my order', 'Subscription', 'Refund / return', 'Product question', 'Not working / results', 'Cancel order', 'Marked delivered, not received', 'Billing / payment', 'Address change', 'Damaged / wrong / missing item', 'Discount / offer', 'Adverse reaction', 'Chargeback / dispute threat', 'Other']
    const defaults = Object.fromEntries(cats.map((c) => [c, (tplDemo.find((x) => x.categories.includes(c)) || tplDemo[tplDemo.length - 1]).key]))
    const pw = { 'Where is my order': 52, Subscription: 31, 'Refund / return': 18, 'Product question': 16, 'Not working / results': 12, 'Cancel order': 9, 'Marked delivered, not received': 7, 'Billing / payment': 6, 'Address change': 4, 'Damaged / wrong / missing item': 3, 'Discount / offer': 3, 'Adverse reaction': 2, 'Chargeback / dispute threat': 2, Other: 8 }
    const never = new Set(['Adverse reaction', 'Chargeback / dispute threat'])
    const stagesDemo = [{ key: 'manual', label: 'Manual', save: 0, help: 'Written from scratch each time.' }, { key: 'template', label: 'Approved template', save: 0.4, help: 'Agent picks the template; name, order and tracking fill in.' }, { key: 'autodraft', label: 'Auto-drafted in Gmail', save: 0.7, help: 'A filled draft is waiting in the Gmail thread when the ticket arrives. Agent checks and sends.' }, { key: 'autosend', label: 'Auto-send', save: 0.95, help: 'Sent without a person. Next step: Claude-written replies with a review sample. Not switched on yet.' }]
    const stageOf = { 'Where is my order': 'autodraft', Subscription: 'template' }
    const automation = cats.map((c) => { const st = stagesDemo.find((s) => s.key === (stageOf[c] || 'manual')); const tpl = tplDemo.find((x) => x.key === defaults[c]); return { category: c, potential: never.has(c) ? 'never' : ['Not working / results', 'Other'].includes(c) ? 'low' : 'high', play: '', stage: st.key, stageSince: st.key !== 'manual' ? ago(24 * 6) : null, owner: st.key !== 'manual' ? 'Khethiwe' : '', nextStep: c === 'Subscription' ? 'Approve wording with Calvin, then auto-draft' : '', perWeek: pw[c], hoursPerWeek: (pw[c] * 6) / 60, savedHoursPerWeek: (pw[c] * 6 * st.save) / 60, template: tpl ? { key: tpl.key, title: tpl.title, approved: tpl.approved } : null, draftsAgent28: st.key === 'template' ? 41 : 3, draftsAuto28: st.key === 'autodraft' ? 166 : 0, tickets28: pw[c] * 4 } })
    return { tickets, templates: tplDemo, statuses: ['New', 'Drafted', 'Replied', 'Waiting on customer', 'With Calvin', 'With Zendrop', 'Done', 'Skip'], defaults, automation, stages: stagesDemo, settings: { cs_discount_code: 'WELCOME15' }, clickupReady: true, shopifyReady: true, sync: { lastIngestAt: new Date().toISOString() }, draftScript: { at: new Date().toISOString() }, minutes: 6 }
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
        zendrop: { sheetId: '1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY', tabs: [{ name: 'Fulfillment Issues', gid: '1279079658', open: 23, raised7: 9, resolved7: 12, oldestDays: 31, byTopic: { 'Stuck In Transit': 9, 'Unfulfilled': 7, 'Cancellation': 4, 'HOLD': 3 }, rowsInnaderm: 40, skippedOther: 0, openRows: [{ order: '#INN70312', topic: 'Stuck In Transit', ageDays: 31 }, { order: '#INN71044', topic: 'Unfulfilled', ageDays: 12 }] }, { name: 'Zendrop Order Issues', gid: '124374285', open: 11, raised7: 4, resolved7: 6, oldestDays: 19, byTopic: { 'Incomplete Shipping Address': 8, 'Customer Phone Number Needed': 3 }, rowsInnaderm: 17, skippedOther: 0, openRows: [{ order: '#INN70980', topic: 'Incomplete Shipping Address', ageDays: 19 }] }] },
        clickup: { lists: [{ id: '901222538715', name: 'Founder Escalations', total: 6, overdue: 2, unassigned: 1, byStatus: { 'to do': 4, 'in progress': 2 }, tasks: [{ id: 'a', name: 'Chargeback #IN1988 – evidence pack', status: 'in progress', url: 'https://app.clickup.com', due: new Date(Date.now() - 86400e3).toISOString(), overdue: true, assignees: ['Khethiwe'] }, { id: 'b', name: 'Pre-order button test on Serentia', status: 'to do', url: 'https://app.clickup.com', due: new Date(Date.now() + 3 * 86400e3).toISOString(), overdue: false, assignees: [] }] }, { id: '901216052461', name: 'Ops Overview', total: 14, overdue: 3, unassigned: 2, byStatus: { 'to do': 9, 'in progress': 5 }, tasks: [{ id: 'c', name: 'Weekly Zendrop reconciliation', status: 'to do', url: 'https://app.clickup.com', due: new Date(Date.now() + 86400e3).toISOString(), overdue: false, assignees: ['Khethiwe'] }] }] },
      },
      settings: { finished_source: 'shopify', finished_on_hand: null, packaging_on_hand: 3600, lead_finished_with_packaging: 10, lead_finished_without_packaging: 22, lead_packaging: 14, moq_finished: 2500, moq_packaging: 5000, unit_cost_finished: 4.1, unit_cost_packaging: 0.35, baseline_days: 14, scale_pct: 20, scale_days_default: 3, safety_days: 7, packaging_per_unit: 1, tracked_variant_ids: [], clickup_lists: [{ id: '901222538715', name: 'Founder Escalations' }, { id: '901216052461', name: 'Ops Overview' }], zendrop_sheet_id: '1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY', inbound_stock: [{ id: 'a', item: 'finished', units: 2374, status: 'in_transit', to: 'Zendrop', eta: '2026-11-03', eta_text: 'early next week', note: 'Part 1 of 3,000.', source: 'Ava on Slack' }, { id: 'b', item: 'finished', units: 626, status: 'waiting_packaging', to: 'Zendrop', eta: null, eta_text: 'next batch', note: 'Held back: not enough bags.' }, { id: 'c', item: 'packaging', units: 4000, status: 'ordered', to: 'Capsule factory', eta: '2026-11-06', eta_text: 'early November', note: 'Bags for the next batches.' }] },
      settingsMeta: {},
      viewer: { name: 'Demo viewer', role: 'admin' },
    }
  }

  boot()
})()
