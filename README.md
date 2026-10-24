# Serentia Ops

Support command centre for Serentia. Next.js on Vercel, Postgres for state,
Re:amaze as the source of truth for tickets.

Migrated off the Higgsfield/Cloudflare build in August 2026 after the platform
withdrew its website builder, which locked the old deploy and left the board's
ticket file frozen for five days.

## Pages

| URL | What it is |
|---|---|
| `/support-ops` | The board. Every ticket, one click from its Re:amaze chat. |
| `/demo` | No-login demo of the board with sample data only (no real customer info, no credentials). Safe to share, e.g. to show the founder how it looks. |
| `/founder` | Founder review feed. Opened with `?key=<SYNC_KEY>`; no Re:amaze login needed. |
| `/feedback` | Customer feedback themes, praise, complaints, recommendations. |
| `/api/health` | Unauthenticated. Says whether the database is wired up. |
| `/vote` | Thornies Matric Dance 2026 voting page. Public; send this link to voters. |
| `/matric-dance` | Live results board for the dance. Needs the board's access key (or `SYNC_KEY`). |

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `POSTGRES_URL` | yes | Pooled connection string. Neon, Supabase and Vercel Postgres all work. |
| `SYNC_KEY` | yes | Long random string. Gates `/founder` and `/api/founder`. Also opens `/matric-dance`. |
| `PROM_VOTING_CLOSED` | no | Set to `1` to force matric dance voting closed, overriding the switch on the board. |

The board itself has no password. It is gated on the operator's own Re:amaze
credentials, which the browser holds and every API route re-verifies against
Re:amaze before touching the database. Revoking the Re:amaze token revokes
dashboard access with it.

## Matric dance voting

Two pages, one table (`prom_votes`, created on first use like the others).

- `/vote` is the link for voters. They type a name for Prom King and one for
  Prom Queen. The vote is anonymous: no IP, user agent or identity is stored,
  only the two names. The browser keeps a random token in `localStorage` so a
  second submit from the same phone *replaces* the earlier vote instead of
  adding one. It is a soft guard, not a login: a voter who clears site data
  can vote again.
- `/matric-dance` is the organisers' board. It refreshes every four seconds
  and shows both races, the current leader, and the vote count per name. It
  has its own access key, created once on first visit (or via
  `POST /api/prom/setup`) and stored hashed in `prom_settings`; `SYNC_KEY`
  opens it too. The key can be passed as `?key=`, which is moved into
  `sessionStorage` on load so the address bar can be shared on screen. The
  board has buttons to close or reopen voting, change the key, and reset all
  votes, so the night can be run from a phone with no Vercel access.

Names are matched tightly (`lib/names.js`): case, accents, punctuation and
spacing are ignored; one or two typos are forgiven on longer names but first
names must agree, so "Ava Naidoo" and "Eva Naidoo" stay separate; a lone first
name folds into the only full name that starts with it. Every spelling a
candidate absorbed is shown under their bar so the organiser can see exactly
what was merged. Close voting from the board, or set `PROM_VOTING_CLOSED=1`
to force it closed from the environment.

## First run

```bash
npm install
POSTGRES_URL=... npm run seed     # imports data/seed-status.json
```

`seed` is idempotent: statuses upsert, and thread messages are skipped if an
identical (slug, author, body) already exists, so re-running never duplicates.

## Daily refresh

`data/tickets.json` is the board's ticket list and is baked in at build time,
so refreshing it means committing and redeploying.

```bash
REAMAZE_EMAIL=... REAMAZE_TOKEN=... BOARD_URL=https://<this-deployment> \
  npm run refresh
git commit -am "Board refresh $(date -u +%F)" && git push
```

A ticket is **awaiting a reply** when the customer spoke last: Re:amaze status
0 (Open), 5 (On Hold) or 7 (AI assigned). Status 1 is *Responded* - we already
answered - and is deliberately excluded.

Tickets that already carry a board status are **kept** even once they leave the
fresh queue, so nothing worked on ever silently disappears.

