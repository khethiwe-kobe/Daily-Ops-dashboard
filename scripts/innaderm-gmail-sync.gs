/**
 * Innaderm support inbox -> Ops dashboard (Customer service tab).
 *
 * Runs inside the support Gmail account as a Google Apps Script. Every 5
 * minutes it:
 *   - reads threads with new activity and posts them to the dashboard: subject,
 *     the customer's name and address, who wrote each message and when, which
 *     agent signed each reply, the start of the customer's first message (to
 *     sort the ticket into a type) and their latest message (so the support
 *     board can show it). No attachments.
 *   - turns replies queued on the support board into Gmail drafts in the right
 *     thread, so an agent only has to check and press Send.
 *
 * Separately, every hour, exportRefunds() copies refund / cancellation /
 * dispute threads in full into a Google Sheet (see "Refund log" at the end).
 *
 * Setup (once, signed in to the support Gmail account):
 *   1. Go to https://script.google.com -> New project. Name it "Innaderm CS sync".
 *   2. Delete the sample code, paste this whole file, and fill in DASHBOARD_URL
 *      and INGEST_KEY below (INGEST_KEY = the INNADERM_CS_INGEST_KEY value you
 *      set in Vercel).
 *   3. Pick "setup" in the function menu at the top and press Run. Approve the
 *      Gmail permission prompt. It installs the 5-minute trigger and starts
 *      the 90-day backfill, which finishes on its own over the next hour or so.
 *   4. View -> Executions shows each run and any errors.
 *
 * Updating an existing install (keeps the sync position): paste the new code
 * over the old, keep your INGEST_KEY, then run "upgrade" once.
 */

const DASHBOARD_URL = 'https://daily-ops-dashboard-eight.vercel.app'
const INGEST_KEY = 'PASTE_INNADERM_CS_INGEST_KEY_HERE'

// Names the agents sign replies with. The first one found near the end of a
// reply is credited with it (this is how response time is split per person).
const AGENTS = ['Kashif', 'Khethiwe', 'Calvin']

// Senders that are never customers: platform notifications, bounces, our own
// tools. Threads with only these as senders are ignored.
const SYSTEM_SENDERS = /(^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|notify|alerts?|bounces?|calendar-notification)[@+.])|@([a-z0-9-]+\.)*(shopify|zendrop|paypal|stripe|klaviyo|loopsubscriptions|loopwork|google|facebookmail|clickup|trustpilot)\.(com|co|io)$/i

const BACKFILL_DAYS = 90
const BATCH = 40                 // threads per POST
const TIME_BUDGET_MS = 4.5 * 60e3

function setup() {
  if (INGEST_KEY.indexOf('PASTE_') === 0) throw new Error('Fill in INGEST_KEY at the top of the script first.')
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t) })
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(5).create()
  const props = PropertiesService.getScriptProperties()
  props.deleteAllProperties()
  props.setProperty('backfillStart', '0')
  props.setProperty('backfillSince', String(Math.floor((Date.now() - BACKFILL_DAYS * 86400e3) / 1000)))
  sync()
}

// Re-installs the trigger without restarting the backfill.
function upgrade() {
  if (INGEST_KEY.indexOf('PASTE_') === 0) throw new Error('Fill in INGEST_KEY at the top of the script first.')
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t) })
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(5).create()
  const props = PropertiesService.getScriptProperties()
  // Re-send the last 3 days so open tickets pick up names and latest messages.
  props.setProperty('lastRun', String(Math.floor((Date.now() - 3 * 86400e3) / 1000)))
  sync()
}

