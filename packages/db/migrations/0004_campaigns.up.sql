CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  selection_type TEXT NOT NULL
    CHECK (selection_type IN ('audience', 'tag', 'pasted_list')),
  -- audience -> {"audience_id": "..."} | tag -> {"tag_id": "..."} |
  -- pasted_list -> {"lines": ["a@b.com", "9876543210", ...]}
  selection_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  bullmq_job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX campaigns_account_id_idx ON campaigns (account_id);
CREATE INDEX campaigns_status_idx ON campaigns (status);

CREATE TABLE campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  raw_input TEXT, -- what the user pasted, if selection_type = 'pasted_list'
  matched BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'delivered', 'opened', 'failed')),
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX campaign_recipients_campaign_id_idx ON campaign_recipients (campaign_id);
CREATE INDEX campaign_recipients_account_id_idx ON campaign_recipients (account_id);
CREATE UNIQUE INDEX campaign_recipients_provider_msg_idx
  ON campaign_recipients (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Not account-scoped: webhooks arrive with only a provider message id,
-- before we know which account they belong to. We resolve that by
-- joining to campaign_recipients once we've verified the payload.
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id TEXT NOT NULL UNIQUE, -- for idempotency: ignore repeats
  provider_message_id TEXT,
  event_type TEXT NOT NULL, -- 'delivered' | 'opened' | ...
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
