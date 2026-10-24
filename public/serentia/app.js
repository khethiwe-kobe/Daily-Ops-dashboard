/* Serentia Ops dashboard. Plain JS, no build step. Talks to /api/serentia/*.
   Started as a copy of the Innaderm dashboard; stock and reorders are per
   shade here because Serentia sells one cream in several shades.
   Everything data-driven is inserted with textContent / createElement so a
   product name or ClickUp task title can never become markup. */
;(() => {
  'use strict'

  const API = '/api/serentia'
  const LS_TOKEN = 'serentia.token'
  const LS_DAYS = 'serentia.days'
  const LS_THEME = 'serentia.theme'
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
    tables: {},
    syncing: false,
    drawer: false,
    keys: null,
    newKey: null,
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
    if (DEMO) { state.me = { name: 'Demo viewer', role: 'admin' }; state.data = demoData(); render(); return }
    if (state.token || document.cookie.includes('ser_session')) {
      try { state.me = await api('/auth/me') } catch { state.me = null }
    }
    render()
    if (state.me) load()
  }

  async function load() {
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

  // ---------- model: stock per shade ----------
  // Daily demand per shade for the next `horizon` days: new orders at the
  // shade's run rate (times the Black Friday multiplier inside the window)
  // plus its renewals spread evenly over 30 days.
  const HORIZON = 365 // days the forecast looks ahead; cover at this value means "more than a year"
  const DAY = 86400e3
  const today0 = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t }
  const dayN = (k) => new Date(today0().getTime() + k * DAY)
  const daysUntil = (iso) => (iso ? Math.round((new Date(iso + 'T00:00:00') - today0()) / DAY) : null)
  function shadeCurve(sh, S, { surge = true, horizon = HORIZON } = {}) {
    const R = (sh.renewals30 || 0) / 30
    const from = daysUntil(S.bf_start), to = daysUntil(S.bf_end)
    const out = []
    for (let k = 1; k <= horizon; k++) {
      const m = surge && from != null && to != null && k >= from && k <= to ? S.bf_multiplier || 1 : 1
      out.push((sh.newPerDay || 0) * m + R)
    }
    return out
  }
  function daysOfCover(onHand, curve) {
    if (onHand == null) return null
    if (onHand <= 0) return 0
    let left = onHand
    for (let i = 0; i < curve.length; i++) {
      if (curve[i] <= 0) continue
      if (left <= curve[i]) return i + left / curve[i]
      left -= curve[i]
    }
    return curve.length
  }
  function sum(arr, n) { let t = 0; for (let i = 0; i < Math.min(n, arr.length); i++) t += arr[i]; return t }

  function planShade(sh, S) {
    const curve = shadeCurve(sh, S)
    const sellPerDay = (sh.newPerDay || 0) + (sh.renewals30 || 0) / 30
    const noSales = !(sellPerDay > 0)
    const lead = S.lead_days || 0, safety = S.safety_days || 0
    // Cover is withheld without a count or a sell rate, never shown as "a year".
    const cover = sh.onHand == null || (noSales && sh.onHand > 0) ? null : daysOfCover(sh.onHand, curve)
    const capped = cover != null && cover >= HORIZON
    // Out of stock (or oversold) means the order is due now, not on a date
    // that already passed.
    const out = sh.onHand != null && sh.onHand <= 0
    const runout = cover == null || capped ? null : out ? today0() : dayN(cover)
    const orderBy = cover == null || capped ? null : out ? today0() : dayN(Math.floor(cover - lead - safety))
    // Enough to last until cover_until (at least one lead time out), plus the
    // safety buffer at the average rate. A negative count (oversold) adds the
    // owed units back on top.
    const untilDays = Math.max(daysUntil(S.cover_until) ?? 30, lead)
    const need = sum(curve, Math.ceil(untilDays)) + safety * sellPerDay
    const toOrder = sh.onHand == null || noSales ? null : Math.max(0, Math.ceil(need - sh.onHand))
    const bfFrom = daysUntil(S.bf_start), bfTo = daysUntil(S.bf_end)
    const bfUnits = bfFrom == null || bfTo == null || bfTo < 1 ? null : sum(curve.slice(Math.max(0, bfFrom - 1)), bfTo - Math.max(1, bfFrom) + 1)
    let status = 'good', label = 'healthy'
    if (sh.onHand == null) { status = 'na'; label = 'no stock count' }
    else if (sh.onHand <= 0) { status = 'bad'; label = sh.onHand < 0 ? `oversold ${fmtInt(-sh.onHand)}` : 'out of stock' }
    else if (noSales) { status = 'na'; label = 'no sales yet' }
    else if (orderBy && orderBy <= today0()) { status = 'bad'; label = 'order now' }
    else if (runout && daysUntil(S.cover_until) != null && runout < new Date(S.cover_until + 'T00:00:00')) { status = 'warn'; label = 'runs out before ' + fmtDate(S.cover_until + 'T00:00:00') }
    else if (orderBy && (orderBy - today0()) / DAY <= 7) { status = 'warn'; label = 'order this week' }
    else if (toOrder > 0) { status = 'warn'; label = 'order by ' + fmtDate(orderBy) }
    return { ...sh, curve, sellPerDay, noSales, cover, capped, out, runout, orderBy, toOrder, need, bfUnits, status, label,
      coverLabel: cover == null ? '–' : capped ? `${HORIZON}+` : fmt1(cover) }
  }
  function plan(d) {
    const S = d.settings
    const rows = d.shades.map((sh) => planShade(sh, S))
    const order = rows.reduce((a, r) => a + (r.toOrder || 0), 0)
    const dated = rows.filter((r) => r.orderBy && r.toOrder > 0).sort((a, b) => a.orderBy - b.orderBy)
    // Short = out now, an order already due, or running out before the cover
    // date. A shade that only needs topping up for the buffer is not short.
    const until = new Date(S.cover_until + 'T00:00:00')
    return { rows, order, firstOrderBy: dated[0] || null, short: rows.filter((r) => r.status === 'bad' || (r.runout && r.runout < until)) }
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
    app.append(topBar(), mainView(), drawer())
  }

  function loginView() {
    const err = h('div', { class: 'err', text: '' })
    const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'ser_xxxxxxxx-xxxxxxxx-…', 'aria-label': 'Access key', autofocus: true })
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
      h('div', { class: 'brand' }, h('div', { class: 'mark', text: 'SE' }), h('div', null, h('div', { class: 'name', text: 'Serentia' }), h('div', { class: 'sub', text: 'Operations dashboard' }))),
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
    return h('header', { class: 'top' }, h('div', { class: 'top-in' },
      h('div', { class: 'brand' }, h('div', { class: 'mark', text: 'SE' }), h('div', null, h('span', { class: 'name', text: 'Serentia' }), h('span', { class: 'sub', text: ' Ops' }))),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, PERIODS.map((p) => h('button', { 'aria-pressed': String(p === state.days), text: `${p}d`, onclick: () => { state.days = p; safeSet(LS_DAYS, String(p)); load() } }))),
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
    const p = plan(d)
    wrap.append(stockStrip(d, p))
    wrap.append(setupBanners(d))
    wrap.append(shadeSection(d, p))
    wrap.append(fulfilmentSection(d))
    wrap.append(opsSection(d))
    wrap.append(h('footer', { class: 'foot' },
      h('span', { text: `Generated ${fmtDateLong(d.generatedAt)} ${fmtTime(d.generatedAt)}` }),
      h('span', { text: `Store: ${d.integrations.shopify.store || 'not set'}` }),
      d.integrations.shopify.sync?.orders ? h('span', { text: `${fmtInt(d.integrations.shopify.sync.orders)} orders synced since ${fmtDate(d.integrations.shopify.sync.oldest)}` }) : null,
      h('span', { text: 'Period changes the fulfilment panel; stock and reorder figures always use the settings below.' })))
    return wrap
  }

  // The one answer: does every shade last until the cover date, Black Friday
  // included, and if not, which ones and by when must Zendrop have the order.
  function stockStrip(d, p) {
    const S = d.settings
    const until = fmtDate(S.cover_until + 'T00:00:00')
    const known = p.rows.filter((r) => r.status !== 'na')
    const verdict = !known.length ? 'unknown' : p.short.length ? 'no' : 'yes'
    const chip = verdict === 'yes' ? ['yes', 'YES'] : verdict === 'no' ? ['no', 'NO'] : ['unknown', 'UNKNOWN']
    const missing = p.rows.filter((r) => r.status === 'na')
    const reason = verdict === 'unknown'
      ? (d.stock.error ? `Stock count unavailable: ${d.stock.error}` : 'Needs a stock count and sales history per shade before it can answer.')
      : verdict === 'no'
        ? `${p.short.map((r) => `${r.name} (${r.label})`).join(', ')}. Everything else lasts until ${until}.`
        : `Every shade lasts until ${until}, Black Friday (${S.bf_multiplier}× new orders ${fmtDate(S.bf_start + 'T00:00:00')}–${fmtDate(S.bf_end + 'T00:00:00')}) and renewals included.`
    const first = p.firstOrderBy
    return h('section', { class: 'section' }, h('div', { class: 'decision' },
      h('div', null,
        h('div', { class: 'q', text: `Does stock last until ${until}, Black Friday included?` }),
        h('div', { class: 'verdict' }, h('span', { class: `chip ${chip[0]}`, text: chip[1] }), h('span', { text: verdict === 'yes' ? 'Every shade covered' : verdict === 'no' ? `${p.short.length} shade${p.short.length === 1 ? '' : 's'} short` : 'Inputs missing' })),
        h('div', { class: 'reason', text: reason }),
        missing.length && verdict !== 'unknown' ? h('div', { class: 'reason basis', text: `Not judged: ${missing.map((r) => `${r.name} (${r.label})`).join(', ')}.` }) : null),
      h('div', { class: 'mini' }, h('div', { class: 'l', text: 'Out of stock now' }), h('div', { class: 'v hero', text: String(p.rows.filter((r) => r.onHand != null && r.onHand <= 0).length) }), h('div', { class: 's', text: p.rows.filter((r) => r.onHand != null && r.onHand <= 0).map((r) => r.name).join(', ') || 'none' })),
      h('div', { class: 'mini' }, h('div', { class: 'l', text: 'First order due' }), h('div', { class: 'v', text: first ? (first.out ? 'Now' : fmtDate(first.orderBy)) : '–' }), h('div', { class: 's', text: first ? `${first.name} · ${first.out ? 'out of stock' : inDays(first.orderBy)} · ${S.lead_days}-day lead` : `nothing to order before ${until}` })),
      h('div', { class: 'mini' }, h('div', { class: 'l', text: `Units to order (to ${until})` }), h('div', { class: 'v', text: fmtInt(p.order) }), h('div', { class: 's', text: S.moq_units ? `MOQ ${fmtInt(S.moq_units)} per order` : 'MOQ not set' }))))
  }

  function setupBanners(d) {
    const box = h('div')
    const I = d.integrations
    if (!I.shopify.configured) box.append(h('div', { class: 'banner bad' }, h('span', null, h('b', null, 'Shopify is not connected. '), 'Add ', h('code', null, 'SERENTIA_SHOPIFY_STORE'), ' (the xxx.myshopify.com name), ', h('code', null, 'SERENTIA_SHOPIFY_CLIENT_ID'), ' and ', h('code', null, 'SERENTIA_SHOPIFY_CLIENT_SECRET'), ' in Vercel and redeploy. Until then there are no sales per shade, so no days of cover.')))
    if (I.shopify.configured && I.shopify.sync && !I.shopify.sync.backfilled) box.append(h('div', { class: 'banner' }, `Loading 120 days of Shopify history (${fmtInt(I.shopify.sync.orders || 0)} orders so far, newest first). Numbers firm up as it completes.`))
    if (I.shopify.error) box.append(h('div', { class: 'banner bad', text: `Shopify: ${I.shopify.error}` }))
    if (d.demandError) box.append(h('div', { class: 'banner bad', text: `Sales per shade: ${d.demandError}` }))
    if (d.stock.error) box.append(h('div', { class: 'banner bad' }, h('span', null, h('b', null, 'Stock count: '), d.stock.error, d.stock.source === 'zendrop' ? '. Check the Zendrop sheet is shared by link and set the Inventory tab id in Settings.' : '')))
    if (!I.loop.configured) box.append(h('div', { class: 'banner' }, h('span', null, h('b', null, 'Loop is not connected: '), 'renewals per shade are estimated from renewal orders billed in the last 30 days. Add ', h('code', null, 'SERENTIA_LOOP_TOKEN'), ' for the exact renewals due.')))
    if (I.loop.error) box.append(h('div', { class: 'banner', text: `Loop: ${I.loop.error}` }))
    if (d.renewals.unmatched) box.append(h('div', { class: 'banner', text: `${fmtInt(d.renewals.unmatched)} renewal units in Loop did not match a shade name and are left out. Check the shade list in Settings.` }))
    if (d.stock.unmatched?.length) box.append(h('div', { class: 'banner', text: `Stock rows not matched to a shade: ${d.stock.unmatched.map((u) => `${u.label} (${fmtInt(u.units)})`).join(', ')}.` }))
    return box
  }

  // ----- Stock by shade -----
  function shadeSection(d, p) {
    const S = d.settings
    const until = fmtDate(S.cover_until + 'T00:00:00')
    const sec = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'Stock by shade' }), h('span', { class: 'why', text: `Sells/day = new orders over the last ${S.baseline_days} days + renewals. Black Friday multiplies new orders ${S.bf_multiplier}× from ${fmtDate(S.bf_start + 'T00:00:00')} to ${fmtDate(S.bf_end + 'T00:00:00')}. Order by = run-out − ${S.lead_days}-day lead − ${S.safety_days}-day buffer.` })))
    const grid = h('div', { class: 'grid' })
    const src = d.stock.source === 'zendrop' ? 'Zendrop sheet, Inventory tab' : 'Shopify inventory'
    const head = ['Shade', 'On hand', 'Sells / day', 'Renewals / 30 d', 'Black Friday demand', 'Days of cover', 'Runs out', 'Order by', `To order (to ${until})`, 'Status']
    const rows = p.rows.map((r) => [
      r.name, r.onHand == null ? '–' : fmtInt(r.onHand), r.noSales ? '–' : fmt1(r.sellPerDay), fmtInt(r.renewals30), r.bfUnits == null ? '–' : fmtInt(r.bfUnits),
      r.coverLabel, r.out ? 'out now' : r.runout ? fmtDate(r.runout) : r.capped ? 'after a year' : '–', r.out ? 'now' : r.orderBy ? fmtDate(r.orderBy) : r.capped ? 'not this year' : '–',
      r.toOrder == null ? '–' : fmtInt(r.toOrder), r,
    ])
    grid.append(h('div', { class: 'card', style: 'grid-column: span 12' },
      h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Per shade' }), h('div', { class: 'hint', text: `${src}${d.stock.countedAt ? ' · read ' + fmtDate(d.stock.countedAt) + ' ' + fmtTime(d.stock.countedAt) : ''}${p.rows.some((r) => r.stockDate) ? ' · sheet updated ' + [...new Set(p.rows.map((r) => r.stockDate).filter(Boolean))].join(', ') : ''}` })),
        d.stock.url ? h('div', { class: 'tools' }, h('a', { class: 'tbtn', href: d.stock.url, target: '_blank', rel: 'noopener', text: 'Open sheet' })) : null),
      h('div', { style: 'overflow-x:auto' }, h('table', { class: 'dtable' },
        h('thead', null, h('tr', null, head.map((t) => h('th', { text: t })))),
        h('tbody', null, rows.map((r) => h('tr', null, r.slice(0, -1).map((v, i) => h('td', { class: i === 0 ? 'out' : '', text: v })), h('td', null, h('span', { class: `status ${r[r.length - 1].status}`, text: r[r.length - 1].label }))))),
        h('tfoot', null, h('tr', null, h('td', { class: 'out', text: 'Total' }), h('td', { text: fmtInt(p.rows.reduce((a, r) => a + (r.onHand || 0), 0)) }), h('td', { text: fmt1(p.rows.reduce((a, r) => a + r.sellPerDay, 0)) }), h('td', { text: fmtInt(p.rows.reduce((a, r) => a + (r.renewals30 || 0), 0)) }), h('td', { text: fmtInt(p.rows.reduce((a, r) => a + (r.bfUnits || 0), 0)) }), h('td'), h('td'), h('td'), h('td', { text: fmtInt(p.order) }), h('td'))))),
      // Other products (brushes, bundles) land here too; listed so a renamed
      // shade is noticed, not counted.
      d.unmatchedDemand?.length ? h('div', { class: 'note', text: `Sales not matched to a shade (last ${S.baseline_days} days): ${d.unmatchedDemand.map((u) => `${u.label} ${fmtInt(u.units)}`).join(' · ')}. If one of these is an Elixir+ shade, add it in Settings → Shades.` }) : null))
    // Suggestions
    const sug = []
    for (const r of p.rows) {
      if (r.onHand != null && r.onHand < 0) sug.push({ cls: 'bad', ic: '!', t: `${r.name} is oversold by ${fmtInt(-r.onHand)}.`, s: 'Those customers are waiting on stock that does not exist yet: switch the shade to pre-order (or pause it) and message them with a realistic date before they ask.' })
      else if (r.onHand === 0) sug.push({ cls: 'bad', ic: '!', t: `${r.name} is out of stock.`, s: 'Switch it to pre-order or pause it until the batch lands.' })
      if (r.toOrder > 0 && r.orderBy && !r.out) sug.push({ cls: r.status === 'bad' || r.status === 'warn' ? 'warn' : '', ic: 'Z', t: `Order ${fmtInt(r.toOrder)} ${r.name} by ${fmtDateLong(r.orderBy)}${r.orderBy <= today0() ? ' (overdue)' : ''}.`, s: `Lasts until ${until} with Black Friday and renewals, plus ${S.safety_days} days' buffer${S.unit_cost ? ' · ~' + fmtMoney(r.toOrder * S.unit_cost) : ''}.` })
      else if (r.toOrder > 0 && r.out) sug.push({ cls: 'warn', ic: 'Z', t: `Order ${fmtInt(r.toOrder)} ${r.name} now.`, s: `Covers what is owed plus demand until ${until} and ${S.safety_days} days' buffer.` })
    }
    if (p.order > 0 && S.moq_units && p.order < S.moq_units) sug.push({ cls: '', ic: 'M', t: `Total ${fmtInt(p.order)} units is under the ${fmtInt(S.moq_units)} MOQ.`, s: 'Top the order up on the fastest sellers, or confirm with Zendrop whether the MOQ is per shade or per order.' })
    if (sug.length) grid.append(h('div', { class: 'card', style: 'grid-column: span 12' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Suggested actions' }), h('div', { class: 'hint', text: 'Recomputed on every refresh and settings change' }))),
      h('div', { class: 'suggest' }, sug.map((x) => h('div', { class: `s ${x.cls}` }, h('span', { class: 'ic', text: x.ic }), h('div', null, x.t, h('small', { text: x.s })))))))
    const toOrder = p.rows.filter((r) => r.toOrder > 0)
    if (toOrder.length) grid.append(h('div', { class: 'card c6' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Units to order by shade' }), h('div', { class: 'hint', text: `To last until ${until}` }))),
      hbars(toOrder.sort((a, b) => b.toOrder - a.toOrder).map((r) => ({ label: r.name, value: r.toOrder })), { color: SERIES[1], total: p.order })))
    const covered = p.rows.filter((r) => r.cover != null)
    if (covered.length) grid.append(h('div', { class: 'card c6' }, h('div', { class: 'card-head' }, h('div', null, h('h3', { text: 'Days of cover by shade' }), h('div', { class: 'hint', text: `Lead time + buffer is ${S.lead_days + S.safety_days} days; below that a reorder cannot land in time` }))),
      hbars(covered.sort((a, b) => a.cover - b.cover).map((r) => ({ label: r.name, value: Math.round(Math.min(r.cover, HORIZON)) })), { color: SERIES[0] })))
    sec.append(grid)
    return sec
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


  // ----- Panel 5: ops queues -----
  function opsSection(d) {
    const sec = h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', { text: 'Ops queues' }), h('span', { class: 'why', text: 'Open issues with Zendrop and escalations in ClickUp.' })))
    const grid = h('div', { class: 'grid' })
    const zd = d.ops.zendrop
    const noSerentiaRows = zd && !zd.error && zd.tabs && zd.tabs.every((t) => t.error || !t.rowsSerentia)
    if (noSerentiaRows) {
      const skipped = zd.tabs.reduce((n, t) => n + (t.skippedOther || 0), 0)
      grid.append(h('div', { class: 'card c4 setup' }, h('h3', { text: 'Zendrop issues' }), h('p', { text: `No Serentia orders in this Zendrop sheet${skipped ? ` (${fmtInt(skipped)} Innaderm #INN rows hidden)` : ''}.` })))
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
    if (!d.integrations.clickup.configured) grid.append(h('div', { class: 'card c4 setup' }, h('h3', { text: 'ClickUp escalations' }), h('p', null, 'Add ', h('code', null, 'SERENTIA_CLICKUP_TOKEN'), ' (a personal API token) in Vercel to show open Founder Escalations and Ops Overview tasks here.')))
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
    const S = state.data?.settings || {}
    const meta = state.data?.settingsMeta || {}
    const form = {}
    const F = (key, label, help, type = 'number', opts) => {
      let input
      if (opts) { input = h('select', null, opts.map(([v, l]) => h('option', { value: v, selected: S[key] === v, text: l }))) }
      else input = h('input', { type, value: Array.isArray(S[key]) ? S[key].join(', ') : S[key] ?? '', step: 'any', min: 0, placeholder: '–' })
      form[key] = input
      const m = meta[key]
      return h('div', { class: 'field' }, h('label', { text: label }), input, h('div', { class: 'help', text: help + (m ? ` · set ${fmtDate(m.at)} by ${m.by || '?'}` : '') }))
    }
    const msg = h('div', { class: 'msg' })
    const save = async () => {
      const patch = {}
      for (const [k, el] of Object.entries(form)) patch[k] = el.value === '' ? null : el.tagName === 'SELECT' || el.type !== 'number' ? el.value : Number(el.value)
      msg.textContent = 'Saving…'
      try {
        if (DEMO) {
          for (const k of ['shades', 'zendrop_inventory_products']) if (typeof patch[k] === 'string') patch[k] = patch[k].split(',').map((x) => x.trim()).filter(Boolean)
          Object.assign(S, patch); msg.textContent = 'Saved (demo, not persisted)'; render(); return
        }
        const r = await api('/settings', { method: 'PUT', body: patch })
        msg.textContent = r.errors?.length ? 'Saved with notes: ' + r.errors.join('; ') : 'Saved'
        await load()
        state.drawer = true; render()
      } catch (e) { msg.textContent = e.message }
    }
    const keyName = h('input', { type: 'text', placeholder: 'Who is this key for? e.g. Calvin' })
    const keyRole = h('select', null, h('option', { value: 'viewer', text: 'Viewer' }), h('option', { value: 'admin', text: 'Admin (can edit inputs and keys)' }))
    const issue = async () => {
      try {
        const r = DEMO ? { key: 'ser_demo0000-demo0000-demo0000-demo0000', name: keyName.value } : await api('/keys', { method: 'POST', body: { name: keyName.value, role: keyRole.value } })
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
        F('stock_source', 'Stock source', 'Zendrop holds the stock; the sheet is the count Calvin keeps', null, [['zendrop', 'Zendrop sheet (Inventory tab)'], ['shopify', 'Shopify inventory']]),
        F('zendrop_inventory_gid', 'Inventory tab id', 'the number after gid= in the Inventory tab URL; blank = find the tab by name', 'text'),
        F('zendrop_inventory_products', 'Zendrop product ids', 'comma separated; rows from other product versions are ignored', 'text'),
        F('shades', 'Shades', 'comma separated; matched by name in Shopify, Loop and the sheet', 'text')),
      h('h3', { text: 'Reorder' }),
      h('div', { class: 'form' },
        F('lead_days', 'Lead time (days)', 'Zendrop sheet: production cycle about 10 days'),
        F('safety_days', 'Safety buffer (days)', 'added on top of the lead time'),
        F('moq_units', 'MOQ (units per order)', 'Zendrop sheet: 2,500'),
        F('unit_cost', 'Unit cost ($)', 'shows the cash needed per suggestion')),
      h('h3', { text: 'Black Friday & demand' }),
      h('div', { class: 'form' },
        F('baseline_days', 'Run-rate window (days)', 'new-order units per day are averaged over this window'),
        F('bf_start', 'Black Friday from', 'early access day', 'date'),
        F('bf_end', 'Black Friday to', 'last day of the sale', 'date'),
        F('bf_multiplier', 'Black Friday multiplier', 'new orders per day during the sale vs normal; use last year\'s lift'),
        F('cover_until', 'Order enough to last until', 'reorder quantities cover demand to this date', 'date')),
      h('div', { class: 'actions' }, h('button', { class: 'btn', text: 'Save inputs', onclick: save }), msg),
      h('h3', { text: 'Access keys' }),
      h('p', { class: 'muted', style: 'font-size:12.5px;margin:0 0 8px', text: 'One key per person. Revoking a key signs that person out everywhere. The admin key from Vercel (SERENTIA_ADMIN_KEY) is listed once it has been used.' }),
      h('div', { class: 'form' }, h('div', { class: 'field' }, h('label', { text: 'Name' }), keyName), h('div', { class: 'field' }, h('label', { text: 'Role' }), keyRole)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', text: 'Issue key', onclick: issue })),
      state.newKey ? h('div', { class: 'newkey' }, `New key for ${state.newKey.name}. Copy it now; it is not shown again.`, h('code', { text: state.newKey.key }), h('button', { class: 'btn sm ghost', text: 'Copy', onclick: () => navigator.clipboard?.writeText(state.newKey.key) })) : null,
      h('div', { style: 'margin-top:12px' }, (state.keys || []).map((k) => h('div', { class: 'keyrow' },
        h('div', null, h('b', { text: k.name }), k.you ? ' (you)' : '', h('div', { class: 'm', text: `${k.role} · created ${fmtDate(k.createdAt)}${k.lastUsedAt ? ' · last used ' + fmtDate(k.lastUsedAt) : ' · never used'}${k.revokedAt ? ' · REVOKED ' + fmtDate(k.revokedAt) : ''}` })),
        !k.revokedAt && !k.you ? h('button', { class: 'btn sm danger', text: 'Revoke', onclick: () => revoke(k) }) : h('span')))),
      h('h3', { text: 'Sources' }),
      h('p', { class: 'muted', style: 'font-size:12.5px', text: `Shopify store: ${state.data?.integrations.shopify.store || 'not set'}. Zendrop sheet id: ${S.zendrop_sheet_id}. ClickUp lists: ${(S.clickup_lists || []).map((l) => l.name).join(', ') || 'none'}. Change these in Vercel env / the settings API.` }))
    return h('div', { class: 'drawer open' }, h('div', { class: 'scrim', onclick: closeDrawer }), panel)
  }

  // ---------- demo data (layout check without secrets: /serentia?demo=1) ----------
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
    // Made-up figures for the layout check only: no real stock or sales.
    const shade = (name, onHand, newPerDay, renewals30) => ({ name, onHand, stockDate: '10/20/2026', newUnits: Math.round(newPerDay * 14), priorNewUnits: Math.round(newPerDay * 12), renewals30, variantIds: [], newPerDay, priorNewPerDay: newPerDay * 0.85 })
    return {
      generatedAt: new Date().toISOString(), days,
      integrations: { shopify: { configured: true, store: 'serentia-demo.myshopify.com', sync: { lastRunAt: new Date().toISOString(), backfilled: true, orders: 3120, oldest: new Date(Date.now() - 120 * 86400e3).toISOString() } }, loop: { configured: true, subscriptions: 640 }, clickup: { configured: false }, zendrop: { configured: true } },
      fulfilment: {
        days, period: { orders: 412, units: 536, revenue: 24870, renewals: 131, newSubs: 64, fulfilledOfCreated: 371 }, prior: { orders: 358, units: 462 },
        inTransit: { count: 287, buckets: { '0-3 days': 96, '4-7 days': 112, '8-14 days': 61, '15+ days': 18 }, carriers: { 'USPS': 141, 'YunExpress': 88, 'UPS': 40, 'Unknown': 18 }, oldest: [{ name: '#SER2041', days: 23, status: 'IN_TRANSIT', carrier: 'YunExpress', tracking: 'YT25…', country: 'US' }, { name: '#SER2106', days: 19, status: 'IN_TRANSIT', carrier: 'USPS', country: 'US' }, { name: '#SER2133', days: 17, status: 'ATTEMPTED_DELIVERY', carrier: 'USPS', country: 'CA' }] },
        unfulfilled: { count: 54, units: 71, buckets: { '0-3 days': 41, '4-7 days': 9, '8-14 days': 3, '15+ days': 1 }, oldest: [{ name: '#SER2310', days: 16, status: 'UNFULFILLED', units: 2, financial: 'PAID' }, { name: '#SER2388', days: 9, status: 'ON_HOLD', units: 1, financial: 'PAID' }] },
        delivered: { count: 338, prior: 301 }, avgFulfilHours: 31.4, medFulfilHours: 26, priorAvgFulfilHours: 36.9, avgDeliveryDays: 8.7, medDeliveryDays: 8, priorAvgDeliveryDays: 9.4, avgDoorDays: 10.1, series,
      },
      runRate: { baselineDays: 14, newUnitsPerDay: 96, priorNewUnitsPerDay: 81, newOrdersPerDay: 74, unitsPerNewOrder: 1.3 },
      shades: [shade('Ivory', 2400, 18, 120), shade('Buff Beige', 1900, 24, 150), shade('Warm Honey', 2100, 22, 140), shade('Honey Almond', -15, 9, 60), shade('Caramel Glow', 700, 11, 70), shade('Deep Mocha', 900, 5, 30), shade('Hazelnut', 800, 7, 40)],
      stock: { source: 'zendrop', error: null, url: 'https://docs.google.com/spreadsheets/d/1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY/edit', countedAt: new Date().toISOString(), unmatched: [] },
      renewals: { source: 'loop', unmatched: 0, subscriptions: 640 },
      unmatchedDemand: [],
      demandError: null,
      ops: {
        zendrop: { sheetId: '1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY', tabs: [{ name: 'Fulfillment Issues', gid: '1279079658', open: 23, raised7: 9, resolved7: 12, oldestDays: 31, byTopic: { 'Stuck In Transit': 9, 'Unfulfilled': 7, 'Cancellation': 4, 'HOLD': 3 }, rowsSerentia: 40, skippedOther: 0, openRows: [{ order: '#SER70312', topic: 'Stuck In Transit', ageDays: 31 }, { order: '#SER71044', topic: 'Unfulfilled', ageDays: 12 }] }, { name: 'Zendrop Order Issues', gid: '124374285', open: 11, raised7: 4, resolved7: 6, oldestDays: 19, byTopic: { 'Incomplete Shipping Address': 8, 'Customer Phone Number Needed': 3 }, rowsSerentia: 17, skippedOther: 0, openRows: [{ order: '#SER70980', topic: 'Incomplete Shipping Address', ageDays: 19 }] }] },
        clickup: null,
      },
      settings: { stock_source: 'zendrop', zendrop_inventory_gid: null, zendrop_inventory_tab: 'Inventory', zendrop_inventory_products: ['3373424'], shades: ['Ivory', 'Buff Beige', 'Warm Honey', 'Honey Almond', 'Caramel Glow', 'Deep Mocha', 'Hazelnut'], lead_days: 10, safety_days: 7, moq_units: 2500, unit_cost: null, baseline_days: 14, bf_start: '2026-11-26', bf_end: '2026-12-01', bf_multiplier: 3, cover_until: '2026-12-31', clickup_lists: [], zendrop_sheet_id: '1gV5MPamT9f0AKpvVCSBevZpjlwSoKFkVbPTITUg7_kY' },
      settingsMeta: {},
    }
  }

  boot()
})()
