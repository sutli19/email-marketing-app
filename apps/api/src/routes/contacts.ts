import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { withAccountScope } from "@email-app/db";
import { requireAuth } from "../middleware/auth";
import { normalizeEmail, normalizePhone, isValidEmail } from "../lib/normalize";
import { applyContactsImport, dedupeWithinFile, parseContactsCsv } from "../lib/csvImport";

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const contactSchema = z.object({
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  firstName: z.string().optional().nullable(),
  lastName: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  customFields: z.record(z.unknown()).optional(),
});

function rowFromRequest(body: z.infer<typeof contactSchema>) {
  return {
    email: body.email ?? null,
    phone: body.phone ?? null,
    firstName: body.firstName ?? null,
    lastName: body.lastName ?? null,
    city: body.city ?? null,
    customFields: body.customFields ?? {},
  };
}

// GET /contacts?city=&tagId=&search=
contactsRouter.get("/", async (req, res, next) => {
  try {
    const { city, tagId, search } = req.query as Record<string, string | undefined>;

    const result = await withAccountScope(req.auth!.accountId, async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];

      let baseQuery = "SELECT c.* FROM contacts c";
      if (tagId) {
        baseQuery += " JOIN contact_tags ct ON ct.contact_id = c.id AND ct.tag_id = $" + (params.length + 1);
        params.push(tagId);
      }
      if (city) {
        params.push(city);
        conditions.push(`c.city ILIKE $${params.length}`);
      }
      if (search) {
        params.push(`%${search}%`);
        conditions.push(
          `(c.email ILIKE $${params.length} OR c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`
        );
      }
      const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
      const query = baseQuery + where + " ORDER BY c.created_at DESC LIMIT 500";
      return client.query(query, params);
    });

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /contacts — same dedup rule as CSV import: merge into an existing
// contact (by normalized email or phone) rather than creating a copy.
contactsRouter.post("/", async (req, res, next) => {
  try {
    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const row = rowFromRequest(parsed.data);

    if (!normalizeEmail(row.email) && !normalizePhone(row.phone)) {
      return res.status(400).json({ error: "Provide at least an email or a phone number" });
    }
    if (row.email && !isValidEmail(row.email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const { canonical } = dedupeWithinFile([row]); // trivial for a single row, keeps logic in one place

    const outcome = await withAccountScope(req.auth!.accountId, async (client) => {
      await client.query("BEGIN");
      try {
        const result = await applyContactsImport(client, req.auth!.accountId, canonical, 0);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });

    res.status(outcome.merged > 0 ? 200 : 201).json({
      merged: outcome.merged > 0,
      message: outcome.merged > 0 ? "Merged into an existing matching contact" : "Contact created",
    });
  } catch (err) {
    next(err);
  }
});

contactsRouter.put("/:id", async (req, res, next) => {
  try {
    const parsed = contactSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const b = parsed.data;

    const result = await withAccountScope(req.auth!.accountId, (client) =>
      client.query(
        `UPDATE contacts SET
           email = COALESCE($2, email),
           phone = COALESCE($3, phone),
           first_name = COALESCE($4, first_name),
           last_name = COALESCE($5, last_name),
           city = COALESCE($6, city),
           custom_fields = CASE WHEN $7::jsonb IS NULL THEN custom_fields ELSE custom_fields || $7::jsonb END,
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          req.params.id,
          b.email ?? null,
          b.phone ?? null,
          b.firstName ?? null,
          b.lastName ?? null,
          b.city ?? null,
          b.customFields ? JSON.stringify(b.customFields) : null,
        ]
      )
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Contact not found" });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

contactsRouter.delete("/:id", async (req, res, next) => {
  try {
    const result = await withAccountScope(req.auth!.accountId, (client) =>
      client.query("DELETE FROM contacts WHERE id = $1 RETURNING id", [req.params.id])
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Contact not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /contacts/import — multipart CSV upload
contactsRouter.post("/import", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: file)" });

    const { rows, invalidCount } = parseContactsCsv(req.file.buffer);
    const { canonical, mergedCount: withinFileMerges } = dedupeWithinFile(rows);

    const result = await withAccountScope(req.auth!.accountId, async (client) => {
      await client.query("BEGIN");
      try {
        const outcome = await applyContactsImport(client, req.auth!.accountId, canonical, invalidCount);
        await client.query("COMMIT");
        return outcome;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });

    res.json({
      added: result.added,
      merged: result.merged + withinFileMerges,
      skippedInvalid: result.skippedInvalid,
      message: `${result.added} added, ${result.merged + withinFileMerges} merged as duplicates, ${result.skippedInvalid} skipped (no usable email or phone)`,
    });
  } catch (err) {
    next(err);
  }
});
