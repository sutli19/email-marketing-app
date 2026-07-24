CREATE TABLE audiences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Small JSON criteria blob, evaluated at read/send time so membership
  -- always reflects the current contact list rather than a stale snapshot.
  -- e.g. {"tag_ids": ["..."], "city": "Mumbai", "custom_fields": {"plan": "pro"}}
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

CREATE INDEX audiences_account_id_idx ON audiences (account_id);
