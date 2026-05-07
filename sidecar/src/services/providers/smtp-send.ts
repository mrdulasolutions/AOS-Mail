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

  const transporter = nodemailer.createTransport({
    host: creds.smtp.host,
    port: creds.smtp.port,
    secure: creds.smtp.tls && creds.smtp.port === 465,
    requireTLS: creds.smtp.tls && creds.smtp.port !== 465,
    auth: { user: creds.smtp.username, pass: creds.password },
  });

  const fromAddress = input.from ?? creds.email;
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

  return {
    messageId: result.messageId,
    accepted: (result.accepted ?? []).map(String),
    rejected: (result.rejected ?? []).map(String),
    envelope: result.envelope as { from: string; to: string[] } | undefined,
  };
}
