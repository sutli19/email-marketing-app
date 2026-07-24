import { Router } from "express";
import { PoolClient } from "pg";
import { z } from "zod";
import { withAccountScope } from "@email-app/db";
import { requireAuth } from "../middleware/auth";

export const audiencesRouter = Router();
audiencesRouter.use(requireAuth);

const audienceFilterSchema = z
  .object({
    tagIds: z.array(z.string().uuid()).optional(),
    city: z.string().optional(),
    customFields: z.record(z.unknown()).optional(),
  })
  .default({});

type AudienceFilter = z.infer<typeof audienceFilterSchema>;

const audienceSchema = z.object({
  name: z.string().min(1).max(200),
  filter: audienceFilterSchema,
});

/**
 * Counts contacts matching an audience's filter: any of the given tags
 * (if provided), AND the city (if provided), AND containing the given
 * custom field values (if provided). Mirrors the tag-join / city-match
 * pattern already used in GET /api/contacts, plus a JSONB containment
 * check for custom fields. Must run inside the same account-scoped
 * transaction as the audience row itself.
 */
async function countAudienceMembers(
  client: PoolClient,
  filter: AudienceFilter
): Promise<number> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let query = "SELECT COUNT(DISTINCT c.id) FROM contacts c";

  if (filter.tagIds && filter.tagIds.length > 0) {
    params.push(filter.tagIds);
    query += ` JOIN contact_tags ct ON ct.contact_id = c.id AND ct.tag_id = ANY($${params.length}::uuid[])`;
  }
  if (filter.city) {
    params.push(filter.city);
    conditions.push(`c.city ILIKE $${params.length}`);
  }
  if (filter.customFields && Object.keys(filter.customFields).length > 0) {
    params.push(JSON.stringify(filter.customFields));
    conditions.push(`c.custom_fields @> $${params.length}::jsonb`);
  }

  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const result = await client.query<{ count: string }>(query + where, params);
  return Number(result.rows[0].count);
}

/**
 * Same matching rules as countAudienceMembers, but computes counts for
 * every audience on the account in one query instead of one query per
 * audience — each audience's own `filter` JSONB is read directly in SQL
 * via a LEFT JOIN + GROUP BY, so this scales with the audience list size
 * without a round trip per row. Used by the list endpoint, where the
 * old per-row loop was an actual N+1 (1 query for the list + N for
 * counts). Single-audience routes don't have this problem — they're
 * already one query — so they keep using countAudienceMembers as-is.
 */
async function countMembersForAllAudiences(
  client: PoolClient,
  accountId: string
): Promise<Map<string, number>> {
  const result = await client.query<{ audience_id: string; member_count: string }>(
    `SELECT a.id AS audience_id, COUNT(DISTINCT c.id) AS member_count
     FROM audiences a
     LEFT JOIN contacts c
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
     WHERE a.account_id = $1
     GROUP BY a.id`,
    [accountId]
  );
  return new Map(result.rows.map((r) => [r.audience_id, Number(r.member_count)]));
}

// GET /api/audiences
audiencesRouter.get("/", async (req, res, next) => {
  try {
    const audiences = await withAccountScope(req.auth!.accountId, async (client) => {
      const result = await client.query(
        "SELECT * FROM audiences WHERE account_id = $1 ORDER BY created_at DESC",
        [req.auth!.accountId]
      );
      const counts = await countMembersForAllAudiences(client, req.auth!.accountId);
      return result.rows.map((row) => ({ ...row, memberCount: counts.get(row.id) ?? 0 }));
    });
    res.json(audiences);
  } catch (err) {
    next(err);
  }
});

// GET /api/audiences/:id
audiencesRouter.get("/:id", async (req, res, next) => {
  try {
    const audience = await withAccountScope(req.auth!.accountId, async (client) => {
      const result = await client.query("SELECT * FROM audiences WHERE id = $1", [req.params.id]);
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return { ...row, memberCount: await countAudienceMembers(client, row.filter) };
    });
    if (!audience) return res.status(404).json({ error: "Audience not found" });
    res.json(audience);
  } catch (err) {
    next(err);
  }
});

// POST /api/audiences
audiencesRouter.post("/", async (req, res, next) => {
  try {
    const parsed = audienceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { name, filter } = parsed.data;

    const audience = await withAccountScope(req.auth!.accountId, async (client) => {
      const result = await client.query(
        "INSERT INTO audiences (account_id, name, filter) VALUES ($1, $2, $3::jsonb) RETURNING *",
        [req.auth!.accountId, name, JSON.stringify(filter)]
      );
      const row = result.rows[0];
      return { ...row, memberCount: await countAudienceMembers(client, filter) };
    });
    res.status(201).json(audience);
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "An audience with that name already exists" });
    }
    next(err);
  }
});

// PUT /api/audiences/:id
audiencesRouter.put("/:id", async (req, res, next) => {
  try {
    const parsed = audienceSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const b = parsed.data;

    const audience = await withAccountScope(req.auth!.accountId, async (client) => {
      const result = await client.query(
        `UPDATE audiences SET
           name = COALESCE($2, name),
           filter = COALESCE($3::jsonb, filter)
         WHERE id = $1
         RETURNING *`,
        [req.params.id, b.name ?? null, b.filter ? JSON.stringify(b.filter) : null]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return { ...row, memberCount: await countAudienceMembers(client, row.filter) };
    });

    if (!audience) return res.status(404).json({ error: "Audience not found" });
    res.json(audience);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/audiences/:id
audiencesRouter.delete("/:id", async (req, res, next) => {
  try {
    const result = await withAccountScope(req.auth!.accountId, (client) =>
      client.query("DELETE FROM audiences WHERE id = $1 RETURNING id", [req.params.id])
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Audience not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});