## Things that will bite you

- **The Re:amaze `filter` query param is broken.** Every value returns the full
  conversation set. Always filter by `status` client-side.
- **Conversation status enum:** 0 Open, 1 Responded, 2 Done, 3 Spam,
  4 Archived, 5 On Hold, 6 Auto-Done, 7 AI Agent Assigned, 8 AI Agent Done,
  9 Spam (AI).
- **Slugs are derived from the subject line**, so they can exceed 200
  characters and can contain `$` and `.`. The validator allows up to 300 and a
  wider charset for exactly this reason.
- Re:amaze reads use the `.io` domain; credential checks use `.com`.

## Innaderm Ops dashboard (`/innaderm`)

Fulfilment, inventory and reorder decisions for Innaderm, built to Calvin's
12 October brief. Lives at `/innaderm` (static app in `public/innaderm`,
API under `app/api/innaderm/*`), and is meant to be opened inside ClickUp as an
Embed view: `next.config.mjs` sets `frame-ancestors` to allow `app.clickup.com`
on those paths only.

Access is by personal key. The first admin signs in with `INNADERM_ADMIN_KEY`
and issues keys to everyone else from Settings (gear icon). A login mints a
90-day session, so each person signs in once per device. Keys and sessions are
stored hashed in Postgres (`inn_*` tables, created on first use).

| Name | Required | Notes |
|---|---|---|
| `INNADERM_ADMIN_KEY` | yes | Long random string (12+ chars). Bootstrap admin key; shows in the key list once used. |
| `INNADERM_SHOPIFY_CLIENT_ID` | yes* | Client ID of a Shopify Dev Dashboard app installed on the Innaderm store with `read_orders`, `read_fulfillments`, `read_products`, `read_inventory`, `read_locations`. Access tokens are fetched with the client credentials grant (they last about 24h) and cached in `inn_cache`. |
| `INNADERM_SHOPIFY_CLIENT_SECRET` | yes* | Client secret of the same app. |
| `INNADERM_SHOPIFY_TOKEN` | no* | Alternative to the two above: a permanent `shpat_` token from a legacy custom app made in the store admin before 2026. Takes precedence when set. |
| `INNADERM_SHOPIFY_STORE` | no | Defaults to `f4f3a5-ad.myshopify.com` (innaderm.com). |
| `INNADERM_LOOP_TOKEN` | no | Loop Subscriptions admin API token (Loop admin > Settings > API Tokens). Without it renewals are estimated from recurring orders. |
| `INNADERM_CS_INGEST_KEY` | no | Shared secret for the support-Gmail Apps Script that feeds the CS metrics tab and the support board (and picks up Gmail drafts). |
| `INNADERM_CLICKUP_TOKEN` | no | ClickUp personal API token. Shows open Founder Escalations / Ops Overview tasks. |

Shopify history is synced into `inn_orders` (120-day backfill on first load,
incremental afterwards) so changing the period never re-pulls Shopify. Stock
counts, lead times and MOQs that no system holds are entered in Settings and
audited in `inn_events`. `/api/innaderm/health` (unauthenticated) says which
of the variables above are set (`shopifyAuth` names the Shopify method in use)
and whether the database answers. *Shopify needs either the client ID + secret
or the legacy token.
`/innaderm?demo=1` renders the layout with sample data and no secrets.

### Customer service tab (support Gmail)

Innaderm support runs on Gmail, not Re:amaze. `scripts/innaderm-gmail-sync.gs`
is a Google Apps Script that runs inside the support mailbox every 15 minutes
and posts thread metadata to `/api/innaderm/cs/ingest` (bearer
`INNADERM_CS_INGEST_KEY`): subject, message times and direction, the agent
name found in each reply's sign-off, and the first 500 characters of the
customer's first message (only used to pick the ticket type). Stored in
`inn_cs_threads` / `inn_cs_messages`; no full bodies. First run backfills 90 days.

