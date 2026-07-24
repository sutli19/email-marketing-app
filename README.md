# Email Marketing App

Monorepo for the email marketing take-home. See `/architecture-plan.md`-style
notes below for the reasoning; this README covers what's built so far and
how to run it.

## Phase 1 — done

- Monorepo scaffold (`apps/{web,api,worker}`, `packages/{db,shared}`).
- Postgres schema + migrations (`packages/db/migrations`): accounts, users,
  contacts (with generated `normalized_phone` + partial unique indexes for
  dedup), tags, contact_tags, audiences, campaigns, campaign_recipients,
  webhook_events.
- Row-Level Security on every tenant table, **enforced with `FORCE ROW
  LEVEL SECURITY`** and a dedicated non-owner `app_user` Postgres role —
  this matters because superusers and table owners silently bypass RLS
  otherwise, which would make the policies decorative. Verified manually:
  cross-account reads return zero rows, cross-account inserts are rejected
  by the `WITH CHECK` clause, and a missing session variable fails closed
  (returns nothing) rather than open (returns everything).
- Simple up/down SQL migration runner (no ORM) with a `schema_migrations`
  tracking table.
- `docker-compose.yml` for local Postgres + Redis.

## Phase 2 — done

- Express API (`apps/api`) with auth, contacts CRUD, and CSV import.
- **Auth:** `POST /api/auth/signup` (creates account + user), `login`,
  `logout`, `GET /api/auth/me`. Sessions are a JWT in an httpOnly cookie
  containing `{ userId, accountId }` — this is the *only* place
  `accountId` is derived anywhere in the app; no route trusts a
  client-sent account id.
- **Contacts:** full CRUD at `/api/contacts`, all routes behind
  `requireAuth` and scoped through `withAccountScope()` (app-level filter
  + Postgres RLS together). Listing supports `?city=`, `?tagId=`,
  `?search=`.
- **Dedup**, used identically for manual add and CSV import: normalize
  email (lowercase/trim) and phone (digits only), then merge into an
  existing contact (filling only blank fields) instead of creating a
  duplicate. Manual add and CSV rows share the exact same merge function.
- **CSV import** (`POST /api/contacts/import`, multipart field `file`):
  parses headers flexibly (email/phone/first name/last name/city
  recognized in a few common spellings, everything else becomes a custom
  field), dedupes *within the uploaded file* first, then merges/inserts
  against existing contacts. Returns a summary:
  `{ added, merged, skippedInvalid, message }`.
- `mock-data/contacts.csv` — a sample file with intentional duplicate
  emails/phones (case-variant email, matching phone numbers, one row with
  neither) for exercising the importer.

**Verified against a running Postgres + live HTTP requests, not just unit
logic:** signup/login/session cookie flow; manual-add dedup (adding the
same email with different casing merges into one contact); CSV import on
the sample file produces `added: 5, merged: 3, skippedInvalid: 1` (matches
hand-counting the file); and — the important one — a second account
signed up fresh sees an empty contact list, and direct DELETE/PUT requests
against the first account's contact id both 404 without touching the row,
confirmed via `curl` against the real running server, not assumed from
the RLS policy alone.

## Not built yet

Audiences, campaigns, BullMQ queues, Mailgun integration, tags CRUD, the
Next.js frontend.

## Running phase 1 + 2 locally

```bash
# 1. start postgres + redis
docker compose -f infra/docker-compose.yml up -d

# 2. install deps
npm install

# 3. copy env and fill in MIGRATIONS_DATABASE_URL (matches docker-compose
#    creds: postgres://app:app@localhost:5432/email_app)
cp .env.example packages/db/.env

# 4. run migrations — this also creates the app_user role used at runtime
npm run db:migrate

# 5. set up the API's env (DATABASE_URL here should be the app_user
#    credentials, NOT the migration owner — see .env.example)
cp .env.example apps/api/.env   # then edit DATABASE_URL/JWT_SECRET as needed

# 6. run the API
npm run dev:api
# -> http://localhost:4000/health should return {"ok":true}
```

Try it:
```bash
curl -c cookies.txt -X POST http://localhost:4000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"accountName":"Acme","email":"you@acme.com","password":"password123"}'

curl -b cookies.txt -X POST http://localhost:4000/api/contacts/import \
  -F "file=@mock-data/contacts.csv"

curl -b cookies.txt http://localhost:4000/api/contacts
```

To roll back the most recent migration: `npm run db:migrate:down`.

## Design decisions / trade-offs so far

- **RLS + app-level scoping, not just one.** App code will always filter
  by `account_id`, but the DB-level policy is the backstop the assignment
  specifically calls out ("we will try to reach across accounts").
- **Audiences are live, not snapshots.** `audiences.filter` is a JSON
  criteria blob evaluated at read/send time, so the member count and the
  actual recipient list always reflect current contacts. Trade-off: if a
  contact is deleted between "create campaign" and "send," they simply
  drop out, which seems like the right behavior here.
- **Plain SQL migrations instead of an ORM.** Chose this mainly so the RLS
  role/permission setup (which is genuinely fiddly) is fully visible and
  auditable rather than hidden behind ORM migration generation.
- **Dedup keys off normalized values** (`lower(email)`, digits-only phone)
  via a generated column + partial unique indexes, so it's enforced at the
  DB level, not just in application code paths that might get bypassed.
- **Manual add and CSV import share one merge function**
  (`applyContactsImport`), called with an array of 1 for manual add. This
  guarantees the assignment's requirement — "the same duplicate check
  should apply when someone adds a contact by hand" — by construction
  rather than by keeping two implementations in sync.
- **CSV within-file dedup uses a linear scan**, not a hash-map, so it can
  match a row against an already-merged canonical row by either email or
  phone (handles A/B/C chains where row A matches row B by phone and row
  B matches row C by email). Fine at CSV-import scale; would need
  revisiting for files with tens of thousands of rows.
