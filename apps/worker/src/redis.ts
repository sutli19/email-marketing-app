import IORedis from "ioredis";
import "dotenv/config";

// Single connection shared by every Queue/Worker in this package, same
// "one pool/connection, import it everywhere" convention as
// packages/db/src/index.ts's `pool`.
//
// `maxRetriesPerRequest: null` is required by BullMQ for any connection
// used by a Worker (and recommended for Queues) — BullMQ manages its own
// retry/blocking behavior on top of ioredis and will throw at runtime if
// this isn't set.
export const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

connection.on("error", (err) => {
  console.error("[worker] redis connection error:", err);
});