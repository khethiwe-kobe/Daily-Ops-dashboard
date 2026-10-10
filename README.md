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
