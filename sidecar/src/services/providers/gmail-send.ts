// Gmail-API send + draft-create — parallel of smtp-send.ts.
//
// We hand-build a minimal RFC 822 message and pass it to messages.send /
// drafts.create. The Electron version used a heavier MIME builder; for V1
// we cover the cases our composer actually emits:
//   - text/plain only
//   - text/html only
//   - multipart/alternative with text + html
//   - non-ASCII subjects via MIME encoded-word
// File attachments aren't yet supported here (the composer's attachment
// picker is also still V2). Adding them is a multipart/mixed wrapper —
// straightforward when the upstream UI lands.

import { google } from "googleapis";
import { authedClientForAccount } from "../oauth-gmail.js";
import type { SendInput } from "./smtp-send.js";

function gmailClient(accountId: string) {
  return google.gmail({
    version: "v1",
    auth: authedClientForAccount(accountId),
  });
}

/**
 * Encode a string as a MIME encoded-word if it contains any non-ASCII bytes.
 * Pure ASCII passes through unchanged; otherwise we wrap as
 * `=?UTF-8?B?<base64>?=` per RFC 2047. Subject and From display names need
 * this; address spec parts (the `<addr@host>` portion) must remain ASCII.
 */
function encodeMimeWord(s: string): string {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

/** CRLF-joined RFC 822 message → base64url for the Gmail API. */
function buildRawMessage(input: SendInput, fromAddress: string): string {
  const lines: string[] = [];
  const boundary = `aosmail_alt_${Math.random().toString(36).slice(2)}`;

  const hasHtml = !!input.bodyHtml;
  const hasText = !!input.bodyText;

  lines.push(`From: ${fromAddress}`);
  lines.push(`To: ${input.to.join(", ")}`);
  if (input.cc && input.cc.length > 0) {
    lines.push(`Cc: ${input.cc.join(", ")}`);
  }
  if (input.bcc && input.bcc.length > 0) {
    lines.push(`Bcc: ${input.bcc.join(", ")}`);
  }
  lines.push(`Subject: ${encodeMimeWord(input.subject)}`);
  if (input.inReplyTo) {
    // Gmail threads on the In-Reply-To header even when threadId is
    // passed; sending both is harmless but threadId is authoritative.
    lines.push(`In-Reply-To: ${input.inReplyTo}`);
    lines.push(`References: ${input.references || input.inReplyTo}`);
  }
  lines.push(`MIME-Version: 1.0`);

  if (hasHtml && hasText) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(input.bodyText!);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(input.bodyHtml!);
    lines.push("");
    lines.push(`--${boundary}--`);
  } else if (hasHtml) {
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(input.bodyHtml!);
  } else {
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(input.bodyText || "");
  }

  const message = lines.join("\r\n");
  // Gmail API expects URL-safe base64. Buffer's `base64url` does the right
  // encoding (no padding, '-'/'_' instead of '+'/'/'). On Node 18+ it's a
  // first-class encoding string.
  return Buffer.from(message, "utf-8").toString("base64url");
}

export interface GmailSendResult {
  /** Provider-side message id (Gmail's, not RFC 822). */
  id: string;
  /** Gmail thread id for the sent message. */
  threadId: string;
  /** RFC 822 Message-ID — Gmail's send API doesn't return this directly so
   * we re-fetch the sent message to get the header. */
  messageId: string;
}

/** Send a message via the Gmail API. Returns ids for caller bookkeeping. */
export async function sendViaGmail(input: SendInput): Promise<GmailSendResult> {
  if (!input.from) throw new Error("sendViaGmail: requires { from }");
  const gmail = gmailClient(input.accountId);
  const raw = buildRawMessage(input, input.from);
  const send = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: input.threadId,
    },
  });
  const id = send.data.id || "";
  const threadId = send.data.threadId || id;

  // Re-fetch to grab the RFC 822 Message-ID header — useful for thread-
  // continuity if the user later replies to their own sent message via
  // another client.
  let messageIdHeader = id;
  if (id) {
    try {
      const get = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["Message-ID"],
      });
      const headers = get.data.payload?.headers || [];
      const found = headers.find(
        (h) => h.name?.toLowerCase() === "message-id",
      );
      if (found?.value) messageIdHeader = found.value;
    } catch {
      // Best-effort; falling back to Gmail's id is fine for local bookkeeping.
    }
  }
  return { id, threadId, messageId: messageIdHeader };
}

/** Create a Gmail draft. Used by gmail.createDraft for compose autosave. */
export async function createDraftGmail(
  input: SendInput,
): Promise<{ draftId: string; messageId: string; threadId: string }> {
  if (!input.from) throw new Error("createDraftGmail: requires { from }");
  const gmail = gmailClient(input.accountId);
  const raw = buildRawMessage(input, input.from);
  const response = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { raw, threadId: input.threadId },
    },
  });
  return {
    draftId: response.data.id || "",
    messageId: response.data.message?.id || "",
    threadId: response.data.message?.threadId || "",
  };
}

/** Update an existing Gmail draft (autosave on edit). */
export async function updateDraftGmail(
  draftId: string,
  input: SendInput,
): Promise<{ draftId: string; messageId: string; threadId: string }> {
  if (!input.from) throw new Error("updateDraftGmail: requires { from }");
  const gmail = gmailClient(input.accountId);
  const raw = buildRawMessage(input, input.from);
  const response = await gmail.users.drafts.update({
    userId: "me",
    id: draftId,
    requestBody: {
      message: { raw, threadId: input.threadId },
    },
  });
  return {
    draftId: response.data.id || draftId,
    messageId: response.data.message?.id || "",
    threadId: response.data.message?.threadId || "",
  };
}