function sync() {
  const started = Date.now()
  makeDrafts()
  const props = PropertiesService.getScriptProperties()
  const me = Session.getEffectiveUser().getEmail().toLowerCase()
  const team = [me].concat(GmailApp.getAliases().map(function (a) { return a.toLowerCase() }))

  // 1) New activity since the last run (with an hour of overlap).
  const lastRun = Number(props.getProperty('lastRun') || 0)
  const runStartedSec = Math.floor(started / 1000)
  if (lastRun) {
    const since = lastRun - 3600
    let start = 0
    while (Date.now() - started < TIME_BUDGET_MS / 2) {
      const threads = GmailApp.search('-in:spam -in:trash -in:drafts after:' + since, start, 100)
      if (!threads.length) break
      post(threads.map(function (t) { return pack(t, team) }).filter(Boolean), me, false, false)
      if (threads.length < 100) break
      start += 100
    }
  }
  props.setProperty('lastRun', String(runStartedSec))

  // 2) Backfill, 100 threads at a time, until done.
  const bfStart = props.getProperty('backfillStart')
  if (bfStart !== null && bfStart !== 'done') {
    let start = Number(bfStart)
    const since = props.getProperty('backfillSince')
    while (Date.now() - started < TIME_BUDGET_MS) {
      const threads = GmailApp.search('-in:spam -in:trash -in:drafts after:' + since, start, 100)
      const packed = threads.map(function (t) { return pack(t, team) }).filter(Boolean)
      const done = threads.length < 100
      post(packed, me, done, true)
      start += threads.length
      props.setProperty('backfillStart', done ? 'done' : String(start))
      if (done) break
    }
  }
}

function pack(thread, team) {
  const messages = []
  let customer = null, customerName = '', excerpt = '', lastExcerpt = '', hasCustomer = false
  thread.getMessages().forEach(function (m) {
    if (m.isDraft()) return
    const from = addr(m.getFrom())
    const isTeam = team.indexOf(from) !== -1
    if (!isTeam && SYSTEM_SENDERS.test(from)) return
    const msg = { id: m.getId(), at: m.getDate().toISOString(), dir: isTeam ? 'out' : 'in', agent: null }
    if (isTeam) {
      msg.agent = agentOf(m.getPlainBody())
    } else {
      hasCustomer = true
      const body = m.getPlainBody()
      if (!customer) { customer = from; customerName = displayName(m.getFrom()); excerpt = firstLines(body) }
      lastExcerpt = ownText(body).slice(0, 2000)
    }
    messages.push(msg)
  })
  if (!hasCustomer) return null
  return { id: thread.getId(), subject: thread.getFirstMessageSubject(), inInbox: thread.isInInbox(), customer: customer, customerName: customerName, excerpt: excerpt, lastExcerpt: lastExcerpt, messages: messages }
}

function post(threads, mailbox, backfillDone, backfill) {
  for (let i = 0; i < threads.length || (i === 0 && backfillDone); i += BATCH) {
    const res = UrlFetchApp.fetch(DASHBOARD_URL + '/api/innaderm/cs/ingest', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + INGEST_KEY },
      payload: JSON.stringify({ mailbox: mailbox, threads: threads.slice(i, i + BATCH), backfill: !!backfill, backfillDone: backfillDone && i + BATCH >= threads.length }),
      muteHttpExceptions: true,
    })
    if (res.getResponseCode() !== 200) throw new Error('Dashboard said ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200))
    if (!threads.length) break
  }
}

// Replies queued on the support board become drafts in their Gmail thread,
// addressed to the customer's latest message.
function makeDrafts() {
  const res = UrlFetchApp.fetch(DASHBOARD_URL + '/api/innaderm/cs/drafts', { headers: { Authorization: 'Bearer ' + INGEST_KEY }, muteHttpExceptions: true })
  if (res.getResponseCode() !== 200) return
  const queue = JSON.parse(res.getContentText()).drafts || []
  if (!queue.length) return
  const me = Session.getEffectiveUser().getEmail().toLowerCase()
  const team = [me].concat(GmailApp.getAliases().map(function (a) { return a.toLowerCase() }))
  const results = queue.map(function (d) {
    try {
      const thread = GmailApp.getThreadById(d.threadId)
      if (!thread) return { id: d.id, ok: false, error: 'thread not found' }
      const msgs = thread.getMessages().filter(function (m) { return !m.isDraft() && team.indexOf(addr(m.getFrom())) === -1 })
      if (!msgs.length) return { id: d.id, ok: false, error: 'no customer message in thread' }
      const draft = msgs[msgs.length - 1].createDraftReply(d.body)
      return { id: d.id, ok: true, draftId: draft.getId() }
    } catch (e) {
      return { id: d.id, ok: false, error: String(e && e.message || e) }
    }
  })
  UrlFetchApp.fetch(DASHBOARD_URL + '/api/innaderm/cs/drafts', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + INGEST_KEY },
    payload: JSON.stringify({ results: results }), muteHttpExceptions: true,
  })
}

