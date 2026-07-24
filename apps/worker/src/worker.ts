import { Job, Worker } from "bullmq";
import { CAMPAIGN_SEND_QUEUE_NAME, CampaignSendJobData } from "@email-app/shared";
import { connection } from "./redis";

/**
 * Phase D scaffold only: proves the API → queue → worker pipeline is
 * wired up end to end. The actual send (Mailgun call, campaign_recipients
 * writes, status transitions) is out of scope here — this processor
 * intentionally does nothing but log that the job arrived.
 */
async function processCampaignSendJob(job: Job<CampaignSendJobData>): Promise<void> {
  console.log(
    `[worker] received job ${job.id} on "${CAMPAIGN_SEND_QUEUE_NAME}" for campaign ${job.data.campaignId} (account ${job.data.accountId})`
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

campaignSendWorker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id ?? "unknown"} failed:`, err);
});

// Errors on the Worker itself (e.g. a dropped Redis connection), as
// opposed to a single job throwing — that's the 'failed' event above.
campaignSendWorker.on("error", (err) => {
  console.error("[worker] worker error:", err);
});