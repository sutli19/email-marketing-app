import "dotenv/config";
import { CAMPAIGN_SEND_QUEUE_NAME } from "@email-app/shared";
import { campaignSendWorker } from "./worker";
import http from "http";
http.createServer((_, res) => res.end("ok")).listen(process.env.PORT || 10000);
console.log(`[worker] started, listening on queue "${CAMPAIGN_SEND_QUEUE_NAME}"`);

// Errors that don't surface through BullMQ's own 'error'/'failed' events
// (e.g. a bug in this file itself) shouldn't take the process down
// silently.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection:", reason);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] received ${signal}, shutting down`);
  try {
    await campaignSendWorker.close();
    process.exit(0);
  } catch (err) {
    console.error("[worker] error during shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));