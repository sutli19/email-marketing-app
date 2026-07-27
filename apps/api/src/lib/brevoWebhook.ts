import crypto from "crypto";

// Brevo does NOT sign webhook bodies with an HMAC the way Mailgun does.
// This "signing key" is really just a shared secret you embed in the
// webhook URL you register in the Brevo dashboard, e.g.
// `https://your-api/api/webhooks/brevo?token=<this value>`, and we
// check that query param here.
const WEBHOOK_SIGNING_KEY = process.env.BREVO_WEBHOOK_SIGNING_KEY;

export function verifyBrevoWebhookToken(providedToken: string | undefined | null): boolean {
  if (!WEBHOOK_SIGNING_KEY) {
    console.error("[brevoWebhook] BREVO_WEBHOOK_SIGNING_KEY is not configured");
    return false;
  }
  if (!providedToken) {
    return false;
  }

  const expectedBuf = Buffer.from(WEBHOOK_SIGNING_KEY);
  const actualBuf = Buffer.from(providedToken);
  if (expectedBuf.length !== actualBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}