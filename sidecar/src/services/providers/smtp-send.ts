// SMTP send helper for IMAP-paired accounts.
//
// Uses nodemailer + the credentials persisted by oauth-gmail's IMAP
// counterpart. V1 supports text + HTML bodies, attachments via inline
// content (file path-based attachments will land alongside the
// attachments namespace lift).
//
// Returns the SMTP server's accepted Message-ID so the caller can stash
// it in the emails table (label_ids += SENT) for the Sent view.

import nodemailer from "nodemailer";
import { loadImapCredentials } from "./imap-creds.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("smtp");

export interface SendInput {
  accountId: string;
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string;
  recipientNames?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    path?: string;
    content?: string; // base64 if no path
    mimeType: string;
  }>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  envelope?: { from: string; to: string[] };
}

function decorate(addr: string, names?: Record<string, string>): string {
  const name = names?.[addr];
  return name ? `"${name.replace(/"/g, '\\"')}" <${addr}>` : addr;
}

export async function sendViaSmtp(input: SendInput): Promise<SendResult> {
  const creds = loadImapCredentials(input.accountId);
  if (!creds) {
    throw new Error(`No IMAP/SMTP credentials for account ${input.accountId}`);
  }

  // Standard SMTP port semantics:
  //   465 → implicit TLS (secure: true)
  //   587 → STARTTLS upgrade (secure: false, requireTLS: true)
  //   25  → plaintext (rare; only when tls=false)
  // Some servers accept either on 465/587; the heuristic above is safest.
  const isImplicitTls = creds.smtp.tls && creds.smtp.port === 465;
  const transporter = nodemailer.createTransport({
    host: creds.smtp.host,
    port: creds.smtp.port,
    secure: isImplicitTls,
    requireTLS: creds.smtp.tls && !isImplicitTls,
    auth: { user: creds.smtp.username, pass: creds.password },
    // Verify the cert. Self-signed certs will throw — surface that
    // clearly instead of pretending things are fine.
    tls: { rejectUnauthorized: true },
    // Time out after 30s rather than hanging forever on a bad host.
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 30_000,
  });

  const fromAddress = input.from ?? creds.email;

  // Verify auth before send so we can return a clear error message rather
  // than "Invalid login" buried in nodemailer internals.
  try {
    await transporter.verify();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("SMTP verify failed", {
      accountId: input.accountId,
      host: creds.smtp.host,
      port: creds.smtp.port,
      err: msg,
    });
    if (/invalid login|auth|credentials|535/i.test(msg)) {
      throw new Error(
        `SMTP login failed (${creds.smtp.host}:${creds.smtp.port}). ` +
          `If your provider requires an app-specific password, the IMAP password ` +
          `was probably accepted but SMTP needs the same one applied to the ` +
          `app-password setting. Original error: ${msg}`,
      );
    }
    throw new Error(`SMTP connection failed: ${msg}`);
  }

  try {
    const result = await transporter.sendMail({
      from: decorate(fromAddress, input.recipientNames),
      to: input.to.map((a) => decorate(a, input.recipientNames)),
      cc: input.cc?.map((a) => decorate(a, input.recipientNames)),
      bcc: input.bcc?.map((a) => decorate(a, input.recipientNames)),
      subject: input.subject,
      text: input.bodyText,
      html: input.bodyHtml,
      inReplyTo: input.inReplyTo,
      references: input.references,
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        path: a.path,
        content: a.content,
        contentType: a.mimeType,
        encoding: a.path ? undefined : "base64",
      })),
    });
    log.info("sent", {
      accountId: input.accountId,
      messageId: result.messageId,
      accepted: result.accepted?.length ?? 0,
      rejected: result.rejected?.length ?? 0,
    });
    return {
      messageId: result.messageId,
      accepted: (result.accepted ?? []).map(String),
      rejected: (result.rejected ?? []).map(String),
      envelope: result.envelope as { from: string; to: string[] } | undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("SMTP send failed", {
      accountId: input.accountId,
      host: creds.smtp.host,
      port: creds.smtp.port,
      err: msg,
    });
    throw new Error(`SMTP send failed: ${msg}`);
  }
}
