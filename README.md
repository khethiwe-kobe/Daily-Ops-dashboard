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

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `POSTGRES_URL` | yes | Pooled connection string. Neon, Supabase and Vercel Postgres all work. |
| `SYNC_KEY` | yes | Long random string. Gates `/founder` and `/api/founder`. |

The board itself has no password. It is gated on the operator's own Re:amaze
credentials, which the browser holds and every API route re-verifies against
Re:amaze before touching the database. Revoking the Re:amaze token revokes
dashboard access with it.

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
