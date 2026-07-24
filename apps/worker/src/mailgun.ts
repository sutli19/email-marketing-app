import Mailgun from "mailgun.js";
import FormData from "form-data";

// Initialized once at module load and reused for every send — same
// "one client/connection, import it everywhere" convention as
// packages/db/src/index.ts's `pool` and this package's own redis.ts
// `connection`. mailgun.js takes a FormData implementation as a
// constructor argument rather than bundling one, hence the `form-data`
// package alongside it.
const mailgun = new Mailgun(FormData);
const mgClient = mailgun.client({
  username: "api",
  key: process.env.MAILGUN_API_KEY ?? "",
});

const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN;
const MAILGUN_FROM_EMAIL = process.env.MAILGUN_FROM_EMAIL;

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  /** Defaults to MAILGUN_FROM_EMAIL when omitted. */
  from?: string;
}

export interface SendEmailResult {
  /** Mailgun's message id, e.g. "<20240101120000.1.ABC123@sandbox....mailgun.org>" */
  id: string;
  /** Mailgun's human-readable status, e.g. "Queued. Thank you." */
  message: string;
}

/**
 * Sends a single email through Mailgun.
 *
 * This module only wraps the Mailgun API call, its config, and its
 * error/response shape into one typed function — it doesn't know about
 * campaigns, contacts, or the database. Calling this from the BullMQ
 * job processor, writing campaign_recipients rows from the result, and
 * retry behavior on failure are Phase F's job, not this one's.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  if (!process.env.MAILGUN_API_KEY) {
    throw new Error("MAILGUN_API_KEY is not set — cannot send email");
  }
  if (!MAILGUN_DOMAIN) {
    throw new Error("MAILGUN_DOMAIN is not set — cannot send email");
  }
  const from = params.from ?? MAILGUN_FROM_EMAIL;
  if (!from) {
    throw new Error("No 'from' address: pass one explicitly or set MAILGUN_FROM_EMAIL");
  }

  try {
    const result = await mgClient.messages.create(MAILGUN_DOMAIN, {
      from,
      to: params.to,
      subject: params.subject,
      html: params.html,
    });

    console.log(`[mailgun] sent to ${params.to}: ${result.id ?? "(no id returned)"}`);

    return {
      id: result.id ?? "",
      message: result.message ?? "",
    };
  } catch (err) {
    console.error(`[mailgun] failed to send to ${params.to}:`, err);
    throw err instanceof Error ? err : new Error(`Mailgun send failed: ${String(err)}`);
  }
}