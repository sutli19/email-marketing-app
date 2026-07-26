import { BrevoClient } from "@getbrevo/brevo";

// Verified against the installed @getbrevo/brevo v6.0.2 package (dist/cjs/*.d.ts):
// - `BrevoClient` is the only client class; there is no `TransactionalEmailsApi`
//   in this version.
// - Auth is a constructor option (`new BrevoClient({ apiKey })`) — no
//   `setApiKey()` call and no separate API-key enum.
// - `client.transactionalEmails.sendTransacEmail(request)` takes a plain
//   object (`Brevo.SendTransacEmailRequest`), not a `SendSmtpEmail` class
//   instance.
// - The call returns an `HttpResponsePromise<SendTransacEmailResponse>`;
//   awaiting it directly resolves to the parsed response body itself
//   (confirmed in HttpResponsePromise.d.ts — no `.body` wrapper). Raw
//   headers are only reachable via the separate `.withRawResponse()` method,
//   which this function doesn't need.
// - `SendTransacEmailResponse` only declares `messageId?: string` (and a
//   batch-only `messageIds?: string[]`), so `messageId` may legitimately be
//   absent and must be read defensively.
//
// The client is still built lazily inside getClient(), matching the
// existing architecture — just against the real v6 constructor shape.
let cachedClient: BrevoClient | undefined;

function getClient(): BrevoClient {
  if (cachedClient) {
    return cachedClient;
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error("BREVO_API_KEY is not set — cannot send email");
  }

  cachedClient = new BrevoClient({ apiKey });
  return cachedClient;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  /** Defaults to BREVO_FROM_EMAIL when omitted. */
  from?: string;
}

export interface SendEmailResult {
  /** Brevo's message id, e.g. "<202401011200.12345.ABCDEF@smtp-relay.mailin.fr>" */
  id: string;
  /** Human-readable status. Brevo's API doesn't return one, so this is synthesized. */
  message: string;
}

/**
 * Sends a single email through Brevo.
 *
 * This module only wraps the Brevo API call, its config, and its
 * error/response shape into one typed function — it doesn't know about
 * campaigns, contacts, or the database. Calling this from the BullMQ
 * job processor, writing campaign_recipients rows from the result, and
 * retry behavior on failure are Phase F's job, not this one's.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  // getClient() throws if BREVO_API_KEY is missing, so no separate check needed here.
  const client = getClient();

  const from = params.from ?? process.env.BREVO_FROM_EMAIL;
  if (!from) {
    throw new Error("No 'from' address: pass one explicitly or set BREVO_FROM_EMAIL");
  }

  const senderName = process.env.BREVO_FROM_NAME;

  try {
    const result = await client.transactionalEmails.sendTransacEmail({
      subject: params.subject,
      htmlContent: params.html,
      sender: senderName ? { email: from, name: senderName } : { email: from },
      to: [{ email: params.to }],
    });

    // `messageId` is optional on SendTransacEmailResponse, so don't assume
    // it's always present.
    const messageId = result.messageId ?? "";

    console.log(`[brevo] sent to ${params.to}: ${messageId || "(no id returned)"}`);

    return {
      id: messageId,
      message: messageId ? "Queued. Thank you." : "",
    };
  } catch (err) {
    // v6 throws `BrevoError` (and its subclass `BrevoTimeoutError`) for
    // API/network failures — both extend the built-in `Error`, so they're
    // already rethrown as-is by the `err instanceof Error` check below.
    // No separate `BrevoError` check is needed.
    console.error(`[brevo] failed to send to ${params.to}:`, err);
    throw err instanceof Error ? err : new Error(`Brevo send failed: ${String(err)}`);
  }
}