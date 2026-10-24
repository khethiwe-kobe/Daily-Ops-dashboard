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
    out.push(lines[i])
  }
  return out.join('\n')
}
