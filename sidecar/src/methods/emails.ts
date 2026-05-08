// `emails` IPC namespace — V1 covers the inbox-management verbs:
// archive, trash, batch-archive, batch-trash, archive-thread,
// setStarred, setRead, plus searchRemote for server-side mailbox search.
// getThread / search remain auto-stubbed and will lift later.
//
// Each verb dispatches by id format (imap:* → IMAP path) so the same
// sidecar code serves both Gmail and IMAP once Gmail's path lifts.

import { registerMethod, emit } from "../rpc.js";
import {
  archiveMessage,
  setReadFlag,
  setStarFlag,
  trashMessage,
  unarchiveMessage,
} from "../services/providers/imap-actions.js";
import {
  archiveMessageGmail,
  setReadGmail,
  setStarredGmail,
  trashMessageGmail,
  unarchiveMessageGmail,
} from "../services/providers/gmail-actions.js";
import {
  getGmailHeaders,
  searchGmailMessages,
  type GmailMessageHeader,
} from "../services/providers/gmail-fetch.js";
import { searchImapMessages, type ImapMessageHeader } from "../services/providers/imap-fetch.js";
import { getEmailsForThread, type DashboardEmailRow } from "../services/sync.js";
import { getDb } from "../db/index.js";
import { recordOverride, type LearnedAction } from "../services/learned-rules.js";
import { createLogger } from "../lib/logger.js";
import { track } from "../lib/background-tasks.js";

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
  //
  // We register the promise with the background-tasks tracker so a SIGTERM
  // (or stdin-close from the host process) can drain in-flight Claude
  // calls before we exit. Without this, a user mass-archiving and quitting
  // within ~1 s loses every learned-rules observation. See P3 #18.
  void track(
    "recordOverride.emails",
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
    }),
  );
}

