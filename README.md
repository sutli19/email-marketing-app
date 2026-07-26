# EmailFlow — Email Marketing App (take-home)

A cut-down Mailchimp: sign up, import contacts, group them into audiences,
send email campaigns (now or scheduled), and watch delivery/open analytics
tick up in real time.

- **Live app:** ``
- **Repo:** ``
- **Walkthrough Loom:** ``

---

## Stack

- **Frontend:** Next.js (App Router), plain fetch-based API client, polling for live analytics
- **Backend:** Express (kept fully separate from Next — no Next API routes)
- **Database:** Postgres, with hand-written SQL migrations (no ORM) and Row-Level Security
- **Queue:** Redis + BullMQ, for scheduled campaign sends
- **Email provider:** Brevo (transactional email + delivered/opened webhooks)
- **Monorepo:** npm workspaces — `apps/{web,api,worker}` + `packages/{db,shared}`

```
apps/
  web/      Next.js frontend
  api/      Express API (auth, contacts, audiences, campaigns, webhooks)
  worker/   BullMQ worker — actually dispatches scheduled/immediate campaign sends
packages/
  db/       Postgres connection helper, RLS session scoping, SQL migrations
  shared/   Types and constants shared across api/worker/web
infra/
  docker-compose.yml   Local Postgres + Redis
mock-data/
  contacts.csv         Sample import file with intentional duplicates
```

---

## What's implemented

**Auth & workspaces**
- Sign up / log in / log out, JWT session in an httpOnly cookie (`{ userId, accountId }`).
- Every account is isolated **at the database layer**, not just in the UI: every tenant
  table has Postgres Row-Level Security enforced with `FORCE ROW LEVEL SECURITY` against
  a dedicated non-owner `app_user` role, so a bug in a route handler can't leak another
  account's rows even if the app-level `WHERE account_id = ...` filter were ever missed.

**Contacts**
- Full CRUD, with arbitrary user-defined custom fields (JSONB) alongside name/email/phone.
- CSV import (`POST /api/contacts/import`), tested against `mock-data/contacts.csv`.
- Duplicate handling: normalizes email (lowercase/trim) and phone (digits-only) and merges
  into an existing contact rather than creating a copy, filling only previously-blank
  fields. The **same merge function** backs both manual "add contact" and CSV import, so
  the dedup rule can't drift between the two entry points. Import returns a plain-English
  summary (e.g. "5 added, 3 merged as duplicates, 1 skipped").

**Audiences**
- Named, saved groups of contacts filtered by tag / city / custom fields.
- Membership is evaluated live at read/send time (not a frozen snapshot), so member count
  and actual recipients always reflect the current contact list.

**Campaigns**
- Name + subject + HTML body.
- Two recipient-selection modes: pick an existing audience/tag, or paste a raw list of
  emails/phone numbers. Pasted entries are matched against saved contacts and shown with
  the matched name for a sanity check before sending; unmatched entries are flagged.
- Send now, or schedule for a future date/time — both go through the same
  `POST /:id/send` endpoint and the same BullMQ queue (no `setTimeout`, no interval
  polling a table). Jobs use a deterministic `jobId = campaignId`, so a schedule can be
  cleanly cancelled/removed and a job can't be double-queued for the same campaign.
- Scheduled sends survive a server restart: BullMQ jobs live in Redis, not in process
  memory, and the worker re-claims a campaign's `pending` recipients on each attempt
  rather than assuming it starts fresh.
- Sending is batched (100 recipients per transaction) so memory and per-query size stay
  bounded regardless of campaign size, and is idempotent across retries — a recipient
  already marked `sent` is never re-sent.

**Analytics**
- Per-campaign counts: total recipients, pending, sent, delivered, opened, plus
  delivery/open rates.
- Delivered/opened counts are driven **entirely by Brevo's webhook**
  (`POST /api/webhooks/brevo`), not guessed or polled from Brevo's API. The webhook:
  - verifies Brevo's HMAC signature before trusting anything in the payload,
  - logs every event (any type) to a `webhook_events` table for audit/idempotency,
  - ignores duplicate deliveries (Brevo retries on non-200) via a unique constraint,
  - only ever moves a recipient's status **forward** (`pending → sent → delivered →
    opened`), so an out-of-order or duplicate event can't regress it.
- The campaign detail page polls `GET /:id/analytics` every 5 seconds while a campaign is
  `sending`, `sent`, or `failed`, so counts visibly tick up without a manual refresh.

## Not built

- **Campaign duplication** (copy an existing campaign into a fresh draft) — listed as
  optional extra credit in the brief; skipped to keep the core flow solid within the
  time box. Would add a `POST /api/campaigns/:id/duplicate` that copies `name` (with a
  suffix), `subject`, `body_html`, and `selection_type`/`selection_value` into a new
  `draft` row, and stop there (deliberately *not* copying `campaign_recipients`, since
  a duplicate should re-resolve recipients fresh at its own send time).
- **PDF/file attachments on outgoing email** — also optional extra credit, not started.
  Brevo's transactional API supports base64 attachments directly, so the main work would
  be a file upload on the campaign form (multer, similar to the CSV importer) and passing
  the buffer through to `sendEmail()`.

---

## Running it locally

### Prerequisites
- Node.js 18+
- Docker (for local Postgres + Redis) — or point at your own instances
- A [Brevo](https://www.brevo.com) account with an API key and a verified sender email

### 1. Install and start infra

```bash
npm install
docker compose -f infra/docker-compose.yml up -d
```

### 2. Configure environment

Copy `.env.example` to the three places that need it and fill in real values:

```bash
cp .env.example packages/db/.env      # only needs MIGRATIONS_DATABASE_URL
cp .env.example apps/api/.env         # needs DATABASE_URL, REDIS_URL, JWT_SECRET, BREVO_*, FRONTEND_URL
cp .env.example apps/worker/.env      # needs DATABASE_URL, REDIS_URL, BREVO_*
```

`apps/web` needs its own `.env.local` (Next.js convention, not `.env`):

```bash
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > apps/web/.env.local
```

See the [environment variables](#environment-variables) table below for what each one does.

### 3. Run migrations

Migrations run against the Postgres **owner** connection (creates tables, the RLS
policies, and the restricted `app_user` role the app runs as afterward):

```bash
npm run migrate --workspace=packages/db
```

### 4. Start everything (three terminals)

```bash
npm run dev:api      # http://localhost:4000  — should return {"ok":true} at /health
npm run dev:worker   # processes the BullMQ campaign-send queue
npm run dev:web      # http://localhost:3000
```

### 5. Try it end-to-end

1. Sign up at `http://localhost:3000/signup`.
2. Import `mock-data/contacts.csv` on the Contacts page — note the duplicate-handling
   summary it returns.
