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
import { sendViaGmail } from "../services/providers/gmail-send.js";
import { getDb } from "../db/index.js";
import type { LocalDraft } from "../../../src/shared/types.js";

interface AccountInfo {
  id: string;
  email: string;
  provider: string;
}

function getAccount(accountId: string): AccountInfo | null {
  return (
    (getDb()
      .prepare(
        "SELECT id, email, COALESCE(provider, 'gmail') as provider FROM accounts WHERE id = ?",
      )
      .get(accountId) as AccountInfo | undefined) ?? null
  );
}

function recordSentEmail(
  input: SendInput,
  messageId: string,
): {
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

    if (account.provider !== "gmail" && account.provider !== "imap") {
      throw new Error(`compose.send: unknown provider '${account.provider}'`);
    }

    const enrichedInput: SendInput = {
      ...input,
      from: input.from ?? account.email,
    };

    let messageId: string;
    let accepted: string[] = [];
    let rejected: string[] = [];
    if (account.provider === "gmail") {
      const sent = await sendViaGmail(enrichedInput);
      messageId = sent.messageId;
      // Gmail's API doesn't return per-recipient delivery status — anything
      // it accepts goes to the recipient list, and rejections come back as
      // a thrown error. Mirror SMTP's shape so the renderer can stay
      // provider-agnostic.
      accepted = enrichedInput.to;
    } else {
      const sent = await sendViaSmtp(enrichedInput);
      messageId = sent.messageId;
      accepted = sent.accepted;
      rejected = sent.rejected;
    }
    const { id, threadId } = recordSentEmail(enrichedInput, messageId);

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
          messageId,
          inReplyTo: input.inReplyTo ?? null,
        },
      ],
    });

    // Partial failure: SMTP accepted SOME recipients but the server
    // rejected others (typically bad addresses, filter blocks, or
    // recipient-side policy). nodemailer surfaces this as a successful
    // send with a non-empty `rejected` array — without the throw below,
    // the renderer treats `success: true` as "all sent" and the user
    // never sees that some recipients didn't get the message. The
    // message DID send to the accepted set, so we still record the sent
    // row (above) and emit the new-sent event, then throw a structured
    // error so the renderer can surface a clear "Sent to X, failed for
    // Y" toast instead of a silent success.
    //
    // The kind: "partial-send" prefix lets the renderer parse this out
    // of the error message without coupling to a side channel.
    if (rejected.length > 0) {
      const err = new Error(
        `partial-send: delivered to ${accepted.length}, rejected ${rejected.length} (${rejected.join(", ")})`,
      ) as Error & {
        kind: "partial-send";
        accepted: string[];
        rejected: string[];
        messageId: string;
        id: string;
        threadId: string;
      };
      err.kind = "partial-send";
      err.accepted = accepted;
      err.rejected = rejected;
      err.messageId = messageId;
      err.id = id;
      err.threadId = threadId;
      throw err;
    }

    return { id, threadId, messageId, accepted, rejected };
  });

  // Local drafts — persisted in the local_drafts table so a reload doesn't
  // lose in-progress messages. The renderer (EmailDetail / NewEmailCompose)
  // saves on close and restores from this list on boot. Schema is the
  // LocalDraftSchema in src/shared/types.ts; we round-trip JSON for the
  // address arrays and emit camelCase out.

  type LocalDraftRow = {
    id: string;
    account_id: string;
    gmail_draft_id: string | null;
    thread_id: string | null;
    in_reply_to: string | null;
    from_address: string | null;
    to_addresses: string;
    cc_addresses: string | null;
    bcc_addresses: string | null;
    subject: string;
    body_html: string;
    body_text: string | null;
    is_reply: number;
    is_forward: number;
    created_at: number;
    updated_at: number;
    synced_at: number | null;
  };

  function rowToLocalDraft(r: LocalDraftRow): LocalDraft {
    const parseAddrs = (raw: string | null): string[] | undefined => {
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? (parsed as string[]) : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      id: r.id,
      accountId: r.account_id,
      gmailDraftId: r.gmail_draft_id ?? undefined,
      threadId: r.thread_id ?? undefined,
      inReplyTo: r.in_reply_to ?? undefined,
      fromAddress: r.from_address ?? undefined,
      to: parseAddrs(r.to_addresses) ?? [],
      cc: parseAddrs(r.cc_addresses),
      bcc: parseAddrs(r.bcc_addresses),
      subject: r.subject,
      bodyHtml: r.body_html,
      bodyText: r.body_text ?? undefined,
      isReply: r.is_reply === 1,
      isForward: r.is_forward === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      syncedAt: r.synced_at ?? undefined,
    };
  }

  registerMethod("compose.listLocalDrafts", () => {
    const rows = getDb()
      .prepare(
        `SELECT id, account_id, gmail_draft_id, thread_id, in_reply_to,
                from_address, to_addresses, cc_addresses, bcc_addresses,
                subject, body_html, body_text, is_reply, is_forward,
                created_at, updated_at, synced_at
         FROM local_drafts
         ORDER BY updated_at DESC`,
      )
      .all() as LocalDraftRow[];
    return rows.map(rowToLocalDraft);
  });

  registerMethod("compose.saveLocalDraft", (params) => {
    const p = (params ?? {}) as {
      accountId?: string;
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      bodyHtml?: string;
      bodyText?: string;
      fromAddress?: string;
      threadId?: string;
      inReplyTo?: string;
      isReply?: boolean;
      isForward?: boolean;
    };
    if (!p.accountId) throw new Error("compose.saveLocalDraft: requires { accountId }");
    const id = `local:${randomUUID()}`;
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO local_drafts (
            id, account_id, gmail_draft_id, thread_id, in_reply_to,
            from_address, to_addresses, cc_addresses, bcc_addresses,
            subject, body_html, body_text, is_reply, is_forward,
            created_at, updated_at, synced_at
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        p.accountId,
        p.threadId ?? null,
        p.inReplyTo ?? null,
        p.fromAddress ?? null,
        JSON.stringify(p.to ?? []),
        p.cc && p.cc.length > 0 ? JSON.stringify(p.cc) : null,
        p.bcc && p.bcc.length > 0 ? JSON.stringify(p.bcc) : null,
        p.subject ?? "",
        p.bodyHtml ?? "",
        p.bodyText ?? null,
        p.isReply ? 1 : 0,
        p.isForward ? 1 : 0,
        now,
        now,
      );
    const row = getDb()
      .prepare(
        `SELECT id, account_id, gmail_draft_id, thread_id, in_reply_to,
                from_address, to_addresses, cc_addresses, bcc_addresses,
                subject, body_html, body_text, is_reply, is_forward,
                created_at, updated_at, synced_at
         FROM local_drafts WHERE id = ?`,
      )
      .get(id) as LocalDraftRow;
    return rowToLocalDraft(row);
  });

  registerMethod("compose.updateLocalDraft", (params) => {
    const p = (params ?? {}) as {
      id?: string;
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      bodyHtml?: string;
      bodyText?: string;
      fromAddress?: string;
    };
    if (!p.id) throw new Error("compose.updateLocalDraft: requires { id }");
    // Build the SET clause from only the fields the caller passed — leaves
    // other columns untouched. updated_at always bumps.
    const sets: string[] = ["updated_at = ?"];
    const vals: Array<string | number | null> = [Date.now()];
    if (p.to !== undefined) {
      sets.push("to_addresses = ?");
      vals.push(JSON.stringify(p.to));
    }
    if (p.cc !== undefined) {
      sets.push("cc_addresses = ?");
      vals.push(p.cc && p.cc.length > 0 ? JSON.stringify(p.cc) : null);
    }
    if (p.bcc !== undefined) {
      sets.push("bcc_addresses = ?");
      vals.push(p.bcc && p.bcc.length > 0 ? JSON.stringify(p.bcc) : null);
    }
    if (p.subject !== undefined) {
      sets.push("subject = ?");
      vals.push(p.subject);
    }
    if (p.bodyHtml !== undefined) {
      sets.push("body_html = ?");
      vals.push(p.bodyHtml);
    }
    if (p.bodyText !== undefined) {
      sets.push("body_text = ?");
      vals.push(p.bodyText);
    }
    if (p.fromAddress !== undefined) {
      sets.push("from_address = ?");
      vals.push(p.fromAddress);
    }
    vals.push(p.id);
    getDb()
      .prepare(`UPDATE local_drafts SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals);
    const row = getDb()
      .prepare(
        `SELECT id, account_id, gmail_draft_id, thread_id, in_reply_to,
                from_address, to_addresses, cc_addresses, bcc_addresses,
                subject, body_html, body_text, is_reply, is_forward,
                created_at, updated_at, synced_at
         FROM local_drafts WHERE id = ?`,
      )
      .get(p.id) as LocalDraftRow | undefined;
    return row ? rowToLocalDraft(row) : null;
  });

  registerMethod("compose.deleteLocalDraft", (params) => {
    const id = (params as { id?: string })?.id;
    if (!id) throw new Error("compose.deleteLocalDraft: requires { id }");
    getDb().prepare("DELETE FROM local_drafts WHERE id = ?").run(id);
    return { ok: true };
  });

  // Send-as aliases — Gmail can have multiple sender identities. IMAP
  // accounts currently always send "from" the configured email. Returns
  // an empty list; renderer falls back to the primary email.
  registerMethod("compose.getSendAsAliases", () => ({ aliases: [] }));
}
