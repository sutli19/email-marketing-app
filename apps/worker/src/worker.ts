import { Job, Worker } from "bullmq";
import { CAMPAIGN_SEND_QUEUE_NAME, CampaignSendJobData } from "@email-app/shared";
import { withAccountScope } from "@email-app/db";
import { connection } from "./redis";
import { sendEmail } from "./brevo";

interface CampaignRow {
  status: string;
  subject: string;
  body_html: string;
}

interface PendingRecipientRow {
  id: string;
  contact_id: string | null;
  email: string | null;
}

// How many pending recipients each batch transaction pulls and sends
// before the loop commits and goes back for more. Keeps both the query
// result set and the in-flight brevo work bounded regardless of
// campaign size, instead of loading every pending recipient into
// memory at once.
const RECIPIENT_BATCH_SIZE = 100;

/**
 * Short transaction: locks the campaign row just long enough to check
 * its status and, if it's still 'scheduled', flip it to 'sending'.
 * Commits and releases the lock immediately after — nothing here waits
 * on the network. No longer reads recipients itself; batches are now
 * pulled one at a time by fetchPendingRecipientBatch so the full
 * pending set never has to live in memory together.
 *
 * Returns null when there's nothing to send: campaign not found, or its
 * status is neither 'scheduled' nor 'sending' (cancelled back to
 * 'draft', or already finished by a previous attempt).
 */
async function loadCampaignAndClaim(accountId: string, campaignId: string): Promise<CampaignRow | null> {
  return withAccountScope(accountId, async (client) => {
    // FOR UPDATE: the worker-side half of the send/cancel race guard —
    // serializes against a concurrent cancel-schedule request on the
    // same campaign row. Held only for this read/flip, not the sends.
    const existing = await client.query<CampaignRow>(
      "SELECT status, subject, body_html FROM campaigns WHERE id = $1 FOR UPDATE",
      [campaignId]
    );
    if (existing.rows.length === 0) return null;

    const campaign = existing.rows[0];
    if (campaign.status !== "scheduled" && campaign.status !== "sending") {
      return null;
    }

    if (campaign.status === "scheduled") {
      await client.query(
        "UPDATE campaigns SET status = 'sending', updated_at = now() WHERE id = $1",
        [campaignId]
      );
    }

    return campaign;
  });
}

/**
 * Short transaction: pulls up to RECIPIENT_BATCH_SIZE still-pending
 * recipients for this campaign. Called repeatedly by the send loop
 * instead of once up front, so at any moment only one batch's worth of
 * rows is held in memory rather than the whole pending set.
 *
 * No row locking needed here: idempotency across retries and across
 * batches already comes from the `status = 'pending'` filter — each
 * recipient's status flips to 'sent'/'failed' (via recordSendResult)
 * the moment it's attempted, so it drops out of every later batch.
 *
 * ORDER BY created_at, id: without a deterministic order, consecutive
 * LIMIT calls against a changing WHERE set (rows are dropping out of
 * `status = 'pending'` between calls) aren't guaranteed by Postgres to
 * partition the remaining rows cleanly — the same row could in
 * principle be re-returned in a later batch while another is skipped.
 * created_at gives a stable send order matching snapshot order; id is
 * a tiebreaker for rows created in the same instant.
 */
async function fetchPendingRecipientBatch(
  accountId: string,
  campaignId: string
): Promise<PendingRecipientRow[]> {
  return withAccountScope(accountId, async (client) => {
    const pending = await client.query<PendingRecipientRow>(
      `SELECT cr.id, cr.contact_id, c.email
       FROM campaign_recipients cr
       LEFT JOIN contacts c ON c.id = cr.contact_id
       WHERE cr.campaign_id = $1 AND cr.status = 'pending'
       ORDER BY cr.created_at, cr.id
       LIMIT $2`,
      [campaignId, RECIPIENT_BATCH_SIZE]
    );
    return pending.rows;
  });
}