3. Create an audience or tag, then a campaign.
4. **Testing sends and analytics:** Brevo's free tier only delivers to addresses you've
   explicitly verified as a recipient in the Brevo dashboard (Contacts → Settings, or
   under sandbox restrictions). Sending to the sample CSV's placeholder addresses will
   not produce delivered/opened events, since nothing real is being emailed. Use one or
   two real inboxes you control (verified in Brevo first) to see analytics tick up.
5. On the campaign detail page, watch the Analytics panel refresh every 5 seconds.

To roll back the most recent migration: `npm run migrate:down --workspace=packages/db`.

---

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `MIGRATIONS_DATABASE_URL` | `packages/db` (migrate script only) | Owner/DDL connection — creates tables, the `app_user` role, and RLS policies. Never used at runtime. |
| `DATABASE_URL` | api, worker | Runtime connection, **must** be the restricted `app_user` role created by migration `0005` — connecting as the table owner here would silently bypass Row-Level Security. |
| `REDIS_URL` | api, worker | BullMQ connection for the campaign-send queue. |
| `JWT_SECRET` | api | Signs the session cookie. Use a long random string; rotate before going to production. |
| `BREVO_API_KEY` | worker | Sends transactional email via Brevo. |
| `BREVO_FROM_EMAIL` | worker | Must be a sender address verified in your Brevo account. |
| `BREVO_FROM_NAME` | worker | Display name on outgoing email. |
| `BREVO_WEBHOOK_SIGNING_KEY` | api | Verifies the HMAC signature Brevo attaches to webhook payloads (Brevo dashboard → Sending → Webhooks → HTTP webhook signing key — a separate secret from the API key above). |
| `FRONTEND_URL` | api | Allowed CORS origin for the Next.js app (e.g. your deployed frontend URL in production). |
| `PORT` | api, worker | Defaults to `4000` if unset. |
| `NODE_ENV` | api | When `production`, marks the session cookie `secure`. |
| `NEXT_PUBLIC_API_URL` | web | Base URL the frontend calls for the API (set via `apps/web/.env.local`, not `.env`, per Next.js convention). |

No `.env` file is committed to this repo — see `.gitignore`. `.env.example` at the repo
root documents the shape above without real secrets.

---

## Design decisions & trade-offs

- **RLS as a backstop, not a replacement, for app-level scoping.** Every route still
  filters by `account_id` explicitly, but the Postgres policy (enforced even against the
  table owner via `FORCE ROW LEVEL SECURITY`) is what actually stops a missed `WHERE`
  clause from leaking data — this felt worth the setup cost given the brief specifically
  says cross-account access will be tested for.
- **Audiences are live queries, not frozen snapshots.** A contact deleted after an
  audience is created simply drops out of it at send time; this seemed like the more
  intuitive behavior than reconciling a stale snapshot.
- **Campaign recipients *are* snapshotted at send time**, deliberately unlike audiences —
  once a campaign is sent, its recipient list and per-recipient status are a historical
  record that shouldn't shift if the underlying audience changes afterward.
- **Plain SQL migrations, no ORM.** Chose this so the RLS role/permission setup — which
  is the fiddliest part of the whole app — stays fully visible and auditable rather than
  hidden behind ORM-generated migrations.
- **BullMQ job dispatch is separated from the API request that creates it.** The queue
  add happens after the DB transaction commits, with a compensating rollback
  (campaign reverted to `draft`, recipient snapshot deleted) if enqueueing fails — so a
  Redis hiccup can never leave a campaign stuck in `scheduled` with no job behind it.
- **Delivered/opened status is timestamp-driven (`delivered_at`/`opened_at`), not just a
  single `status` enum.** `status` is forward-only and stops representing "delivered" the
  moment a recipient goes on to open — so analytics counts read the timestamp columns
  directly instead of `status =`, avoiding an undercount.
- **Webhook events are logged unconditionally, matched opportunistically.** Every Brevo
  event (not just delivered/opened) is written to `webhook_events` for audit history,
  even if it doesn't map to a tracked recipient update — this keeps a full record without
  making unrelated event types (`clicked`, `unsubscribed`, etc.) silently disappear.

## Known limitations

- Open-tracking accuracy is inherently limited by the mail client — some clients block
  the tracking pixel outright, which the brief itself acknowledges shouldn't be held
  against this implementation.
- No automated test suite — verification so far has been manual, against a running
  Postgres instance and real HTTP requests (curl and the UI), rather than unit tests.