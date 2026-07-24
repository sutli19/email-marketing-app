import { Router } from "express";
import { PoolClient } from "pg";
import { z } from "zod";
import { withAccountScope } from "@email-app/db";
import { requireAuth } from "../middleware/auth";
import { normalizeEmail, normalizePhone } from "../lib/normalize";

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