/**
 * Short transaction: records one recipient's send outcome. Called after
 * the brevo call has already returned/thrown — never wraps it.
 */
async function recordSendResult(
  accountId: string,
  recipientId: string,
  outcome: { ok: true; providerMessageId: string } | { ok: false }
): Promise<void> {
  await withAccountScope(accountId, (client) =>
    outcome.ok
      ? client.query(
          `UPDATE campaign_recipients
             SET status = 'sent', provider_message_id = $2, sent_at = now()
           WHERE id = $1`,
          [recipientId, outcome.providerMessageId]
        )
      : client.query("UPDATE campaign_recipients SET status = 'failed' WHERE id = $1", [recipientId])
  );
}

/**
 * Short transaction: rolls the campaign to its final status once every
 * recipient in this run has been attempted.
 *
 * Design decision — the campaigns.status column only has 'sent' and
 * 'failed' as terminal states (no 'partial'), so a run with mixed
 * outcomes has to be folded into one of the two. We resolve that as
 * follows, all based on the run's per-recipient counts:
 *   - all attempted recipients succeeded  → 'sent'   (unambiguous success)
 *   - all attempted recipients failed     → 'failed' (unambiguous failure)
 *   - mixed (some sent, some failed)      → 'sent'   (deliberate choice,
 *     not an oversight: the campaign did go out to part of its
 *     audience, so 'failed' would misrepresent it as never having
 *     sent; 'sent' is the closer of the two available states)
 *
 * This rollup is only ever a summary. The authoritative per-recipient
 * record lives on campaign_recipients regardless of which bucket the
 * campaign lands in — the analytics page reads those rows directly,
 * never this column, so the mixed→'sent' collapse never hides a
 * failure from analytics.
 *
 * sentCount === 0 && failedCount === 0 (nothing was attempted at all,
 * e.g. a campaign with zero snapshotted recipients) falls through to
 * 'failed', matching the pre-existing behavior for that edge case.
 */
async function finalizeCampaign(
  accountId: string,
  campaignId: string,
  sentCount: number,
  failedCount: number
): Promise<void> {
  const allFailed = failedCount > 0 && sentCount === 0;

  await withAccountScope(accountId, (client) =>
    allFailed
      ? client.query("UPDATE campaigns SET status = 'failed', updated_at = now() WHERE id = $1", [
          campaignId,
        ])
      : client.query(
          "UPDATE campaigns SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1",
          [campaignId]
        )
  );
}

/**
 * Processes one campaign's send. Recipients were already resolved and
 * snapshotted into campaign_recipients by the API at send/schedule time
 * (POST /api/campaigns/:id/send) — this only ever reads/updates that
 * existing snapshot. It has no knowledge of audiences, tags, or the
 * pasted-list contact-matching logic; that stays in
 * apps/api/src/routes/campaigns.ts.
 *
 * Deliberately split into many short transactions (claim → one per
 * recipient batch → finalize) instead of one long-lived one spanning
 * the whole job: no transaction and no row lock is ever held while
 * awaiting a brevo call, and no single query has to return the
 * entire pending set at once. Only in-memory JS state
 * (sentCount/failedCount, plus whichever one batch is currently being
 * processed) spans the full job — every DB statement commits and
 * releases immediately around it.
 *
 * Recipients are fetched and processed RECIPIENT_BATCH_SIZE at a time:
 * fetch a batch, send + record every row in it, then go back for the
 * next batch, until a fetch comes back empty. This keeps memory and
 * per-query result size bounded independent of how large the campaign
 * is, rather than loading every pending recipient up front.
 *
 * Idempotent across BullMQ retries and across batches: only rows still
 * `status = 'pending'` are ever selected by fetchPendingRecipientBatch,
 * and recordSendResult flips a row's status the instant it's
 * attempted — so a retried attempt (or the next batch in this same
 * run) never re-sends a recipient a prior attempt already got to.
 */
