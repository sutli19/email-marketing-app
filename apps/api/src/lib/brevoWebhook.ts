import crypto from "crypto";

// brevo signs each webhook payload with HMAC-SHA256 over
// `timestamp + token`, using the account's webhook signing key (brevo
// dashboard: Sending > Webhooks > "HTTP webhook signing key" — a
// separate secret from the sending API key). See
// https://documentation.brevo.com/en/latest/user_manual.html#webhooks-1
//
// ASSUMPTION (unverified — apps/worker/src/brevo.ts wasn't available
// when this was written): the existing brevo integration doesn't yet
// expose a webhook signing key, so this reads a new env var rather than
// reusing whatever holds the sending API key. Confirm the name below
// matches this project's actual .env / config convention.
const WEBHOOK_SIGNING_KEY = process.env.BREVO_WEBHOOK_SIGNING_KEY;

// Reject signatures on payloads older than this. brevo's own docs
// recommend checking recency to prevent a captured payload from being
// replayed indefinitely; 15 minutes is a generous window that tolerates
// normal clock drift and brevo-side retry delay.
const MAX_SIGNATURE_AGE_SECONDS = 15 * 60;

export interface brevoSignature {
  timestamp: string;
  token: string;
  signature: string;
}

/**
 * Verifies a brevo webhook's `signature` block. Returns false — never
 * throws — for any failure (missing key, malformed input, stale
 * timestamp, mismatched signature), so the route can uniformly respond
 * 401 without needing to distinguish why.
 */
export function verifybrevoSignature(sig: brevoSignature | undefined | null): boolean {
  if (!WEBHOOK_SIGNING_KEY) {
    console.error("[brevoWebhook] BREVO_WEBHOOK_SIGNING_KEY is not configured");
    return false;
  }
  if (!sig || !sig.timestamp || !sig.token || !sig.signature) {
    return false;
  }

  const timestampSeconds = Number(sig.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > MAX_SIGNATURE_AGE_SECONDS) return false;

  const expected = crypto.createHmac("sha256", WEBHOOK_SIGNING_KEY).update(sig.timestamp + sig.token).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(sig.signature, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}