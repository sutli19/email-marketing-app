import { PoolClient } from "pg";

/**
 * Trims and collapses internal whitespace so "VIP", " VIP ", and "VIP  "
 * are all treated as the same tag name before any comparison or insert.
 * Case is intentionally left as-is here — case-insensitive matching
 * happens in resolveTagIds — so the first-seen casing is what's stored
 * and displayed.
 */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Resolves a list of tag names to tag ids for the given account, creating
 * any tags that don't exist yet. Matching is case-insensitive (so "VIP"
 * and "vip" resolve to the same tag), even though the underlying
 * `tags.name` column and its unique index (account_id, name) are
 * case-sensitive — this keeps the DB schema untouched while avoiding
 * near-duplicate tags in the common case.
 *
 * This is the ONLY place tags get created — both the CSV importer
 * (lib/csvImport.ts) and the tags route (routes/tags.ts) call through
 * here, so "VIP" created via the API and "vip" created via CSV import
 * resolve to the same tag rather than diverging over time.
 *
 * Known limitation: because the DB unique index is case-sensitive, two
 * concurrent requests creating "VIP" and "vip" at the exact same instant
 * could both pass the pre-insert lookup and each insert their own row
 * (a race, not a bug in the steady-state path). Closing that fully would
 * require a case-insensitive unique index (e.g. on lower(name)), which
 * is a migration change and out of scope here since none is missing.
 */
export async function resolveTagIds(
  client: PoolClient,
  accountId: string,
  names: string[]
): Promise<string[]> {
  const unique = Array.from(new Set(names.map(normalizeTagName).filter(Boolean)));
  if (unique.length === 0) return [];

  const lowerNames = unique.map((n) => n.toLowerCase());
  const existing = await client.query<{ id: string; name: string }>(
    "SELECT id, name FROM tags WHERE account_id = $1 AND lower(name) = ANY($2)",
    [accountId, lowerNames]
  );

  const idByLowerName = new Map<string, string>(
    existing.rows.map((r) => [r.name.toLowerCase(), r.id])
  );

  for (const name of unique) {
    if (idByLowerName.has(name.toLowerCase())) continue;
    const inserted = await client.query<{ id: string; name: string }>(
      `INSERT INTO tags (account_id, name) VALUES ($1, $2)
       ON CONFLICT (account_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name`,
      [accountId, name]
    );
    idByLowerName.set(inserted.rows[0].name.toLowerCase(), inserted.rows[0].id);
  }

  return unique.map((n) => idByLowerName.get(n.toLowerCase())!);
}

/**
 * Links a contact to a set of tag ids in a single statement (via
 * unnest()) instead of one INSERT per tag, ignoring ones already linked.
 */
export async function assignTagsToContact(
  client: PoolClient,
  accountId: string,
  contactId: string,
  tagIds: string[]
): Promise<void> {
  if (tagIds.length === 0) return;
  await client.query(
    `INSERT INTO contact_tags (contact_id, tag_id, account_id)
     SELECT $1, tag_id, $2 FROM unnest($3::uuid[]) AS tag_id
     ON CONFLICT (contact_id, tag_id) DO NOTHING`,
    [contactId, accountId, tagIds]
  );
}