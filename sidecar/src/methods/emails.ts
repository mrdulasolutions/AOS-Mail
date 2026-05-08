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
import { getEmailsForThread } from "../services/sync.js";
import { getDb } from "../db/index.js";
import { recordOverride, type LearnedAction } from "../services/learned-rules.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("emails-methods");

interface EmailRow {
  id: string;
  thread_id: string;
  account_id: string;
}

interface AnalysisRow {
  needs_reply: number;
  priority: string | null;
}

/**
 * If the email had an analyses row that said `needs_reply = 1`, the user
 * is disagreeing — feed that into the learned-rules engine so we can
 * auto-handle similar mail in the future.
 *
 * Best-effort: never throws. If classification fails or the email has
 * no analysis row, we just no-op. The user-facing operation (archive /
 * trash) is unaffected.
 */
function maybeRecordOverride(
  emailId: string,
  accountId: string | undefined,
  action: LearnedAction,
): void {
  // No accountId → can't scope a rule. Caller usually passes one; bail
  // quietly when they don't (older callers, batch scenarios with mixed
  // account ids — those route through the per-id loops).
  if (!accountId) return;

  const row = getDb()
    .prepare(`SELECT needs_reply, priority FROM analyses WHERE email_id = ?`)
    .get(emailId) as AnalysisRow | undefined;
  // Only treat as override when the analyzer wanted a reply but the user
  // archived / trashed. Other combos (already needs_reply=false) carry
  // no signal.
  if (!row) return;
  if (row.needs_reply !== 1) return;

  // Fire-and-forget: recordOverride classifies via Claude (haiku) and
  // upserts memories. We don't want to block the IPC verb on it; the
  // sidecar process keeps running so the promise resolves whenever it
  // resolves. Errors get logged but don't bubble to the caller.
  recordOverride({
    emailId,
    accountId,
    override: {
      from: { needsReply: true, priority: row.priority },
      to: { needsReply: false, priority: null },
      action,
    },
  }).catch((err) => {
    log.warn("recordOverride failed", {
      emailId,
      accountId,
      action,
      err: err instanceof Error ? err.message : String(err),
    });
  });
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
    // Learn from this if the user is overriding the analyzer.
    maybeRecordOverride(emailId, accountId, "archived");
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
        maybeRecordOverride(id, accountId, "archived");
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
        maybeRecordOverride(r.id, accountId, "archived");
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
    maybeRecordOverride(emailId, accountId, "trashed");
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
        maybeRecordOverride(id, accountId, "trashed");
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
    // Joined shape matches getEmailsForAccount so the renderer's row
    // mapper sees the analysis + draft fields. Anything that walks a
    // thread (reply context, summary panel, etc.) gets full data.
    return getEmailsForThread(threadId, accountId);
  });
}
