-- Order matters here: DROP ROLE fails if the role still owns any object
-- or still appears in any ACL/policy — Postgres won't drop those for you
-- implicitly. Each step below clears one specific kind of dependency,
-- so the final DROP ROLE has nothing left to complain about.

-- 1. Function is owned by webhook_lookup_role — drop it first, or
--    DROP ROLE fails with "owner of function ... cannot be dropped".
DROP FUNCTION IF EXISTS resolve_campaign_recipient_by_provider_message_id(TEXT);

-- 2. Policy references webhook_lookup_role in its TO clause — drop it
--    before the role, or DROP ROLE fails with "... depends on role".
DROP POLICY IF EXISTS webhook_lookup_select ON campaign_recipients;

-- 3. Column-level grant is an ACL entry naming the role — revoke it
--    explicitly rather than relying on DROP ROLE to notice.
REVOKE SELECT (id, account_id) ON campaign_recipients FROM webhook_lookup_role;

-- 4. Defensive, not required: steps 1–3 above already remove
--    everything this migration created (the function, the policy, the
--    column grant), so this is expected to be a no-op in the normal
--    case. It's here only to catch drift — e.g. if a future change
--    granted webhook_lookup_role something else, or a manual/ad-hoc
--    grant was added outside migrations — so DROP ROLE below doesn't
--    fail on a dependency this file didn't anticipate. If this ever
--    turns out NOT to be a no-op in practice, that's a signal something
--    violated the single-purpose-role rule documented in the up
--    migration, and is worth investigating rather than just deleting.
DROP OWNED BY webhook_lookup_role;

-- 5. Now safe: no owned objects, no ACL entries, no policy references.
DROP ROLE IF EXISTS webhook_lookup_role;