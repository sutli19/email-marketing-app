-- DB-level backstop for multi-tenancy. The API always scopes queries by
-- account_id in application code, but these policies mean that even a
-- forgotten WHERE clause cannot leak another account's rows.
--
-- Application code must run these tables' queries via withAccountScope()
-- (see packages/db/src/index.ts), which does:
--   SELECT set_config('app.current_account_id', $accountId, true)
-- inside the same transaction as the query.
--
-- A missing/invalid setting evaluates to NULL, which matches nothing,
-- so the safe failure mode is "returns zero rows", not "returns everything".

-- IMPORTANT: Postgres superusers AND table owners bypass RLS by default,
-- regardless of policies below. Since migrations run as the owning role,
-- ENABLE ROW LEVEL SECURITY alone is not enough — we also need
-- FORCE ROW LEVEL SECURITY so the policies apply even to the owner, and
-- the application must connect as a separate, non-owner, non-superuser
-- role (created below) for these policies to actually do anything.

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE audiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;

ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
ALTER TABLE contact_tags FORCE ROW LEVEL SECURITY;
ALTER TABLE audiences FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contacts
  USING (account_id = current_setting('app.current_account_id', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account_id', true)::uuid);

CREATE POLICY tenant_isolation ON tags
  USING (account_id = current_setting('app.current_account_id', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account_id', true)::uuid);

CREATE POLICY tenant_isolation ON contact_tags
  USING (account_id = current_setting('app.current_account_id', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account_id', true)::uuid);

CREATE POLICY tenant_isolation ON audiences
  USING (account_id = current_setting('app.current_account_id', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account_id', true)::uuid);

CREATE POLICY tenant_isolation ON campaigns
  USING (account_id = current_setting('app.current_account_id', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account_id', true)::uuid);

CREATE POLICY tenant_isolation ON campaign_recipients
  USING (account_id = current_setting('app.current_account_id', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account_id', true)::uuid);

-- Note: the worker process handles webhook_events and the dispatch side
-- of campaign_recipients using a privileged path (it resolves account_id
-- itself from the campaign being processed) — see apps/worker for how it
-- opens its DB session.

-- The application (api + worker) must connect as this role, NOT as the
-- role that owns the tables (e.g. not the default 'postgres'/migration
-- user), or RLS has no effect. This role gets normal CRUD grants but no
-- ownership, and is not a superuser.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user_password_change_me';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
