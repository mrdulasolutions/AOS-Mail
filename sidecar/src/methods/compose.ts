// `compose` IPC namespace — V1 covers `compose.send` for IMAP/SMTP
// accounts. Gmail send (via Gmail API) lifts later when the rest of
// the gmail-client code ports.
//
// On send success we insert a row into the emails table tagged with the
// SENT label so it shows up in the Sent view immediately. The renderer
// also adds it via the sync:new-emails event for the in-memory store.

import { randomUUID } from "node:crypto";
import { registerMethod, emit } from "../rpc.js";
import { sendViaSmtp, type SendInput } from "../services/providers/smtp-send.js";
import { getDb } from "../db/index.js";

interface AccountInfo {
  id: string;
  email: string;
  provider: string;
}

function getAccount(accountId: string): AccountInfo | null {
  return (
    (getDb()
      .prepare("SELECT id, email, COALESCE(provider, 'gmail') as provider FROM accounts WHERE id = ?")
      .get(accountId) as AccountInfo | undefined) ?? null
  );
}

function recordSentEmail(input: SendInput, messageId: string): {
  id: string;
  threadId: string;
} {
  const id = `sent:${input.accountId}:${randomUUID()}`;
  const threadId = input.inReplyTo ?? messageId ?? id;
  const labels = JSON.stringify(["SENT", "READ"]);
  const date = new Date().toISOString();
  const fromName = input.recipientNames?.[input.from ?? ""] ?? "";
  const fromAddress = fromName
    ? `"${fromName.replace(/"/g, '\\"')}" <${input.from}>`
    : (input.from ?? "");
  getDb()
    .prepare(
      `INSERT INTO emails (
          id, account_id, thread_id, subject,
          from_address, to_address, cc_address, bcc_address,
          body, body_text, snippet,
          date, fetched_at, label_ids, attachments,
          message_id, in_reply_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.accountId,
      threadId,
      input.subject,
      fromAddress,
      input.to.join(", "),
      input.cc?.join(", ") ?? null,
      input.bcc?.join(", ") ?? null,
      input.bodyHtml ?? input.bodyText ?? "",
      input.bodyText ?? null,
      (input.bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      date,
      Date.now(),
      labels,
      null,
      messageId,
      input.inReplyTo ?? null,
    );
  return { id, threadId };
}

export function registerComposeMethods(): void {
  registerMethod("compose.send", async (params) => {
    const input = params as SendInput;
    if (!input?.accountId) throw new Error("compose.send: requires { accountId }");
    if (!input.to || input.to.length === 0) throw new Error("compose.send: requires { to }");

    const account = getAccount(input.accountId);
    if (!account) throw new Error(`compose.send: account ${input.accountId} not found`);

    if (account.provider === "gmail") {
      throw new Error("compose.send: Gmail send via Gmail API not yet implemented in sidecar");
    }
    if (account.provider !== "imap") {
      throw new Error(`compose.send: unknown provider '${account.provider}'`);
    }

    const result = await sendViaSmtp({ ...input, from: input.from ?? account.email });
    const { id, threadId } = recordSentEmail(
      { ...input, from: input.from ?? account.email },
      result.messageId,
    );

    emit("sync:new-sent-emails", {
      accountId: input.accountId,
      emails: [
        {
          id,
          threadId,
          accountId: input.accountId,
          subject: input.subject,
          from: input.from ?? account.email,
          to: input.to.join(", "),
          cc: input.cc?.join(", ") ?? null,
          bcc: input.bcc?.join(", ") ?? null,
          date: new Date().toISOString(),
          snippet: (input.bodyText ?? "").slice(0, 200),
          body: input.bodyHtml ?? input.bodyText ?? "",
          labelIds: '["SENT","READ"]',
          isUnread: false,
          messageId: result.messageId,
          inReplyTo: input.inReplyTo ?? null,
        },
      ],
    });

    return {
      id,
      threadId,
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
    };
  });

  // Local drafts are persisted in the local_drafts table. V1 stubs return
  // success but do nothing; the renderer's compose flow can still serialize
  // a draft locally without losing data on app restart.
  registerMethod("compose.listLocalDrafts", () => ({ success: true, data: [] }));

  // Send-as aliases — Gmail can have multiple sender identities. IMAP
  // accounts currently always send "from" the configured email. Returns
  // an empty list; renderer falls back to the primary email.
  registerMethod("compose.getSendAsAliases", () => ({ aliases: [] }));
}
