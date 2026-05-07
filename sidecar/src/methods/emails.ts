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
import { getDb } from "../db/index.js";

interface EmailRow {
  id: string;
  thread_id: string;
  account_id: string;
}

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
  throw new Error(`emails.${op}: Gmail provider path not yet wired in sidecar`);
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
}
