import { Router } from "express";
import { PoolClient } from "pg";
import { z } from "zod";
import { withAccountScope } from "@email-app/db";
import { CAMPAIGN_SEND_QUEUE_NAME } from "@email-app/shared";
import type { CampaignAnalytics } from "@email-app/shared";
import { requireAuth } from "../middleware/auth";
import { normalizeEmail, normalizePhone } from "../lib/normalize";
import { campaignSendQueue } from "../lib/queue";

export const campaignsRouter = Router();
campaignsRouter.use(requireAuth);

const SELECTION_TYPES = ["audience", "tag", "pasted_list"] as const;

// Matches the CampaignStatus type in packages/shared/src/types.ts and the
// CHECK constraint on campaigns.status (migration 0004).
const EDITABLE_STATUSES = ["draft", "scheduled"] as const; // scheduled edit's
// BullMQ job-replace side effect is added in Phase F — no campaign can
// reach 'scheduled' yet since there's no send/schedule endpoint in this
// phase, so in practice only 'draft' is reachable right now. The check is
// written against the full approved state matrix anyway, so this route
// doesn't need to change again once Phase F lands.
const DELETABLE_STATUSES = ["draft"] as const; // scheduled must be cancelled
// (back to draft) before it can be deleted; sending/sent/failed are never
// directly deletable, per the approved campaign state matrix.

// Phase F: only a fresh draft can be sent/scheduled — a campaign that's
// already scheduled must go through cancel-schedule first (back to
// draft) before it can be sent again. Prevents a second POST /send from
// silently appending a second campaign_recipients snapshot and a second
// (colliding) BullMQ job onto an already-scheduled campaign.
const SENDABLE_STATUSES = ["draft"] as const;

// Only a scheduled campaign can be cancelled. Once the worker has
// flipped it to 'sending' the campaign is in flight — cancellation stops
// being meaningful (see apps/worker/src/worker.ts's own FOR UPDATE guard
// for the other half of this race).
const CANCELLABLE_STATUSES = ["scheduled"] as const;

// Explicit column list for every SELECT / RETURNING against campaigns, so a
// future migration adding a column can't leak it into API responses by
// accident. Keep in sync with the `campaigns` table (migration 0004) and
// the Campaign type in packages/shared/src/types.ts.
const CAMPAIGN_COLUMNS =
  "id, account_id, name, subject, body_html, status, selection_type, " +
  "selection_value, scheduled_at, sent_at, created_at, updated_at";

// Allowed keys per selectionType, used to reject unexpected properties on
// selectionValue — kept next to the shape checks below so the "required"
// and "no extras" rules can't drift apart.
const SELECTION_VALUE_KEYS: Record<(typeof SELECTION_TYPES)[number], string[]> = {
  audience: ["audienceId"],
  tag: ["tagId"],
  pasted_list: ["lines"],
};

/**
 * Adds Zod issues for a (selectionType, selectionValue) pair that cross-checks
 * selectionValue has the shape its selectionType implies — {audienceId} for
 * 'audience', {tagId} for 'tag', {lines: [...]} for 'pasted_list' — mirroring
 * the SelectionValue union in types.ts, and rejects any property not
 * belonging to that shape. Recipient resolution itself (turning this into
 * actual contact rows) is Phase C; this only validates the shape being
 * stored. Shared by the POST schema and the PUT (partial) schema below so
 * there's a single place the rule lives.
 */
