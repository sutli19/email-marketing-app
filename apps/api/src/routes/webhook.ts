import { Router } from "express";
import { z } from "zod";
import { queryUnscoped, withAccountScope } from "@email-app/db";
import { verifyBrevoWebhookToken } from "../lib/brevoWebhook";

export const webhooksRouter = Router();

// Deliberately NOT behind requireAuth (no campaignsRouter.use(requireAuth)
// equivalent here) — brevo has no way to carry a session/JWT. Trust
// comes entirely from the ?token= query param checked via
// verifyBrevoWebhookToken() below.

// These event types touch campaign_recipients / analytics. hard_bounce
// and blocked mark a recipient as genuinely undeliverable — an invalid
// or non-existent address that Brevo's API happily accepted at send
// time (so it's stuck at 'sent') but that never actually reached an
// inbox. Everything else brevo sends (accepted, clicked, soft_bounce,
// complained, unsubscribed, ...) is still logged to webhook_events for
// audit/history, but never applied to a recipient row.
const TRACKED_EVENTS = new Set(["delivered", "opened", "hard_bounce", "blocked"]);

// Loose validation: only the fields this route actually reads are
// required. .passthrough() so unrecognized brevo fields don't fail
// parsing — the full raw body is stored in webhook_events.payload
// regardless of which fields we understood.
const brevoWebhookSchema = z
  .object({
    event: z.string(),
    id: z.union([z.string(), z.number()]),
    "message-id": z.string().optional(),
  })
  .passthrough();

/**
 * CONFIRMED from apps/worker/src/brevo.ts's own SendEmailResult type
 * comment: brevo's send API returns an `id` wrapped in angle brackets
 * — e.g. "<20240101120000.1.ABC123@sandbox....brevo.org>" — and per
 * worker.ts's recordSendResult() that value is stored verbatim as
 * campaign_recipients.provider_message_id. So the stored format IS
 * bracketed; that part is no longer a guess.
 *
 * What's still unverified is brevo's webhook payload shape: brevo's
 * documented webhook behavior is to deliver the same id *unwrapped*
 * under event-data.message.headers['message-id'] (this is a
 * long-standing, widely-documented brevo quirk — send API responses
 * are bracketed, webhook headers are not). This function re-wraps it so
 * the equality lookup below still hits provider_message_id's unique
 * index. Since there's no captured real webhook payload to check yet,
 * confirm this against an actual brevo webhook delivery during Phase
 * G4 (end-to-end testing) — if it turns out brevo already includes
 * the brackets, this function becomes a no-op (harmless either way,
 * since it only adds brackets when they're missing) and could be
 * deleted for clarity at that point.
 */
function normalizeProviderMessageId(webhookMessageId: string): string {
  const trimmed = webhookMessageId.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed : `<${trimmed}>`;
}

