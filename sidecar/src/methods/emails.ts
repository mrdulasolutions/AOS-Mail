// `emails` IPC namespace — V1 covers the inbox-management verbs:
// archive, trash, batch-archive, batch-trash, archive-thread,
// setStarred, setRead. getThread / search / searchRemote remain
// auto-stubbed and will lift later.
//
// Each verb dispatches by id format (imap:* → IMAP path) so the same
// sidecar code serves both Gmail and IMAP once Gmail's path lifts.

import { registerMethod, emit } from "../rpc.js";
import {
  archiveMessage,
  setReadFlag,
  setStarFlag,
  trashMessage,
} from "../services/providers/imap-actions.js";
import {
  archiveMessageGmail,
  setReadGmail,
  setStarredGmail,
  trashMessageGmail,
} from "../services/providers/gmail-actions.js";
import { getDb } from "../db/index.js";

interface EmailRow {
  id: string;
  thread_id: string;
  account_id: string;
}

// Dispatch on the email id scheme — `imap:<accountId>:<folder>:<uid>` lands
// on imapflow flags/move; `gmail:<accountId>:<gmailId>` lands on the Gmail
// API messages.modify / messages.trash. Each provider produces ids in its
// own format at insert time so this dispatch stays simple.
async function dispatch(
  emailId: string,
  op: "archive" | "trash" | "setRead" | "setStarred",
  flag?: boolean,
): Promise<void> {
  if (emailId.startsWith("imap:")) {
    if (op === "archive") return archiveMessage(emailId);
    if (op === "trash") return trashMessage(emailId);
    if (op === "setRead") return setReadFlag(emailId, !!flag);
    if (op === "setStarred") return setStarFlag(emailId, !!flag);
    return;
  }
  if (emailId.startsWith("gmail:")) {
    if (op === "archive") return archiveMessageGmail(emailId);
    if (op === "trash") return trashMessageGmail(emailId);
    if (op === "setRead") return setReadGmail(emailId, !!flag);
    if (op === "setStarred") return setStarredGmail(emailId, !!flag);
    return;
  }
  throw new Error(`emails.${op}: unknown email id scheme: ${emailId}`);
}

export function registerEmailsMethods(): void {
  registerMethod("emails.archive", async (params) => {
    const { emailId, accountId } = (params as { emailId?: string; accountId?: string }) ?? {};
    if (!emailId) throw new Error("emails.archive: requires { emailId }");
    await dispatch(emailId, "archive");
    if (accountId) {
      emit("sync:emails-removed", { accountId, emailIds: [emailId] });
    }
    return { ok: true };
  });

  registerMethod("emails.batchArchive", async (params) => {
    const { emailIds, accountId } =
      (params as { emailIds?: string[]; accountId?: string }) ?? {};
    if (!Array.isArray(emailIds) || emailIds.length === 0) {
      throw new Error("emails.batchArchive: requires { emailIds: string[] }");
    }
    const errors: string[] = [];
    const removed: string[] = [];
    for (const id of emailIds) {
      try {
        await dispatch(id, "archive");
        removed.push(id);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (accountId && removed.length > 0) {
      emit("sync:emails-removed", { accountId, emailIds: removed });
    }
    return { ok: true, archived: removed.length, errors };
  });

  registerMethod("emails.archiveThread", async (params) => {
    const { threadId, accountId } =
      (params as { threadId?: string; accountId?: string }) ?? {};
    if (!threadId || !accountId) {
      throw new Error("emails.archiveThread: requires { threadId, accountId }");
    }
    const rows = getDb()
      .prepare("SELECT id, thread_id, account_id FROM emails WHERE thread_id = ? AND account_id = ?")
      .all(threadId, accountId) as EmailRow[];
    const errors: string[] = [];
    const removed: string[] = [];
    for (const r of rows) {
      try {
        await dispatch(r.id, "archive");
        removed.push(r.id);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (removed.length > 0) {
      emit("sync:emails-removed", { accountId, emailIds: removed });
    }
    return { ok: true, archived: removed.length, errors };
  });

  registerMethod("emails.trash", async (params) => {
    const { emailId, accountId } = (params as { emailId?: string; accountId?: string }) ?? {};
    if (!emailId) throw new Error("emails.trash: requires { emailId }");
    await dispatch(emailId, "trash");
    if (accountId) {
      emit("sync:emails-removed", { accountId, emailIds: [emailId] });
    }
    return { ok: true };
  });

  registerMethod("emails.batchTrash", async (params) => {
    const { emailIds, accountId } =
      (params as { emailIds?: string[]; accountId?: string }) ?? {};
    if (!Array.isArray(emailIds) || emailIds.length === 0) {
      throw new Error("emails.batchTrash: requires { emailIds: string[] }");
    }
    const errors: string[] = [];
    const removed: string[] = [];
    for (const id of emailIds) {
      try {
        await dispatch(id, "trash");
        removed.push(id);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (accountId && removed.length > 0) {
      emit("sync:emails-removed", { accountId, emailIds: removed });
    }
    return { ok: true, trashed: removed.length, errors };
  });

  registerMethod("emails.setStarred", async (params) => {
    const { emailId, starred } = (params as { emailId?: string; starred?: boolean }) ?? {};
    if (!emailId) throw new Error("emails.setStarred: requires { emailId }");
    await dispatch(emailId, "setStarred", !!starred);
    return { ok: true };
  });

  registerMethod("emails.setRead", async (params) => {
    const { emailId, read } = (params as { emailId?: string; read?: boolean }) ?? {};
    if (!emailId) throw new Error("emails.setRead: requires { emailId }");
    await dispatch(emailId, "setRead", !!read);
    return { ok: true };
  });

  // Returns every message in a thread, sorted oldest-first. The renderer
  // calls this when a thread opens so the conversation view can show
  // earlier messages and (eventually) sent replies. V1 reads from the
  // local emails table — that already includes all inbox messages we've
  // synced. Sent-side merging lands when sync stores SENT/Drafts and
  // Gmail's provider lifts.
  registerMethod("emails.getThread", (params) => {
    const { threadId, accountId } =
      (params as { threadId?: string; accountId?: string }) ?? {};
    if (!threadId || !accountId) {
      throw new Error("emails.getThread: requires { threadId, accountId }");
    }
    type Row = {
      id: string;
      thread_id: string;
      account_id: string;
      subject: string;
      from_address: string;
      to_address: string;
      cc_address: string | null;
      bcc_address: string | null;
      date: string;
      snippet: string | null;
      body: string;
      label_ids: string | null;
      message_id: string | null;
      in_reply_to: string | null;
    };
    const rows = getDb()
      .prepare(
        `SELECT id, thread_id, account_id, subject,
                from_address, to_address, cc_address, bcc_address,
                date, snippet, body, label_ids,
                message_id, in_reply_to
         FROM emails
         WHERE thread_id = ? AND account_id = ?
         ORDER BY date ASC`,
      )
      .all(threadId, accountId) as Row[];
    return rows.map((r) => {
      let labels: string[] = [];
      try {
        labels = r.label_ids ? (JSON.parse(r.label_ids) as string[]) : [];
      } catch {
        labels = [];
      }
      return {
        id: r.id,
        threadId: r.thread_id,
        accountId: r.account_id,
        subject: r.subject,
        from: r.from_address,
        to: r.to_address,
        cc: r.cc_address,
        bcc: r.bcc_address,
        date: r.date,
        snippet: r.snippet,
        body: r.body || null,
        labelIds: r.label_ids,
        isUnread: !labels.includes("READ"),
        messageId: r.message_id,
        inReplyTo: r.in_reply_to,
      };
    });
  });
}