function addSelectionValueIssues(
  ctx: z.RefinementCtx,
  selectionType: (typeof SELECTION_TYPES)[number],
  selectionValue: Record<string, unknown>
) {
  if (selectionType === "audience") {
    if (typeof selectionValue.audienceId !== "string" || !selectionValue.audienceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selectionValue.audienceId is required when selectionType is 'audience'",
        path: ["selectionValue", "audienceId"],
      });
    }
  } else if (selectionType === "tag") {
    if (typeof selectionValue.tagId !== "string" || !selectionValue.tagId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selectionValue.tagId is required when selectionType is 'tag'",
        path: ["selectionValue", "tagId"],
      });
    }
  } else if (selectionType === "pasted_list") {
    if (
      !Array.isArray(selectionValue.lines) ||
      selectionValue.lines.length === 0 ||
      !selectionValue.lines.every((l) => typeof l === "string")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "selectionValue.lines must be a non-empty array of strings when selectionType is 'pasted_list'",
        path: ["selectionValue", "lines"],
      });
    }
  }

  const allowedKeys = SELECTION_VALUE_KEYS[selectionType];
  for (const key of Object.keys(selectionValue)) {
    if (!allowedKeys.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unexpected property '${key}' in selectionValue for selectionType '${selectionType}'`,
        path: ["selectionValue", key],
      });
    }
  }
}

// Base shape shared by create (fully required) and update (all optional).
// selectionValue stays a generic record at this layer — its real shape is
// enforced by addSelectionValueIssues in superRefine, since what's "valid"
// depends on the sibling selectionType field, which a plain field-level
// schema can't express. .strict() rejects unknown top-level properties.
const campaignFieldsSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  bodyHtml: z.string().min(1),
  selectionType: z.enum(SELECTION_TYPES),
  selectionValue: z.record(z.unknown()),
}).strict();

// POST /api/campaigns — every field required, selectionValue shape checked
// against selectionType.
const campaignSchema = campaignFieldsSchema.superRefine((data, ctx) => {
  addSelectionValueIssues(ctx, data.selectionType, data.selectionValue);
});

// PUT /api/campaigns/:id — every field optional, but selectionType and
// selectionValue must be provided together (a stored selectionValue could
// otherwise end up mismatched with its type), and if both are present the
// same shape check as create applies.
const campaignUpdateSchema = campaignFieldsSchema.partial().superRefine((data, ctx) => {
  const hasType = data.selectionType !== undefined;
  const hasValue = data.selectionValue !== undefined;
  if (hasType !== hasValue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "selectionType and selectionValue must be provided together",
      path: ["selectionType"],
    });
    return;
  }
  if (hasType && hasValue) {
    addSelectionValueIssues(ctx, data.selectionType!, data.selectionValue!);
  }
});

// POST /api/campaigns/resolve-recipients — preview-only, no persistence.
// Reuses the same selectionType/selectionValue shape rules as create/update
// (addSelectionValueIssues) so "what counts as a valid selection" can't
// drift between creating a campaign and previewing one.
const resolveRecipientsSchema = z
  .object({
    selectionType: z.enum(SELECTION_TYPES),
    selectionValue: z.record(z.unknown()),
  })
  .strict()
  .superRefine((data, ctx) => {
    addSelectionValueIssues(ctx, data.selectionType, data.selectionValue);
  });

// POST /api/campaigns/:id/send — scheduledAt is optional; its absence
// means "send now". When present it must be a real future instant, not
// past/now (rejecting rather than silently treating it as immediate —
// a stale scheduledAt from a slow client is a user error worth surfacing).
const sendCampaignSchema = z
  .object({
    scheduledAt: z.string().datetime().optional(),
  })
  .strict();

// Explicit column list for the contact fields this preview endpoint
// exposes, same rationale as CAMPAIGN_COLUMNS above.
const RECIPIENT_CONTACT_COLUMNS = "id, email, phone, first_name, last_name";

interface ResolvedContactRow {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
}

/**
 * Resolves contacts belonging to an audience by re-running the same
 * filter → SQL translation already reviewed in GET /api/audiences (the
 * tagIds / city / customFields JOIN in countMembersForAllAudiences), just
 * scoped to one audience id and selecting contact columns instead of a
 * count. The audience's filter never leaves Postgres as JS — it's read
 * straight out of the jsonb column, so this can't drift from what
 * GET /api/audiences reports as that audience's member count.
 */
async function resolveAudienceContacts(
  client: PoolClient,
  accountId: string,
  audienceId: string
): Promise<ResolvedContactRow[]> {
  const result = await client.query<ResolvedContactRow>(
    `SELECT DISTINCT ${RECIPIENT_CONTACT_COLUMNS.split(", ")
      .map((c) => `c.${c}`)
      .join(", ")}
     FROM audiences a
     JOIN contacts c
       ON c.account_id = a.account_id
      AND (a.filter->>'city' IS NULL OR c.city ILIKE a.filter->>'city')
      AND (a.filter->'customFields' IS NULL OR c.custom_fields @> (a.filter->'customFields'))
      AND (
        a.filter->'tagIds' IS NULL OR EXISTS (
          SELECT 1 FROM contact_tags ct
          WHERE ct.contact_id = c.id
            AND ct.tag_id::text IN (SELECT jsonb_array_elements_text(a.filter->'tagIds'))
        )
      )
     WHERE a.id = $1 AND a.account_id = $2`,
    [audienceId, accountId]
  );
  return result.rows;
}

/** Resolves contacts carrying a given tag, same JOIN shape as the
 * tagId filter in GET /api/contacts. */
async function resolveTagContacts(
  client: PoolClient,
  accountId: string,
  tagId: string
): Promise<ResolvedContactRow[]> {
  const result = await client.query<ResolvedContactRow>(
    `SELECT ${RECIPIENT_CONTACT_COLUMNS.split(", ")
      .map((c) => `c.${c}`)
      .join(", ")}
     FROM contacts c
     JOIN contact_tags ct ON ct.contact_id = c.id AND ct.tag_id = $1
     WHERE c.account_id = $2`,
    [tagId, accountId]
  );
  return result.rows;
}

/**
 * Matches each pasted line against existing contacts using the same
 * normalizeEmail()/normalizePhone() helpers contacts.ts already uses for
 * create and CSV import, so a line that would dedupe against an existing
 * contact on import matches here too. Lines that don't normalize to
 * either shape are reported unmatched without a query. Matching is a
 * single batched lookup (not one query per line) the same way the
 * audience list route avoids an N+1.
 */
async function resolvePastedListContacts(
  client: PoolClient,
  accountId: string,
  lines: string[]
): Promise<{
  matched: Array<ResolvedContactRow & { raw_input: string }>;
  unmatched: Array<{ raw_input: string; reason: string }>;
}> {
  const lineInfos = lines.map((line) => ({
    rawInput: line,
    normalizedEmail: normalizeEmail(line),
    normalizedPhone: normalizePhone(line),
  }));

  const unmatched: Array<{ raw_input: string; reason: string }> = lineInfos
    .filter((l) => !l.normalizedEmail && !l.normalizedPhone)
    .map((l) => ({ raw_input: l.rawInput, reason: "Not a recognizable email or phone number" }));

  const validLines = lineInfos.filter((l) => l.normalizedEmail || l.normalizedPhone);
  const emails = validLines.map((l) => l.normalizedEmail).filter((e): e is string => !!e);
  const phones = validLines.map((l) => l.normalizedPhone).filter((p): p is string => !!p);

  const result = await client.query<ResolvedContactRow>(
    `SELECT ${RECIPIENT_CONTACT_COLUMNS}
     FROM contacts
     WHERE account_id = $1 AND (email = ANY($2::text[]) OR phone = ANY($3::text[]))`,
    [accountId, emails, phones]
  );

  const byEmail = new Map(result.rows.filter((r) => r.email).map((r) => [r.email as string, r]));
  const byPhone = new Map(result.rows.filter((r) => r.phone).map((r) => [r.phone as string, r]));

  const matched: Array<ResolvedContactRow & { raw_input: string }> = [];
  for (const l of validLines) {
    const contact =
      (l.normalizedEmail && byEmail.get(l.normalizedEmail)) ||
      (l.normalizedPhone && byPhone.get(l.normalizedPhone));
    if (contact) {
      matched.push({ ...contact, raw_input: l.rawInput });
    } else {
      unmatched.push({ raw_input: l.rawInput, reason: "No matching contact found" });
    }
  }

  return { matched, unmatched };
}

/**
 * Runs the same selectionType/selectionValue → contacts resolution as
 * POST /resolve-recipients (reusing resolveAudienceContacts /
 * resolveTagContacts / resolvePastedListContacts directly, not a
 * reimplementation), but shaped for persistence rather than preview: it
 * returns one row per contact_id/raw_input pair to be written into
 * campaign_recipients, tagging each as matched or not. Used by
 * POST /:id/send at the point a campaign actually gets snapshotted.
 */
async function resolveRecipientsForSend(
  client: PoolClient,
  accountId: string,
  selectionType: (typeof SELECTION_TYPES)[number],
  selectionValue: Record<string, unknown>
): Promise<
  | "selection_not_found"
  | Array<{ contactId: string | null; rawInput: string | null; matched: boolean }>
> {
  if (selectionType === "audience") {
    const audienceId = (selectionValue as { audienceId: string }).audienceId;
    const existing = await client.query("SELECT id FROM audiences WHERE id = $1 AND account_id = $2", [
      audienceId,
      accountId,
    ]);
    if (existing.rows.length === 0) return "selection_not_found";
    const contacts = await resolveAudienceContacts(client, accountId, audienceId);
    return contacts.map((c) => ({ contactId: c.id, rawInput: null, matched: true }));
  }

  if (selectionType === "tag") {
    const tagId = (selectionValue as { tagId: string }).tagId;
    const existing = await client.query("SELECT id FROM tags WHERE id = $1 AND account_id = $2", [
      tagId,
      accountId,
    ]);
    if (existing.rows.length === 0) return "selection_not_found";
    const contacts = await resolveTagContacts(client, accountId, tagId);
    return contacts.map((c) => ({ contactId: c.id, rawInput: null, matched: true }));
  }

  // pasted_list
  const lines = (selectionValue as { lines: string[] }).lines;
  const { matched, unmatched } = await resolvePastedListContacts(client, accountId, lines);
  return [
    ...matched.map((c) => ({ contactId: c.id, rawInput: c.raw_input, matched: true })),
    ...unmatched.map((u) => ({ contactId: null as string | null, rawInput: u.raw_input, matched: false })),
  ];
}

// POST /api/campaigns/resolve-recipients — preview only. Does not create a
// campaign, insert campaign_recipients, enqueue BullMQ jobs, send email, or
// persist anything; it only tells the caller who a selection would resolve
// to. Recipient rows are returned under `matched`, and pasted_list lines
// with no corresponding contact are returned under `unmatched` — audience
// and tag selections have no notion of an "unmatched input" so that array
// is always empty for them.
campaignsRouter.post("/resolve-recipients", async (req, res, next) => {
  try {
    const parsed = resolveRecipientsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { selectionType, selectionValue } = parsed.data;

    const outcome = await withAccountScope(req.auth!.accountId, async (client) => {
      if (selectionType === "audience") {
        const audienceId = (selectionValue as { audienceId: string }).audienceId;
        const existing = await client.query(
          "SELECT id FROM audiences WHERE id = $1 AND account_id = $2",
          [audienceId, req.auth!.accountId]
        );
        if (existing.rows.length === 0) return "not_found" as const;
        const matched = await resolveAudienceContacts(client, req.auth!.accountId, audienceId);
        return { matched, unmatched: [] as unknown[] };
      }

      if (selectionType === "tag") {
        const tagId = (selectionValue as { tagId: string }).tagId;
        const existing = await client.query("SELECT id FROM tags WHERE id = $1 AND account_id = $2", [
          tagId,
          req.auth!.accountId,
        ]);
        if (existing.rows.length === 0) return "not_found" as const;
        const matched = await resolveTagContacts(client, req.auth!.accountId, tagId);
        return { matched, unmatched: [] as unknown[] };
      }

      // pasted_list
      const lines = (selectionValue as { lines: string[] }).lines;
      return resolvePastedListContacts(client, req.auth!.accountId, lines);
    });

    if (outcome === "not_found") {
      return res.status(404).json({
        error: selectionType === "audience" ? "Audience not found" : "Tag not found",
      });
    }
    res.json(outcome);
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns
campaignsRouter.get("/", async (req, res, next) => {
  try {
    const result = await withAccountScope(req.auth!.accountId, (client) =>
      client.query(
        `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE account_id = $1 ORDER BY created_at DESC`,
        [req.auth!.accountId]
      )
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id
campaignsRouter.get("/:id", async (req, res, next) => {
  try {
    const result = await withAccountScope(req.auth!.accountId, (client) =>
      client.query(`SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE id = $1`, [req.params.id])
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Campaign not found" });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id/analytics — read-only aggregated stats,
// computed directly from campaign_recipients (delivered_at/opened_at/
// status), which the brevo webhook (Phase G1) keeps as the source of
// truth. No analytics-specific state is stored anywhere; this always
// reflects campaign_recipients as it stands right now, at request time.
//
// Single query, LEFT JOIN + GROUP BY, doing double duty:
//   - starting from the campaigns row is what makes ownership/RLS
//     apply — same "WHERE id = $1, let RLS filter it" pattern GET /:id
//     above already uses (no explicit account_id in the WHERE clause;
//     tenant_isolation does that). A campaign that doesn't exist, or
//     belongs to a different account, yields zero grouped rows here,
//     so "not found" and "not yours" collapse into the same 404 without
//     a second existence-check query.
//   - COUNT(cr.id), not COUNT(*): for a campaign with zero recipients
//     the LEFT JOIN still produces one NULL-extended row, and COUNT(*)
//     would count that phantom row as 1. COUNT(cr.id) correctly counts
//     zero, since cr.id is NULL when there's no matching recipient.
//
// delivered/opened are counted via delivered_at/opened_at IS NOT NULL,
// not status = 'delivered'/'opened'. status is forward-only (see
// webhooks.ts's UPDATE ... CASE statements) and moves off 'delivered'
// the moment an 'opened' event arrives for that recipient, so
// status = 'delivered' alone would undercount — it would miss every
// recipient who went on to open. The timestamp columns are set once
// (COALESCE keeps the first-seen value) and never cleared regardless of
// later status transitions, so they're the actual source of truth this
// phase is asking this endpoint to read from. pending/sent, by
// contrast, are genuinely point-in-time states with no separate
// timestamp column to check, so those two stay status-based.
const CAMPAIGN_ANALYTICS_QUERY = `
  SELECT
    COUNT(cr.id)::int AS total_recipients,
    COUNT(cr.id) FILTER (WHERE cr.status = 'pending')::int AS pending,
    COUNT(cr.id) FILTER (WHERE cr.status = 'sent')::int AS sent,
    COUNT(cr.id) FILTER (WHERE cr.delivered_at IS NOT NULL)::int AS delivered,
    COUNT(cr.id) FILTER (WHERE cr.opened_at IS NOT NULL)::int AS opened,
    COUNT(cr.id) FILTER (WHERE cr.status = 'failed')::int AS failed
  FROM campaigns c
  LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
  WHERE c.id = $1
  GROUP BY c.id
`;

// Ratios are returned as percentages (0–100), not fractions — e.g. 74.2
// means 74.2%, ready to display with a trailing "%" with no conversion
// step on the consumer side. Rounded to 2 decimal places, the usual
// precision for a displayed percentage.
function roundRate(value: number): number {
  return Math.round(value * 10000) / 100;
}

campaignsRouter.get("/:id/analytics", async (req, res, next) => {
  try {
    const result = await withAccountScope(req.auth!.accountId, (client) =>
      client.query<{
        total_recipients: number;
        pending: number;
        sent: number;
        delivered: number;
        opened: number;
        failed: number;
      }>(CAMPAIGN_ANALYTICS_QUERY, [req.params.id])
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const { total_recipients, pending, sent, delivered, opened, failed } = result.rows[0];

    const analytics: CampaignAnalytics = {
      campaignId: req.params.id,
      totalRecipients: total_recipients,
      pending,
      sent,
      delivered,
      opened,
      failed,
      deliveryRate: total_recipients > 0 ? roundRate(delivered / total_recipients) : 0,
      openRate: delivered > 0 ? roundRate(opened / delivered) : 0,
    };
    res.json(analytics);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns — always created as a draft. Sending/scheduling are
// separate endpoints added in Phase F.
campaignsRouter.post("/", async (req, res, next) => {
  try {
    const parsed = campaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { name, subject, bodyHtml, selectionType, selectionValue } = parsed.data;

    const result = await withAccountScope(req.auth!.accountId, (client) =>
      client.query(
        `INSERT INTO campaigns
           (account_id, name, subject, body_html, status, selection_type, selection_value)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6::jsonb)
         RETURNING ${CAMPAIGN_COLUMNS}`,
        [req.auth!.accountId, name, subject, bodyHtml, selectionType, JSON.stringify(selectionValue)]
      )
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/campaigns/:id — only allowed while the campaign is in an
// editable state (see EDITABLE_STATUSES above). Recipient re-resolution
// on a scheduled-campaign edit is Phase C/F territory, not this route.
campaignsRouter.put("/:id", async (req, res, next) => {
  try {
    const parsed = campaignUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const b = parsed.data;

    const outcome = await withAccountScope(req.auth!.accountId, async (client) => {
      const existing = await client.query<{ status: string }>(
        "SELECT status FROM campaigns WHERE id = $1",
        [req.params.id]
      );
      if (existing.rows.length === 0) return "not_found" as const;
      if (!EDITABLE_STATUSES.includes(existing.rows[0].status as (typeof EDITABLE_STATUSES)[number])) {
        return "not_editable" as const;
      }

      const result = await client.query(
        `UPDATE campaigns SET
           name = COALESCE($2, name),
           subject = COALESCE($3, subject),
           body_html = COALESCE($4, body_html),
           selection_type = COALESCE($5, selection_type),
           selection_value = COALESCE($6::jsonb, selection_value),
           updated_at = now()
         WHERE id = $1
         RETURNING ${CAMPAIGN_COLUMNS}`,
        [
          req.params.id,
          b.name ?? null,
          b.subject ?? null,
          b.bodyHtml ?? null,
          b.selectionType ?? null,
          b.selectionValue ? JSON.stringify(b.selectionValue) : null,
        ]
      );
      return result.rows[0];
    });

    if (outcome === "not_found") return res.status(404).json({ error: "Campaign not found" });
    if (outcome === "not_editable") {
      return res.status(409).json({ error: "Campaign can no longer be edited in its current status" });
    }
    res.json(outcome);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/campaigns/:id — only allowed while status is 'draft'.
// A scheduled campaign must be cancelled (back to draft, Phase F) first.
campaignsRouter.delete("/:id", async (req, res, next) => {
  try {
    const outcome = await withAccountScope(req.auth!.accountId, async (client) => {
      const existing = await client.query<{ status: string }>(
        "SELECT status FROM campaigns WHERE id = $1",
        [req.params.id]
      );
      if (existing.rows.length === 0) return "not_found" as const;
      if (!DELETABLE_STATUSES.includes(existing.rows[0].status as (typeof DELETABLE_STATUSES)[number])) {
        return "not_deletable" as const;
      }

      await client.query("DELETE FROM campaigns WHERE id = $1", [req.params.id]);
      return "ok" as const;
    });

    if (outcome === "not_found") return res.status(404).json({ error: "Campaign not found" });
    if (outcome === "not_deletable") {
      return res.status(409).json({ error: "Campaign can only be deleted while in draft status" });
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/send — the single entry point for both
// "send now" and "schedule for later". No scheduledAt => send now
// (delay 0). A future scheduledAt => delayed send. Either way the
// campaign ends up in 'scheduled' status with a snapshot of its
// recipients in campaign_recipients and a BullMQ job queued — the
// worker (apps/worker/src/worker.ts) is what actually dispatches it,
// immediately in the send-now case or after the delay elapses.
campaignsRouter.post("/:id/send", async (req, res, next) => {
  try {
    const parsed = sendCampaignSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { scheduledAt } = parsed.data;

    let scheduledDate: Date;
    if (scheduledAt) {
      scheduledDate = new Date(scheduledAt);
      if (scheduledDate.getTime() <= Date.now()) {
        return res.status(400).json({ error: "scheduledAt must be in the future" });
      }
    } else {
      scheduledDate = new Date();
    }
    const delay = Math.max(0, scheduledDate.getTime() - Date.now());

    const outcome = await withAccountScope(req.auth!.accountId, async (client) => {
      // FOR UPDATE: serializes concurrent send/cancel calls against this
      // campaign (see Phase F plan §11) and against the worker's own
      // FOR UPDATE on the same row when a job is picked up.
      const existing = await client.query<{
        status: string;
        selection_type: (typeof SELECTION_TYPES)[number];
        selection_value: Record<string, unknown>;
      }>("SELECT status, selection_type, selection_value FROM campaigns WHERE id = $1 FOR UPDATE", [
        req.params.id,
      ]);
      if (existing.rows.length === 0) return "not_found" as const;

      const campaign = existing.rows[0];
      if (!SENDABLE_STATUSES.includes(campaign.status as (typeof SENDABLE_STATUSES)[number])) {
        return "not_sendable" as const;
      }

      const recipients = await resolveRecipientsForSend(
        client,
        req.auth!.accountId,
        campaign.selection_type,
        campaign.selection_value
      );
      if (recipients === "selection_not_found") return "selection_not_found" as const;
      if (recipients.length === 0) return "no_recipients" as const;

      // Snapshot every resolved recipient in a single batched INSERT
      // (one statement, one round trip) rather than one INSERT per
      // recipient — matched contacts as status='pending' (the worker
      // will actually email these), and unmatched pasted-list lines as
      // status='failed' with no contact_id, so "flag anything we
      // couldn't match" (per the assessment) has a permanent record on
      // this campaign rather than only existing transiently in the
      // resolve-recipients preview response.
      const insertValues: unknown[] = [];
      const insertRows: string[] = [];
      recipients.forEach((r, i) => {
        const p = i * 6;
        insertRows.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6})`);
        insertValues.push(
          req.params.id,
          req.auth!.accountId,
          r.contactId,
          r.rawInput,
          r.matched,
          r.matched ? "pending" : "failed"
        );
      });
      await client.query(
        `INSERT INTO campaign_recipients
           (campaign_id, account_id, contact_id, raw_input, matched, status)
         VALUES ${insertRows.join(", ")}`,
        insertValues
      );

      const result = await client.query(
        `UPDATE campaigns
           SET status = 'scheduled', scheduled_at = $2, updated_at = now()
         WHERE id = $1
         RETURNING ${CAMPAIGN_COLUMNS}`,
        [req.params.id, scheduledDate.toISOString()]
      );
      return result.rows[0];
    });

    if (outcome === "not_found") return res.status(404).json({ error: "Campaign not found" });
    if (outcome === "not_sendable") {
      return res
        .status(409)
        .json({ error: "Only draft campaigns can be sent — cancel the existing schedule first" });
    }
    if (outcome === "selection_not_found") {
      return res.status(404).json({ error: "The campaign's audience or tag no longer exists" });
    }
    if (outcome === "no_recipients") {
      return res.status(400).json({ error: "No recipients resolved for this campaign's selection" });
    }

    // Enqueue outside the DB transaction — Postgres has already
    // committed the campaign_recipients snapshot and the 'scheduled'
    // status by this point, so a failure here must not leave the
    // campaign stranded in that state with no job behind it.
    try {
      // attempts/backoff/removeOnComplete/removeOnFail come from the
      // queue's defaultJobOptions (apps/api/src/lib/queue.ts) — only the
      // per-job jobId and delay are set here.
      await campaignSendQueue.add(
        CAMPAIGN_SEND_QUEUE_NAME,
        { campaignId: req.params.id, accountId: req.auth!.accountId },
        { jobId: req.params.id, delay } // deterministic jobId = campaignId, gives BullMQ-level idempotency
      );
    } catch (queueErr) {
      console.error(`[campaigns] failed to enqueue send for ${req.params.id}:`, queueErr);
      // Compensating transaction: undo the commit above, in one
      // transaction, so the campaign never sits in 'scheduled' with
      // nothing queued behind it.
      await withAccountScope(req.auth!.accountId, async (client) => {
        await client.query(
          `UPDATE campaigns SET status = 'draft', scheduled_at = NULL, updated_at = now()
           WHERE id = $1 AND status = 'scheduled'`,
          [req.params.id]
        );
        await client.query("DELETE FROM campaign_recipients WHERE campaign_id = $1", [req.params.id]);
      });
      return res.status(502).json({ error: "Campaign could not be queued for sending. Please try again." });
    }

    res.json(outcome);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/cancel-schedule — only valid while 'scheduled'.