function displayName(from) {
  const m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*</)
  return m ? m[1].trim() : ''
}

// The customer's own words in a message: quoted history cut off.
function ownText(body) {
  return firstLinesRaw(body).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function addr(from) {
  const m = String(from || '').match(/<([^>]+)>/)
  return (m ? m[1] : String(from || '')).trim().toLowerCase()
}

// Customer text without quoted history, signatures cut short.
function firstLines(body) {
  const lines = String(body || '').split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*>/.test(l) || /^On .+wrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From:\s/.test(l)) break
    out.push(l)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500)
}

// The agent's name in the sign-off (last 600 characters of their own text).
function agentOf(body) {
  const own = firstLinesRaw(body).slice(-600)
  for (let i = 0; i < AGENTS.length; i++) {
    if (new RegExp('\\b' + AGENTS[i] + '\\b', 'i').test(own)) return AGENTS[i]
  }
  return null
}
function firstLinesRaw(body) {
  const lines = String(body || '').split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*>/.test(lines[i]) || /^On .+wrote:\s*$/.test(lines[i])) break
    // Gmail wraps long "On <date> <name> <email> wrote:" lines in two.
    if (/^On .+/.test(lines[i]) && /wrote:\s*$/.test(lines[i + 1] || '') && lines[i].length + lines[i + 1].length < 200) break
    out.push(lines[i])
  }
  return out.join('\n')
}

/* ===========================================================================
 * Refund log -> Google Sheet
 *
 * Copies every refund / cancellation / dispute thread, with the full text of
 * the customer's messages AND our replies (Calvin's, Kashif's, Khethiwe's),
 * into a Google Sheet. That history is what the refund decision automation
 * learns from: what was asked, what we answered, who decided.
 *
 * The Sheet is created by this script inside the support account and shared
 * with the people in REFUND_LOG_SHARE_WITH (view only). Two tabs:
 *   Threads  - one row per thread, updated in place as it continues
 *   Messages - one row per message, appended once (never edited)
 *
 * Setup (once, after the code above is installed): pick "setupRefundLog" in
 * the function menu and press Run. Approve the new Sheets permission. It
 * creates the Sheet, installs an hourly trigger and starts a
 * REFUND_LOG_BACKFILL_DAYS backfill that finishes on its own. The Sheet's
 * link is printed in View -> Executions -> the run's log, and is in
 * Project Settings -> Script Properties as refundLogSheetId.
 * ======================================================================== */

const REFUND_LOG_SHARE_WITH = ['khethiwe@serentia-shop.com']
const REFUND_LOG_BACKFILL_DAYS = 365
const REFUND_LOG_NAME = 'Innaderm refund log (auto)'

// Gmail search for candidate threads, then REFUND_WORDS decides for real on
// the customers' own text, so a newsletter footer saying "returns" is not a
// refund ticket.
const REFUND_SEARCH = '(refund OR refunds OR refunded OR reimburse OR reimbursement OR "money back" OR chargeback OR dispute OR disputed OR cancel OR cancelled OR canceled OR cancellation OR return OR returned OR unsubscribe) -in:spam -in:trash -in:drafts'
const REFUND_WORDS = [
  ['refund', /refund|reimburs|money back|my money/i],
  ['chargeback', /chargeback|charge back|dispute|my bank|credit card company|paypal claim/i],
  ['cancel', /cancel|stop (my |the )?(subscription|order|charging)|unsubscribe from (the )?subscription/i],
  ['return', /\breturn(ing)? (it|this|them|the|my|an?)\b|send (it|this|them) back|\breturn label/i],
]

const THREAD_HEADERS = ['Thread ID', 'Open in Gmail', 'First contact', 'Last activity', 'Customer', 'Email', 'Orders',
  'Subject', 'About', 'Customer asked (first message)', 'Customer latest', 'Our replies (oldest first)',
  'Replied by', 'Waiting on', 'Messages', 'Logged']
