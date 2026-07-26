-- Lets the brevo webhook resolve account_id from provider_message_id
-- before it can call withAccountScope(), without a privileged
-- application connection.
--
-- ============================================================
-- SECURITY BOUNDARY — READ BEFORE ADDING ANOTHER FUNCTION HERE
-- ============================================================
-- webhook_lookup_role is a dedicated, SINGLE-PURPOSE role. It exists
-- ONLY to own resolve_campaign_recipient_by_provider_message_id() below,
-- and must never be used for anything else:
--   - Do not grant it any further privileges.
--   - Do not make it the owner of any other SECURITY DEFINER function,
--     on this table or any other.
--   - Nothing should ever connect or SET ROLE as it directly — it's
--     NOLOGIN and exists purely as a function-owner identity.
--
-- Why this matters: the policy below is USING (true) — any query
-- issued as webhook_lookup_role sees every row of campaign_recipients
-- (though only the two granted columns of it). That's safe today
-- because the only SQL ever run as this role is this one function's
-- single parameterized WHERE provider_message_id = $1 lookup. It would
-- stop being safe the moment a second function reused this owner role,
-- since that new function's own query — not this policy — would become
-- the only thing standing between it and a full-table read of
-- (id, account_id) across every account.
--
-- If a future feature needs another RLS-crossing lookup, give it its
-- own dedicated NOLOGIN owner role and its own narrowly-scoped grant,
-- following this same pattern. Do not reuse webhook_lookup_role.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'webhook_lookup_role') THEN
    CREATE ROLE webhook_lookup_role NOLOGIN;
  END IF;
END
$$;

-- Column-level grant: webhook_lookup_role can read only these two
-- columns, never the rest of the row (contact_id, raw_input, etc.).
GRANT SELECT (id, account_id) ON campaign_recipients TO webhook_lookup_role;

-- Scoped to webhook_lookup_role only — every other role (including
-- app_user's normal, RLS-scoped queries) is governed solely by
-- tenant_isolation, unaffected by this policy. See the boundary note
-- above for why USING (true) is acceptable here specifically.
CREATE POLICY webhook_lookup_select ON campaign_recipients
  FOR SELECT
  TO webhook_lookup_role
  USING (true);

CREATE FUNCTION resolve_campaign_recipient_by_provider_message_id(p_provider_message_id TEXT)
RETURNS TABLE (id UUID, account_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, account_id
  FROM campaign_recipients
  WHERE provider_message_id = p_provider_message_id;
$$;

ALTER FUNCTION resolve_campaign_recipient_by_provider_message_id(TEXT) OWNER TO webhook_lookup_role;

REVOKE ALL ON FUNCTION resolve_campaign_recipient_by_provider_message_id(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_campaign_recipient_by_provider_message_id(TEXT) TO app_user;