Setup: set `INNADERM_CS_INGEST_KEY` in Vercel and redeploy; signed in as the
support Gmail, paste the script into script.google.com, fill in the key, run
`setup` once. The tab shows answered-within-target %, first and every-reply
response time (per agent), tickets by type with spike flags, ageing buckets of
tickets waiting on us, automation candidates, and chargeback / reaction risk.
Ticket types are keyword rules in `lib/innaderm/cs.js`; after changing them,
`POST /api/innaderm/cs/reclassify` (admin) re-sorts stored tickets.
`/innaderm?demo=1&tab=cs` shows the tab with sample data.

### Support board (work the Innaderm inbox)

`/innaderm?tab=board`. The Serentia board's working view for the support Gmail.
Every open ticket grouped by type, risky ones (dispute, legal, reaction) first,
then oldest. Queues: Needs reply, They replied, With Calvin, Drafted, Waiting on
customer, All open, Done. Each ticket shows the customer's latest message, their
Shopify orders (by #INN number, else by email, live; VIP = 2+ orders or $100+),
status, type correction, an internal note, and a reply composer.

- **Replies** come from templates (`inn_cs_templates`, seeded from
  `DEFAULT_TEMPLATES` in `lib/innaderm/csboard.js`, editable by admins on the
  Templates tab). `{first_name}`, `{order_status}` (shipped / tracking /
  delivered / not yet shipped, from Shopify), `{order_number}`,
  `{order_or_ask}`, `{discount_code}`, `{agent}` fill in; `[CAPITALS]` must be
  replaced by the agent. Signed with the agent's own name ("Signing as").
- **Put in Gmail as draft** queues the reply (`inn_cs_drafts`); the Apps
  Script (every 5 min) creates it as a draft reply in the thread, so the agent
  checks it in Gmail and presses Send.
- **Send to Calvin** creates a task in ClickUp Founder Escalations (assigned to
  Calvin, tag `innaderm`, `innaderm-thread:` line, custom fields filled).
  Status and Calvin's comments show back on the ticket. Needs
  `INNADERM_CLICKUP_TOKEN`.
- **Automations** tab: each ticket type moves Manual -> Approved template ->
  Auto-drafted in Gmail -> (Auto-send, not yet). Auto-drafted types get a filled
  draft queued as soon as a new customer message is ingested, using the type's
  approved template; never for flagged tickets, adverse reactions or disputes,
  and never while a `[PLACEHOLDER]` is left. Hours saved are estimated from
  tickets per week x `cs_minutes_per_ticket` x the stage's saving share.

Updating the Apps Script: paste the new `scripts/innaderm-gmail-sync.gs` over
the old one (keep the key) and run `upgrade` once.

### Refund log (Google Sheet)

The same Apps Script keeps a Google Sheet, "Innaderm refund log (auto)", of
every refund, cancellation, return and dispute conversation with the full text
of the customer's messages and our replies. It is the history the refund
decision automation learns from (what was asked, what was decided, by whom).
Unlike the dashboard tables, it holds full bodies, so share it only with the
team.

- **Threads** tab: one row per conversation, updated as it continues. Orders
  (#INN numbers found in the thread), what it is about (refund / chargeback /
  cancel / return), the customer's first and latest message, all our replies
  dated and signed, and who it is waiting on.
- **Messages** tab: one row per message, appended once.

Setup, once, in the support mailbox's Apps Script project after pasting the new
code: run `setupRefundLog` and approve the Sheets permission. It creates the
Sheet (owned by the support account, shared view-only with
`REFUND_LOG_SHARE_WITH`), backfills `REFUND_LOG_BACKFILL_DAYS` (365) over the
next hours, then updates hourly. The Sheet link is in the run's log and in
Script Properties as `refundLogSheetId`. Gmail finds candidates with
`REFUND_SEARCH`; `REFUND_WORDS` then checks the customer's own words, so
newsletters, Shopify notifications and "returning customer" are left out.