// POST /api/webhooks/brevo
webhooksRouter.post("/brevo", async (req, res, next) => {
  try {
    const parsed = brevoWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      console.warn("[webhooks] brevo: malformed payload —", parsed.error.issues[0]?.message);
      return res.status(400).json({ error: "Malformed webhook payload" });
    }
    const eventData = parsed.data;

    // 1. Verify token.
    if (!verifyBrevoWebhookToken(req.query.token as string | undefined)) {
      console.warn("[webhooks] brevo: token verification failed");
      return res.status(401).json({ error: "Invalid token" });
    }

    const eventType = eventData.event;
    const providerEventId = String(eventData.id);
    const rawMessageId = eventData["message-id"] ?? null;

    // 2. Idempotent insert of every event, regardless of type, for
    // audit/history. webhook_events is deliberately excluded from RLS
    // (migrations 0004/0005 — it arrives before we know an account_id),
    // and queryUnscoped (packages/db/src/index.ts) is the sanctioned
    // helper for exactly this "don't know the account yet" case — its
    // own doc comment gives "looking up a row before we know the
    // account" as the canonical example, which is exactly this insert.
    const inserted = await queryUnscoped<{ id: string }>(
      `INSERT INTO webhook_events (provider_event_id, provider_message_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING id`,
      [providerEventId, rawMessageId, eventType, JSON.stringify(req.body)]
    );

    // 3. Duplicate delivery (brevo retries on non-200) — already
    // logged, nothing further to do.
    if (inserted.rows.length === 0) {
      return res.status(200).json({ received: true, duplicate: true });
    }

    // 4/5. Only tracked event types continue past here.
    if (!TRACKED_EVENTS.has(eventType)) {
      return res.status(200).json({ received: true, tracked: false });
    }

    if (!rawMessageId) {
      console.warn(`[webhooks] brevo: ${eventType} event ${providerEventId} has no message-id header`);
      return res.status(200).json({ received: true, tracked: true, matched: false });
    }

    const providerMessageId = normalizeProviderMessageId(rawMessageId);

    // campaign_recipients is RLS-protected (migration 0005) and we don't
    // know account_id yet — that's the whole reason we need this lookup.
    // A plain queryUnscoped SELECT would return zero rows here, since
    // app.current_account_id is unset outside withAccountScope's
    // transaction and NULL never matches the policy's USING clause.
    //
    // resolve_campaign_recipient_by_provider_message_id (migration 0006)
    // is a narrow SECURITY DEFINER function, owned by a dedicated
    // NOLOGIN/BYPASSRLS role with column-level SELECT on only (id,
    // account_id). It's the one sanctioned way to cross this gap: no
    // privileged application connection, no broadening of app_user's own
    // grants, and it returns only the two columns this handler actually
    // uses. Still called through queryUnscoped since it's genuinely
    // account-independent by construction (that's the case
    // queryUnscoped's own doc comment describes) — the bypass lives
    // entirely inside the function definition, not in how app_user
    // connects.
    const lookup = await queryUnscoped<{ id: string; account_id: string }>(
      "SELECT id, account_id FROM resolve_campaign_recipient_by_provider_message_id($1)",
      [providerMessageId]
    );

    // 6. Unknown provider_message_id — stale test send, a message from
    // outside this app, or (very rarely) a webhook racing ahead of our
    // own write. Not an error worth retrying: log and acknowledge.
    if (lookup.rows.length === 0) {
      console.warn(
        `[webhooks] brevo: no campaign_recipients row for provider_message_id ${providerMessageId}`
      );
      return res.status(200).json({ received: true, tracked: true, matched: false });
    }

    const recipient = lookup.rows[0];

    // 7. Now properly account-scoped. COALESCE keeps the first-seen
    // timestamp on duplicate/out-of-order events.
    //
    // delivered/opened remain forward-only: the status CASE only
    // advances pending/sent(/delivered) forward, and a recipient that's
    // already 'failed' (a bounce beat a slow 'delivered' webhook to the
    // punch, or vice versa) is left untouched rather than regressed —
    // a message that bounced never actually delivered, whatever order
    // the two webhook calls arrive in.
    //
    // hard_bounce/blocked are the one case allowed to move a recipient
    // OFF 'sent' to 'failed': the send API accepted the message (so it
    // sits at 'sent'), but the address was never actually reachable.
    // Guarded to only fire from pending/sent — never overwrites a
    // recipient that already reached delivered/opened, since a bounce
    // notification can't be correct once delivery is separately
    // confirmed.
    await withAccountScope(recipient.account_id, (client) => {
      if (eventType === "delivered") {
        return client.query(
          `UPDATE campaign_recipients
             SET delivered_at = COALESCE(delivered_at, now()),
                 status = CASE WHEN status IN ('pending', 'sent') THEN 'delivered' ELSE status END
           WHERE id = $1`,
          [recipient.id]
        );
      }
      if (eventType === "opened") {
        return client.query(
          `UPDATE campaign_recipients
             SET opened_at = COALESCE(opened_at, now()),
                 status = CASE WHEN status IN ('pending', 'sent', 'delivered') THEN 'opened' ELSE status END
           WHERE id = $1`,
          [recipient.id]
        );
      }
      // eventType is hard_bounce or blocked — the only other members of
      // TRACKED_EVENTS that can reach this point.
      return client.query(
        `UPDATE campaign_recipients
           SET status = CASE WHEN status IN ('pending', 'sent') THEN 'failed' ELSE status END
         WHERE id = $1`,
        [recipient.id]
      );
    });

    res.status(200).json({ received: true, tracked: true, matched: true });
  } catch (err) {
    next(err);
  }
});