/**
 * Innaderm support inbox -> Ops dashboard (Customer service tab).
 *
 * Runs inside the support Gmail account as a Google Apps Script. Every 15
 * minutes it reads threads with new activity and posts their metadata to the
 * dashboard: subject, who wrote each message and when, which agent signed each
 * reply, and the first 500 characters of the customer's first message (used
 * only to sort the ticket into a category). No attachments, no full bodies.
 *
 * Setup (once, signed in to the support Gmail account):
 *   1. Go to https://script.google.com -> New project. Name it "Innaderm CS sync".
 *   2. Delete the sample code, paste this whole file, and fill in DASHBOARD_URL
 *      and INGEST_KEY below (INGEST_KEY = the INNADERM_CS_INGEST_KEY value you
 *      set in Vercel).
 *   3. Pick "setup" in the function menu at the top and press Run. Approve the
 *      Gmail permission prompt. It installs the 15-minute trigger and starts
 *      the 90-day backfill, which finishes on its own over the next hour or so.
 *   4. View -> Executions shows each run and any errors.
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
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(15).create()
  const props = PropertiesService.getScriptProperties()
  props.deleteAllProperties()
  props.setProperty('backfillStart', '0')
  props.setProperty('backfillSince', String(Math.floor((Date.now() - BACKFILL_DAYS * 86400e3) / 1000)))
  sync()
}

function sync() {
  const started = Date.now()
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
      post(threads.map(function (t) { return pack(t, team) }).filter(Boolean), me, false)
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
      post(packed, me, done)
      start += threads.length
      props.setProperty('backfillStart', done ? 'done' : String(start))
      if (done) break
    }
  }
}

function pack(thread, team) {
  const messages = []
  let customer = null, excerpt = '', hasCustomer = false
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
      if (!customer) { customer = from; excerpt = firstLines(m.getPlainBody()) }
    }
    messages.push(msg)
  })
  if (!hasCustomer) return null
  return { id: thread.getId(), subject: thread.getFirstMessageSubject(), inInbox: thread.isInInbox(), customer: customer, excerpt: excerpt, messages: messages }
}

function post(threads, mailbox, backfillDone) {
  for (let i = 0; i < threads.length || (i === 0 && backfillDone); i += BATCH) {
    const res = UrlFetchApp.fetch(DASHBOARD_URL + '/api/innaderm/cs/ingest', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + INGEST_KEY },
      payload: JSON.stringify({ mailbox: mailbox, threads: threads.slice(i, i + BATCH), backfillDone: backfillDone && i + BATCH >= threads.length }),
      muteHttpExceptions: true,
    })
    if (res.getResponseCode() !== 200) throw new Error('Dashboard said ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200))
    if (!threads.length) break
  }
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