async function processCampaignSendJob(job: Job<CampaignSendJobData>): Promise<void> {
  const { campaignId, accountId } = job.data;

  const campaign = await loadCampaignAndClaim(accountId, campaignId);
  if (!campaign) {
    console.log(
      `[worker] job ${job.id}: campaign ${campaignId} not found or not scheduled/sending — skipping (likely cancelled or already finished)`
    );
    return;
  }

  let sentCount = 0;
  let failedCount = 0;

  while (true) {
    const batch = await fetchPendingRecipientBatch(accountId, campaignId);
    if (batch.length === 0) break;

    for (const recipient of batch) {
      if (!recipient.email) {
        // Shouldn't happen for a matched row in practice (matched implies
        // a contact_id with an email), but fail closed rather than call
        // brevo with no address.
        await recordSendResult(accountId, recipient.id, { ok: false });
        failedCount++;
        continue;
      }

      try {
        const result = await sendEmail({
          to: recipient.email,
          subject: campaign.subject,
          html: campaign.body_html,
        });
        await recordSendResult(accountId, recipient.id, { ok: true, providerMessageId: result.id });
        sentCount++;
      } catch (err) {
        console.error(`[worker] job ${job.id}: send failed for recipient ${recipient.id}:`, err);
        await recordSendResult(accountId, recipient.id, { ok: false });
        failedCount++;
      }
    }

    // Batch came back smaller than the page size → it was the last one;
    // avoid one extra round-trip that would just confirm "no more rows".
    if (batch.length < RECIPIENT_BATCH_SIZE) break;
  }

  await finalizeCampaign(accountId, campaignId, sentCount, failedCount);

  console.log(
    `[worker] job ${job.id}: campaign ${campaignId} done — ${sentCount} sent, ${failedCount} failed`
  );
}

export const campaignSendWorker = new Worker<CampaignSendJobData>(
  CAMPAIGN_SEND_QUEUE_NAME,
  processCampaignSendJob,
  { connection }
);

campaignSendWorker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

/**
 * Fires on every failed attempt, not just the last one. If retries
 * remain, BullMQ will re-run the job on its own — the campaign is left
 * as-is (likely already 'sending' from this or a prior attempt) and the
 * next attempt's loadCampaignAndClaim will pick up wherever
 * campaign_recipients.status='pending' left off.
 *
 * If this WAS the final attempt (job.attemptsMade >= the configured
 * attempts), no further retry is coming, so the campaign must not be
 * left stuck in 'sending'/'scheduled' forever — it's transitioned to
 * 'failed' here. Guarded by FOR UPDATE + a status check so this can't
 * clobber a campaign that a (slow) final attempt actually managed to
 * finish and mark 'sent' in the moment between the throw and this
 * handler running.
 */
campaignSendWorker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id ?? "unknown"} failed:`, err);
  if (!job) return;

  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) {
    return;
  }

  const { campaignId, accountId } = job.data;
  void withAccountScope(accountId, async (client) => {
    const existing = await client.query<{ status: string }>(
      "SELECT status FROM campaigns WHERE id = $1 FOR UPDATE",
      [campaignId]
    );
    if (existing.rows.length === 0) return;
    if (existing.rows[0].status === "scheduled" || existing.rows[0].status === "sending") {
      await client.query("UPDATE campaigns SET status = 'failed', updated_at = now() WHERE id = $1", [
        campaignId,
      ]);
      console.error(
        `[worker] job ${job.id}: campaign ${campaignId} exhausted all ${maxAttempts} attempts — marked failed`
      );
    }
  }).catch((e) => {
    console.error(`[worker] job ${job.id}: failed to mark campaign ${campaignId} as failed:`, e);
  });
});

// Errors on the Worker itself (e.g. a dropped Redis connection), as
// opposed to a single job throwing — that's the 'failed' event above.
campaignSendWorker.on("error", (err) => {
  console.error("[worker] worker error:", err);
});