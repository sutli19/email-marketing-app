import { parse } from "csv-parse/sync";
import { PoolClient } from "pg";
import { normalizeEmail, normalizePhone } from "./normalize";
import { resolveTagIds, assignTagsToContact } from "./tags";

interface ParsedRow {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  city: string | null;
  customFields: Record<string, unknown>;
  tagNames: string[];
}

interface CanonicalRow extends ParsedRow {
  normalizedEmail: string | null;
  normalizedPhone: string | null;
}

const KNOWN_HEADERS: Record<string, keyof Omit<ParsedRow, "customFields" | "tagNames">> = {
  email: "email",
  "e-mail": "email",
  phone: "phone",
  "phone number": "phone",
  phonenumber: "phone",
  mobile: "phone",
  firstname: "firstName",
  "first name": "firstName",
  first_name: "firstName",
  lastname: "lastName",
  "last name": "lastName",
  last_name: "lastName",
  city: "city",
};

function headerKey(raw: string): string {
  return raw.trim().toLowerCase();
}

export function parseContactsCsv(buffer: Buffer): { rows: ParsedRow[]; invalidCount: number } {
  const records: Record<string, string>[] = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const rows: ParsedRow[] = [];
  let invalidCount = 0;

  for (const record of records) {
    const row: ParsedRow = {
      email: null,
      phone: null,
      firstName: null,
      lastName: null,
      city: null,
      customFields: {},
      tagNames: [],
    };

    for (const [rawHeader, rawValue] of Object.entries(record)) {
      const value = (rawValue ?? "").trim();
      if (value === "") continue;
      const key = headerKey(rawHeader);
      if (key === "tags") {
        // Maps into the reusable Tags system (see lib/tags.ts) instead of
        // being stored as a plain customFields string.
        row.tagNames = value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        continue;
      }
      if (key === "name") {
        // Handles a single full-name column (as in the supplied
        // contacts.csv), splitting on the first space. KNOWN_HEADERS only
        // covers pre-split "first name"/"last name" spellings.
        const [first, ...rest] = value.split(/\s+/);
        row.firstName = first;
        row.lastName = rest.length > 0 ? rest.join(" ") : null;
        continue;
      }
      const known = KNOWN_HEADERS[key];
      if (known) {
        row[known] = value;
      } else {
        row.customFields[rawHeader.trim()] = value;
      }
    }

    if (!normalizeEmail(row.email) && !normalizePhone(row.phone)) {
      // No usable identifier at all — can't dedupe or contact this row.
      invalidCount++;
      continue;
    }

    rows.push(row);
  }

  return { rows, invalidCount };
}

/** Fill in only the blanks on `target` from `source`; never overwrite a populated field. */
function mergeFields(target: CanonicalRow, source: ParsedRow) {
  target.firstName = target.firstName ?? source.firstName;
  target.lastName = target.lastName ?? source.lastName;
  target.city = target.city ?? source.city;
  target.email = target.email ?? source.email;
  target.phone = target.phone ?? source.phone;
  target.normalizedEmail = target.normalizedEmail ?? normalizeEmail(source.email);
  target.normalizedPhone = target.normalizedPhone ?? normalizePhone(source.phone);
  target.customFields = { ...source.customFields, ...target.customFields };
  target.tagNames = [...target.tagNames, ...source.tagNames];
}

/**
 * Collapses duplicate rows *within the uploaded file itself* before we
 * ever touch the database — the sample file intentionally contains
 * repeated emails/phones, and without this step we'd ask the DB's
 * unique index to reject our own second row instead of merging it.
 */
export function dedupeWithinFile(rows: ParsedRow[]): { canonical: CanonicalRow[]; mergedCount: number } {
  const canonical: CanonicalRow[] = [];
  let mergedCount = 0;

  for (const row of rows) {
    const normalizedEmail = normalizeEmail(row.email);
    const normalizedPhone = normalizePhone(row.phone);

    const match = canonical.find(
      (c) =>
        (normalizedEmail && c.normalizedEmail === normalizedEmail) ||
        (normalizedPhone && c.normalizedPhone === normalizedPhone)
    );

    if (match) {
      mergeFields(match, row);
      mergedCount++;
    } else {
      canonical.push({ ...row, normalizedEmail, normalizedPhone });
    }
  }

  return { canonical, mergedCount };
}

export interface ImportResult {
  added: number;
  merged: number;
  skippedInvalid: number;
}

/**
 * Applies canonical rows against the account's existing contacts:
 * merges into an existing contact if email or phone matches, otherwise
 * inserts a new one. Must run inside a transaction already scoped via
 * withAccountScope (so RLS + the account_id column line up).
 */
export async function applyContactsImport(
  client: PoolClient,
  accountId: string,
  canonical: CanonicalRow[],
  invalidCount: number
): Promise<ImportResult> {
  const existing = await client.query<{
    id: string;
    email: string | null;
    normalized_phone: string | null;
  }>("SELECT id, email, normalized_phone FROM contacts WHERE account_id = $1", [accountId]);

  const byEmail = new Map<string, string>(); // normalized email -> contact id
  const byPhone = new Map<string, string>(); // normalized phone -> contact id
  for (const row of existing.rows) {
    if (row.email) byEmail.set(row.email.toLowerCase(), row.id);
    if (row.normalized_phone) byPhone.set(row.normalized_phone, row.id);
  }

  let added = 0;
  let merged = 0;

  for (const row of canonical) {
    const existingId =
      (row.normalizedEmail && byEmail.get(row.normalizedEmail)) ||
      (row.normalizedPhone && byPhone.get(row.normalizedPhone));

    let contactId: string;

    if (existingId) {
      // Merge: only fill columns that are currently null, and shallow-merge
      // custom_fields without clobbering existing keys.
      await client.query(
        `UPDATE contacts SET
           email = COALESCE(email, $2),
           phone = COALESCE(phone, $3),
           first_name = COALESCE(first_name, $4),
           last_name = COALESCE(last_name, $5),
           city = COALESCE(city, $6),
           custom_fields = custom_fields || $7::jsonb,
           updated_at = now()
         WHERE id = $1`,
        [
          existingId,
          row.email,
          row.phone,
          row.firstName,
          row.lastName,
          row.city,
          JSON.stringify(row.customFields),
        ]
      );
      contactId = existingId;
      merged++;
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO contacts (account_id, email, phone, first_name, last_name, city, custom_fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id`,
        [
          accountId,
          row.email,
          row.phone,
          row.firstName,
          row.lastName,
          row.city,
          JSON.stringify(row.customFields),
        ]
      );
      contactId = inserted.rows[0].id;
      // register newly-added row so later rows in the same file can still
      // match against it (handles A/B/C chains within one upload)
      if (row.normalizedEmail) byEmail.set(row.normalizedEmail, contactId);
      if (row.normalizedPhone) byPhone.set(row.normalizedPhone, contactId);
      added++;
    }

    if (row.tagNames.length > 0) {
      const tagIds = await resolveTagIds(client, accountId, row.tagNames);
      await assignTagsToContact(client, accountId, contactId, tagIds);
    }
  }

  return { added, merged, skippedInvalid: invalidCount };
}