const MESSAGE_HEADERS = ['Message ID', 'Thread ID', 'Date', 'Direction', 'From', 'Agent', 'Text']
const CELL_MAX = 45000           // Sheets caps a cell at 50,000 characters
const MSG_MAX = 8000

function setupRefundLog() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'exportRefunds') ScriptApp.deleteTrigger(t) })
  ScriptApp.newTrigger('exportRefunds').timeBased().everyHours(1).create()
  const props = PropertiesService.getScriptProperties()
  props.setProperty('refundBackfillStart', '0')
  props.setProperty('refundBackfillSince', String(Math.floor((Date.now() - REFUND_LOG_BACKFILL_DAYS * 86400e3) / 1000)))
  const ss = refundSheet()
  Logger.log('Refund log: ' + ss.getUrl())
  exportRefunds()
}

function exportRefunds() {
  const started = Date.now()
  const lock = LockService.getScriptLock()
  if (!lock.tryLock(1000)) return  // previous run still going
  try {
    const props = PropertiesService.getScriptProperties()
    const me = Session.getEffectiveUser().getEmail().toLowerCase()
    const team = [me].concat(GmailApp.getAliases().map(function (a) { return a.toLowerCase() }))
    const ss = refundSheet()
    const log = new RefundLog(ss)

    // 1) Threads with new activity since the last run (an hour of overlap).
    const last = Number(props.getProperty('refundLastRun') || 0)
    const runStartedSec = Math.floor(started / 1000)
    if (last) {
      let start = 0
      while (Date.now() - started < TIME_BUDGET_MS / 2) {
        const threads = GmailApp.search(REFUND_SEARCH + ' after:' + (last - 3600), start, 100)
        threads.forEach(function (t) { log.put(refundRow(t, team, me)) })
        if (threads.length < 100) break
        start += 100
      }
    }
    props.setProperty('refundLastRun', String(runStartedSec))

    // 2) Backfill, 50 threads at a time, until done.
    const bf = props.getProperty('refundBackfillStart')
    if (bf !== null && bf !== 'done') {
      let start = Number(bf)
      const since = props.getProperty('refundBackfillSince')
      while (Date.now() - started < TIME_BUDGET_MS) {
        const threads = GmailApp.search(REFUND_SEARCH + ' after:' + since, start, 50)
        threads.forEach(function (t) { log.put(refundRow(t, team, me)) })
        start += threads.length
        const done = threads.length < 50
        log.flush()
        props.setProperty('refundBackfillStart', done ? 'done' : String(start))
        if (done) break
      }
    }
    log.flush()
  } finally {
    lock.releaseLock()
  }
}

function refundSheet() {
  const props = PropertiesService.getScriptProperties()
  const id = props.getProperty('refundLogSheetId')
  if (id) return SpreadsheetApp.openById(id)
  const ss = SpreadsheetApp.create(REFUND_LOG_NAME)
  const threads = ss.getSheets()[0].setName('Threads')
  threads.appendRow(THREAD_HEADERS).setFrozenRows(1)
  const messages = ss.insertSheet('Messages')
  messages.appendRow(MESSAGE_HEADERS).setFrozenRows(1)
  ;[threads, messages].forEach(function (s) { s.getRange(1, 1, 1, s.getLastColumn()).setFontWeight('bold') })
  REFUND_LOG_SHARE_WITH.forEach(function (email) { try { ss.addViewer(email) } catch (e) { Logger.log('Could not share with ' + email + ': ' + e) } })
  props.setProperty('refundLogSheetId', ss.getId())
  return ss
}

