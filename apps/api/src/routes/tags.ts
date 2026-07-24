import { Router } from "express";
import { z } from "zod";
import { withAccountScope } from "@email-app/db";
import { requireAuth } from "../middleware/auth";
import { resolveTagIds } from "../lib/tags";

export const tagsRouter = Router();
tagsRouter.use(requireAuth);

const tagSchema = z.object({
  name: z.string().min(1).max(100),
});

// GET /api/tags
tagsRouter.get("/", async (req, res, next) => {
  try {
    const result = await withAccountScope(req.auth!.accountId, (client) =>
      client.query("SELECT * FROM tags WHERE account_id = $1 ORDER BY name", [req.auth!.accountId])
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/tags — creates a tag, or returns the existing one if a tag
// with that name already exists for the account (case-insensitively —
// "VIP" and "vip" resolve to the same tag). Goes through resolveTagIds,
// the same function the CSV importer uses, so both entry points stay
// consistent rather than having two separate dedup rules.
tagsRouter.post("/", async (req, res, next) => {
  try {
    const parsed = tagSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const tag = await withAccountScope(req.auth!.accountId, async (client) => {
      const [tagId] = await resolveTagIds(client, req.auth!.accountId, [parsed.data.name]);
      const result = await client.query("SELECT * FROM tags WHERE id = $1", [tagId]);
      return result.rows[0];
    });
    res.status(201).json(tag);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tags/:id — contact_tags rows cascade via the FK defined in
// migration 0002, so no manual cleanup of associations is needed here.
tagsRouter.delete("/:id", async (req, res, next) => {
  try {
    const result = await withAccountScope(req.auth!.accountId, (client) =>
      client.query("DELETE FROM tags WHERE id = $1 RETURNING id", [req.params.id])
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Tag not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});