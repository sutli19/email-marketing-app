import { Queue } from "bullmq";
import IORedis from "ioredis";
import "dotenv/config";
import { CAMPAIGN_SEND_QUEUE_NAME } from "@email-app/shared";

// Single connection, imported everywhere it's needed on the API side —
// same convention as apps/worker/src/redis.ts's `connection` and
// packages/db/src/index.ts's `pool`.
//
// `maxRetriesPerRequest: null` isn't strictly required for a Queue (only
// for a Worker), but it's set here anyway to match the worker's redis.ts
// and avoid ioredis's default retry behavior surprising a producer call
// mid-request.
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

connection.on("error", (err) => {
  console.error("[api] redis connection error:", err);
});

// The API only ever produces jobs onto this queue (add / remove). It
// never processes them — that's apps/worker/src/worker.ts's job, which
// owns its own separate connection to the same Redis instance.
//
// defaultJobOptions applies to every job added via .add() below unless
// overridden per-call. attempts/backoff live here rather than at each
// call site since they're a constant policy, not something that varies
// per send. removeOnComplete/removeOnFail keep Redis from accumulating
// finished job records forever — a bounded recent history (by count) is
// kept for debugging, rather than either deleting immediately or never.
export const campaignSendQueue = new Queue(CAMPAIGN_SEND_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});