// Builds the Threads row and the Messages rows for one Gmail thread, or null
// if it is not a customer refund/cancel/dispute conversation.
function refundRow(thread, team, me) {
  const msgs = []
  let customer = '', customerName = '', firstAsk = '', latest = '', about = {}, replies = [], agents = {}
  let lastDir = null
  const orders = {}
  const subject = thread.getFirstMessageSubject() || ''
  ;(subject.match(/INN\s?\d{4,6}/gi) || []).forEach(function (o) { orders['#' + o.replace(/\s/g, '').toUpperCase()] = 1 })

  thread.getMessages().forEach(function (m) {
    if (m.isDraft()) return
    const from = addr(m.getFrom())
    const isTeam = team.indexOf(from) !== -1
    if (!isTeam && SYSTEM_SENDERS.test(from)) return
    const text = ownText(m.getPlainBody()).slice(0, MSG_MAX)
    ;(text.match(/INN\s?\d{4,6}/gi) || []).forEach(function (o) { orders['#' + o.replace(/\s/g, '').toUpperCase()] = 1 })
    const at = m.getDate()
    let agent = ''
    if (isTeam) {
      agent = agentOf(m.getPlainBody()) || ''
      if (agent) agents[agent] = 1
      replies.push('[' + Utilities.formatDate(at, 'UTC', 'yyyy-MM-dd') + (agent ? ' ' + agent : '') + ']\n' + text)
    } else {
      if (!customer) { customer = from; customerName = displayName(m.getFrom()); firstAsk = text }
      latest = text
      REFUND_WORDS.forEach(function (w) { if (w[1].test(text) || w[1].test(subject)) about[w[0]] = 1 })
    }
    lastDir = isTeam ? 'out' : 'in'
    msgs.push([m.getId(), thread.getId(), at, isTeam ? 'Us' : 'Customer', from, agent, text])
  })

  if (!customer || !Object.keys(about).length) return null
  const first = msgs[0][2], lastAt = msgs[msgs.length - 1][2]
  const link = 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(me) + '#all/' + thread.getId()
  return {
    id: thread.getId(),
    row: [thread.getId(), link, first, lastAt, customerName, customer, Object.keys(orders).join(' '),
      subject, Object.keys(about).join(', '), firstAsk.slice(0, CELL_MAX), latest.slice(0, CELL_MAX),
      replies.join('\n\n').slice(0, CELL_MAX), Object.keys(agents).join(', '),
      lastDir === 'in' ? 'Us' : 'Customer', msgs.length, new Date()],
    messages: msgs,
  }
}

// Buffers writes so a run does a handful of Sheet calls, not one per thread.
function RefundLog(ss) {
  this.threads = ss.getSheetByName('Threads')
  this.messages = ss.getSheetByName('Messages')
  this.rowOf = {}
  const n = this.threads.getLastRow()
  if (n > 1) this.threads.getRange(2, 1, n - 1, 1).getValues().forEach(function (r, i) { this.rowOf[r[0]] = i + 2 }, this)
  this.seen = {}
  const m = this.messages.getLastRow()
  if (m > 1) this.messages.getRange(2, 1, m - 1, 1).getValues().forEach(function (r) { this.seen[r[0]] = 1 }, this)
  this.updates = []
  this.appends = []
  this.newMessages = []
}
RefundLog.prototype.put = function (rec) {
  if (!rec) return
  if (this.rowOf[rec.id] > 0) this.updates.push([this.rowOf[rec.id], rec.row])
  else this.appends.push(rec.row)  // flush keeps the latest row per thread
  rec.messages.forEach(function (msg) {
    if (this.seen[msg[0]]) return
    this.seen[msg[0]] = 1
    this.newMessages.push(msg)
  }, this)
}
RefundLog.prototype.flush = function () {
  const width = THREAD_HEADERS.length
  // A thread seen twice in one run (search overlap) keeps its latest row only.
  const latest = {}
  this.appends.forEach(function (r) { latest[r[0]] = r })
  const appends = Object.keys(latest).map(function (k) { return latest[k] })
  this.updates.forEach(function (u) { this.threads.getRange(u[0], 1, 1, width).setValues([u[1]]) }, this)
  if (appends.length) {
    const startRow = this.threads.getLastRow() + 1
    this.threads.getRange(startRow, 1, appends.length, width).setValues(appends)
    appends.forEach(function (r, i) { this.rowOf[r[0]] = startRow + i }, this)
  }
  if (this.newMessages.length) {
    this.messages.getRange(this.messages.getLastRow() + 1, 1, this.newMessages.length, MESSAGE_HEADERS.length).setValues(this.newMessages)
  }
  this.updates = []; this.appends = []; this.newMessages = []
}
