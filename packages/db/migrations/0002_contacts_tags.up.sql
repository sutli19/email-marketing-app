CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email CITEXT,
  phone TEXT,
  -- generated column: digits-only phone, used for dedup + lookup so
  -- "+91 98765-43210" and "9876543210" are recognized as the same number
  normalized_phone TEXT GENERATED ALWAYS AS (regexp_replace(coalesce(phone, ''), '\D', '', 'g')) STORED,
  first_name TEXT,
  last_name TEXT,
  city TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup rules: unique per account, only enforced when the value is present.
-- (a contact with no email and a contact with a different email but same
-- phone are still allowed to coexist as separate rows unless they collide.)
CREATE UNIQUE INDEX contacts_account_email_unique_idx
  ON contacts (account_id, email) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX contacts_account_phone_unique_idx
  ON contacts (account_id, normalized_phone) WHERE normalized_phone <> '';

CREATE INDEX contacts_account_id_idx ON contacts (account_id);
CREATE INDEX contacts_custom_fields_gin_idx ON contacts USING GIN (custom_fields);

CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

CREATE TABLE contact_tags (
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  -- Denormalized so the RLS policy below can filter directly without a
  -- join (RLS policies run per-row and joins in USING clauses get messy).
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);