// Dispatch on the email id scheme — `imap:<accountId>:<folder>:<uid>` lands
// on imapflow flags/move; `gmail:<accountId>:<gmailId>` lands on the Gmail
// API messages.modify / messages.trash. Each provider produces ids in its
// own format at insert time so this dispatch stays simple.
async function dispatch(
  emailId: string,
  op: "archive" | "unarchive" | "trash" | "setRead" | "setStarred",
  flag?: boolean,
): Promise<void> {
  if (emailId.startsWith("imap:")) {
    if (op === "archive") return archiveMessage(emailId);
    if (op === "unarchive") return unarchiveMessage(emailId);
    if (op === "trash") return trashMessage(emailId);
    if (op === "setRead") return setReadFlag(emailId, !!flag);
    if (op === "setStarred") return setStarFlag(emailId, !!flag);
    return;
  }
  if (emailId.startsWith("gmail:")) {
    if (op === "archive") return archiveMessageGmail(emailId);
    if (op === "unarchive") return unarchiveMessageGmail(emailId);
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

  // Inverse of emails.archive — re-add INBOX to a previously-archived
  // message. Backs the smart-action key's late-undo path: when the user
  // hits Cmd+Z after the 5s optimistic window has already committed to
  // the server, the renderer calls this to bring the message back. The
  // optimistic in-window undo is handled entirely in the store and never
  // touches the sidecar.
  registerMethod("emails.unarchive", async (params) => {
    const { emailId, accountId } = (params as { emailId?: string; accountId?: string }) ?? {};
    if (!emailId) throw new Error("emails.unarchive: requires { emailId }");
    await dispatch(emailId, "unarchive");
    if (accountId) {
      // Renderer listens for this to re-thread the email if needed; mirrors
      // the sync:emails-removed event pattern from archive.
      emit("sync:emails-restored", { accountId, emailIds: [emailId] });
    }
    return { ok: true };
  });

  registerMethod("emails.batchArchive", async (params) => {
    const { emailIds, accountId } = (params as { emailIds?: string[]; accountId?: string }) ?? {};
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
    const { threadId, accountId } = (params as { threadId?: string; accountId?: string }) ?? {};
    if (!threadId || !accountId) {
      throw new Error("emails.archiveThread: requires { threadId, accountId }");
    }
    const rows = getDb()
      .prepare(
        "SELECT id, thread_id, account_id FROM emails WHERE thread_id = ? AND account_id = ?",
      )
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
    const { emailIds, accountId } = (params as { emailIds?: string[]; accountId?: string }) ?? {};
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
    const { threadId, accountId } = (params as { threadId?: string; accountId?: string }) ?? {};
    if (!threadId || !accountId) {
      throw new Error("emails.getThread: requires { threadId, accountId }");
    }
    // Joined shape matches getEmailsForAccount so the renderer's row
    // mapper sees the analysis + draft fields. Anything that walks a
    // thread (reply context, summary panel, etc.) gets full data.
    return getEmailsForThread(threadId, accountId);
  });

  // Server-side mailbox search for "search older mail" — the Cmd+F
  // case where the user wants to find a thread that's no longer in the
  // local 500-row window.
  //
  // Gmail accounts: hits users.messages.list with the user's `q:` query
  // (Gmail's full search syntax — `from:foo subject:bar after:2024/01`).
  // Returns Gmail's resultSizeEstimate as `totalEstimate`.
  //
  // IMAP accounts: issues a structured SEARCH for substring matches
  // across SUBJECT/FROM/BODY. Gmail-style operators don't translate, so
  // we just substring-match the entire query. Returns the SEARCH result
  // count as `totalEstimate`. See searchImapMessages for limitations.
  //
  // After fetching matching message IDs, we batch-fetch envelope
  // headers so the renderer gets full DashboardEmailRow objects ready
  // to render (subject, from, to, date, snippet, etc.) without an extra
  // round-trip per result. Bodies are NOT fetched — fetchBodyForEmail
  // pulls the body when the user opens a thread.
  registerMethod("emails.searchRemote", async (params) => {
    const { accountId, query, maxResults, pageToken } =
      (params as {
        accountId?: string;
        query?: string;
        maxResults?: number;
        pageToken?: string;
      }) ?? {};
    if (!accountId) throw new Error("emails.searchRemote: requires { accountId }");
    if (typeof query !== "string" || query.trim() === "") {
      throw new Error("emails.searchRemote: requires { query }");
    }

    const account = getAccountForSearch(accountId);
    if (!account) {
      throw new Error(`emails.searchRemote: account ${accountId} not found`);
    }

    if (account.provider === "gmail") {
      return searchGmailRemote(accountId, query, maxResults, pageToken);
    }
    if (account.provider === "imap") {
      return searchImapRemote(accountId, query, maxResults, pageToken);
    }
    throw new Error(
      `emails.searchRemote: unknown provider '${account.provider}' for account ${accountId}`,
    );
  });
}

interface AccountForSearchRow {
  id: string;
  provider: string;
}

function getAccountForSearch(accountId: string): AccountForSearchRow | null {
  return (
    (getDb()
      .prepare("SELECT id, COALESCE(provider, 'gmail') AS provider FROM accounts WHERE id = ?")
      .get(accountId) as AccountForSearchRow | undefined) ?? null
  );
}

async function searchGmailRemote(
  accountId: string,
  query: string,
  maxResults: number | undefined,
  pageToken: string | undefined,
): Promise<{
  messages: DashboardEmailRow[];
  nextPageToken?: string;
  totalEstimate?: number;
}> {
  const list = await searchGmailMessages(accountId, {
    query,
    maxResults: maxResults ?? 50,
    pageToken,
  });
  const ids = list.messageIds.map((m) => m.id);
  const headers = ids.length > 0 ? await getGmailHeaders(accountId, ids) : [];
  // Preserve Gmail's relevance/recency ordering — the API returns ids
  // newest-first by default; getGmailHeaders may settle out of order
  // because it batches in parallel. Resort to match the original list.
  const indexById = new Map(ids.map((id, i) => [id, i]));
  headers.sort((a, b) => (indexById.get(a.gmailId) ?? 0) - (indexById.get(b.gmailId) ?? 0));
  const messages = headers.map((h) => gmailHeaderToDashboardRow(accountId, h));
  const result: {
    messages: DashboardEmailRow[];
    nextPageToken?: string;
    totalEstimate?: number;
  } = { messages };
  if (list.nextPageToken) result.nextPageToken = list.nextPageToken;
  if (list.resultSizeEstimate > 0) result.totalEstimate = list.resultSizeEstimate;
  return result;
}

async function searchImapRemote(
  accountId: string,
  query: string,
  maxResults: number | undefined,
  pageToken: string | undefined,
): Promise<{
  messages: DashboardEmailRow[];
  nextPageToken?: string;
  totalEstimate?: number;
}> {
  // Cursor format: an integer offset encoded as a string. IMAP SEARCH
  // returns the entire UID set in one shot; we slice for pagination.
  const offset = pageToken ? parseInt(pageToken, 10) || 0 : 0;
  const limit = Math.min(Math.max(maxResults ?? 50, 1), 500);
  const result = await searchImapMessages(accountId, {
    query,
    limit,
    offset,
  });
  const messages = result.headers.map((h) => imapHeaderToDashboardRow(accountId, result.folder, h));
  const nextOffset = offset + result.headers.length;
  const out: {
    messages: DashboardEmailRow[];
    nextPageToken?: string;
    totalEstimate?: number;
  } = { messages, totalEstimate: result.total };
  if (nextOffset < result.total && result.headers.length > 0) {
    out.nextPageToken = String(nextOffset);
  }
  return out;
}

function gmailHeaderToDashboardRow(accountId: string, h: GmailMessageHeader): DashboardEmailRow {
  // labelIds is stored serialised in the DB; the renderer's mapper
  // expects the same string-or-null shape coming back. JSON.stringify
  // of an empty array yields "[]" which the renderer parses cleanly.
  const labelIds = JSON.stringify(h.labelIds ?? []);
  return {
    id: h.id,
    threadId: h.threadId,
    accountId,
    subject: h.subject,
    from: h.from,
    to: h.to,
    cc: h.cc,
    bcc: h.bcc,
    date: h.date,
    snippet: h.snippet || null,
    body: null,
    labelIds,
    isUnread: h.isUnread,
    messageId: h.messageId,
    inReplyTo: h.inReplyTo,
  };
}

function imapHeaderToDashboardRow(
  accountId: string,
  folder: string,
  h: ImapMessageHeader,
): DashboardEmailRow {
  // IMAP folder name takes the role of the labelIds — store it so the
  // renderer can scope by folder if it wants, mirroring what the IMAP
  // sync path puts in the DB.
  const labelIds = JSON.stringify([folder]);
  return {
    id: h.id,
    threadId: h.threadId,
    accountId,
    subject: h.subject,
    from: h.from,
    to: h.to,
    cc: h.cc,
    bcc: h.bcc,
    date: h.date,
    snippet: h.snippet || null,
    body: null,
    labelIds,
    isUnread: h.isUnread,
    messageId: h.messageId,
    inReplyTo: h.inReplyTo,
  };
}