// Reverts to 'draft', clears the recipient snapshot (a subsequent send
// re-resolves fresh rather than appending to a stale one), and removes
// the queued BullMQ job.
campaignsRouter.post("/:id/cancel-schedule", async (req, res, next) => {
  try {
    const outcome = await withAccountScope(req.auth!.accountId, async (client) => {
      const existing = await client.query<{ status: string }>(
        "SELECT status FROM campaigns WHERE id = $1 FOR UPDATE",
        [req.params.id]
      );
      if (existing.rows.length === 0) return "not_found" as const;
      if (
        !CANCELLABLE_STATUSES.includes(existing.rows[0].status as (typeof CANCELLABLE_STATUSES)[number])
      ) {
        return "not_cancellable" as const;
      }

      await client.query("DELETE FROM campaign_recipients WHERE campaign_id = $1", [req.params.id]);

      const result = await client.query(
        `UPDATE campaigns
           SET status = 'draft', scheduled_at = NULL, updated_at = now()
         WHERE id = $1
         RETURNING ${CAMPAIGN_COLUMNS}`,
        [req.params.id]
      );
      return result.rows[0];
    });

    if (outcome === "not_found") return res.status(404).json({ error: "Campaign not found" });
    if (outcome === "not_cancellable") {
      return res.status(409).json({ error: "Only scheduled campaigns can be cancelled" });
    }

    // Remove the queued job outside the transaction. jobId is
    // deterministic (= campaignId), so there's no stored id to look up.
    // If this fails, the campaign is still correctly 'draft' in
    // Postgres — that's the source of truth the worker itself checks
    // (see worker.ts), so a stray delayed job firing later just finds
    // the campaign no longer scheduled and no-ops. Log, don't fail the
    // request over it.
    try {
      await campaignSendQueue.remove(req.params.id);
    } catch (queueErr) {
      console.error(`[campaigns] failed to remove queued job for ${req.params.id}:`, queueErr);
    }

    res.json(outcome);
  } catch (err) {
    next(err);
  }
});