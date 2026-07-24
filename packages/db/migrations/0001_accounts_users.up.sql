CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- citext gives us case-insensitive email comparisons/uniqueness for free
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_unique_idx ON users (email);
CREATE INDEX users_account_id_idx ON users (account_id);
