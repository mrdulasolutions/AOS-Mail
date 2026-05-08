// Minimal mail sync orchestrator. V1 supports IMAP only — Gmail sync via
// the History API is the next step (email-sync.ts in the Electron path
// is the reference implementation).
//
// The orchestrator's only job for V1 is to pull recent INBOX messages
// and upsert their envelopes into the emails table so the existing
// renderer UI can render them. Bodies are fetched on demand when the
// user opens a thread (sync.fetchBody).

import { getDb } from "../db/index.js";
import {
  getImapMessageFull,
  listImapMessageHeaders,
  listImapSentHeaders,
  type ImapMessageHeader,
} from "./providers/imap-fetch.js";
import {
  getGmailHeaders,
  getGmailHistoryChanges,
  getGmailMessageFull,
  listGmailMessages,
  parseGmailEmailId,
  type GmailMessageHeader,
} from "./providers/gmail-fetch.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("sync");

export interface SyncResult {
  accountId: string;
  fetched: number;
  newRows: number;
  newEmails: DashboardEmailRow[];
  errors: string[];
}

interface AccountRow {
  id: string;
  email: string;
  provider: string;
}

function getAccountRow(accountId: string): AccountRow | null {
  const row = getDb()
    .prepare("SELECT id, email, COALESCE(provider, 'gmail') as provider FROM accounts WHERE id = ?")
    .get(accountId) as AccountRow | undefined;
  return row ?? null;
}

interface UpsertEmail {
  id: string;
  account_id: string;
  thread_id: string;
  subject: string;
  from_address: string;
  to_address: string;
  cc_address: string | null;
  bcc_address: string | null;
  body: string;
  body_text: string | null;
  snippet: string;
  date: string;
  fetched_at: number;
  label_ids: string | null;
  attachments: string | null;
  message_id: string | null;
  in_reply_to: string | null;
}

function upsertEmail(row: UpsertEmail): boolean {
  const db = getDb();
  // Returns true if inserted (new), false if updated (existing).
  const existing = db
    .prepare("SELECT id FROM emails WHERE id = ?")
    .get(row.id) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE emails SET
         account_id = ?, thread_id = ?, subject = ?,
         from_address = ?, to_address = ?, cc_address = ?, bcc_address = ?,
         body = ?, body_text = ?, snippet = ?,
         date = ?, fetched_at = ?, label_ids = ?, attachments = ?,
         message_id = ?, in_reply_to = ?
       WHERE id = ?`,
    ).run(
      row.account_id,
      row.thread_id,
      row.subject,
      row.from_address,
      row.to_address,
      row.cc_address,
      row.bcc_address,
      row.body,
      row.body_text,
      row.snippet,
      row.date,
      row.fetched_at,
      row.label_ids,
      row.attachments,
      row.message_id,
      row.in_reply_to,
      row.id,
    );
    return false;
  }
  db.prepare(
    `INSERT INTO emails (
        id, account_id, thread_id, subject,
        from_address, to_address, cc_address, bcc_address,
        body, body_text, snippet,
        date, fetched_at, label_ids, attachments,
        message_id, in_reply_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.account_id,
    row.thread_id,
    row.subject,
    row.from_address,
    row.to_address,
    row.cc_address,
    row.bcc_address,
    row.body,
    row.body_text,
    row.snippet,
    row.date,
    row.fetched_at,
    row.label_ids,
    row.attachments,
    row.message_id,
    row.in_reply_to,
  );
  return true;
}

/**
 * Resolve the thread_id for an IMAP SENT message.
 *
 * IMAP doesn't have Gmail's server-side thread concept — every message
 * just stands on its own with a Message-ID and an optional In-Reply-To
 * header. The sync layer's job is to make sent replies share a thread_id
 * with the original inbox message they reply to so the conversation
 * view can render them inline.
 *
 * Order of preference:
 *   1. Look up the inbox row whose message_id matches our In-Reply-To.
 *      That's the message we're replying to; reuse its thread_id (which
 *      may itself derive from the X-GM-THRID-style server thread header,
 *      a longer reply chain, or the original message's own id).
 *   2. Fall back to the In-Reply-To value itself. If the inbox message
 *      hasn't been synced yet we still want sent replies to a future
 *      inbox sync to merge — and the inbox row's threadId is set to
 *      `env.inReplyTo ?? env.messageId` (see imap-fetch.ts), so a sent
 *      reply with the same in-reply-to value already lines up.
 *   3. Fall back to our own message_id. A standalone sent message
 *      starts its own thread.
 *   4. Last resort: the message's own id. Matches the inbox-side
 *      convention in listImapMessageHeaders so single-message sent
 *      threads still get a stable id.
 */
function resolveImapThreadId(sentMessage: ImapMessageHeader): string {
  if (sentMessage.inReplyTo) {
    const row = getDb()
      .prepare("SELECT thread_id FROM emails WHERE message_id = ? LIMIT 1")
      .get(sentMessage.inReplyTo) as { thread_id: string } | undefined;
    if (row?.thread_id) return row.thread_id;
    return sentMessage.inReplyTo;
  }
  if (sentMessage.messageId) return sentMessage.messageId;
  return sentMessage.id;
}

/**
 * Convert an IMAP message header into the row we INSERT into the emails
 * table. The threadId override lets the SENT path swap in the resolved
 * thread_id (see resolveImapThreadId) instead of the message's own
 * messageId/uid; INBOX rows pass `header.threadId` unchanged.
 */
function imapHeaderToUpsert(
  accountId: string,
  h: ImapMessageHeader,
  labels: string[],
  threadIdOverride?: string,
): UpsertEmail {
  return {
    id: h.id,
    account_id: accountId,
    thread_id: threadIdOverride ?? h.threadId,
    subject: h.subject,
    from_address: h.from,
    to_address: h.to,
    cc_address: h.cc,
    bcc_address: h.bcc,
    body: "", // body fetched on demand
    body_text: null,
    snippet: h.snippet,
    date: h.date,
    fetched_at: Date.now(),
    label_ids: JSON.stringify(labels),
    attachments: null,
    message_id: h.messageId,
    in_reply_to: h.inReplyTo,
  };
}

export async function syncAccountNow(accountId: string): Promise<SyncResult> {
  const row = getAccountRow(accountId);
  if (!row) {
    return {
      accountId,
      fetched: 0,
      newRows: 0,
      newEmails: [],
      errors: ["account not found"],
    };
  }
  if (row.provider === "gmail") {
    return syncGmailAccountNow(accountId);
  }
  if (row.provider !== "imap") {
    return {
      accountId,
      fetched: 0,
      newRows: 0,
      newEmails: [],
      errors: [`unknown provider: ${row.provider}`],
    };
  }

  let fetched = 0;
  let newRows = 0;
  const newEmails: DashboardEmailRow[] = [];
  const errors: string[] = [];

  // Pull INBOX and SENT in parallel. Without SENT, the user's own replies
  // never show up in the thread view because they live exclusively in the
  // server's sent folder — and emails.getThread joins by thread_id against
  // the local emails table, so the sent rows have to land here too.
  let inboxHeaders: ImapMessageHeader[] = [];
  let sentHeaders: ImapMessageHeader[] = [];
  try {
    const [inboxRes, sentRes] = await Promise.all([
      listImapMessageHeaders(accountId, "INBOX", { limit: 100 }),
      listImapSentHeaders(accountId, { limit: 100 }),
    ]);
    inboxHeaders = inboxRes.headers;
    sentHeaders = sentRes.headers;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  // INBOX upserts. Inbox rows get the standard label set the renderer's
  // useThreadedEmails relies on for "is this the inbox view?".
  for (const h of inboxHeaders) {
    try {
      const labels = ["INBOX"];
      if (!h.isUnread) labels.push("READ");
      if (h.isStarred) labels.push("STARRED");
      const upsertRow = imapHeaderToUpsert(accountId, h, labels);
      const inserted = upsertEmail(upsertRow);
      fetched++;
      if (inserted) {
        newRows++;
        newEmails.push(
          rowToDashboard({
            id: upsertRow.id,
            thread_id: upsertRow.thread_id,
            account_id: upsertRow.account_id,
            subject: upsertRow.subject,
            from_address: upsertRow.from_address,
            to_address: upsertRow.to_address,
            cc_address: upsertRow.cc_address,
            bcc_address: upsertRow.bcc_address,
            date: upsertRow.date,
            snippet: upsertRow.snippet,
            body: upsertRow.body,
            label_ids: upsertRow.label_ids,
            message_id: upsertRow.message_id,
            in_reply_to: upsertRow.in_reply_to,
          }),
        );
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // SENT upserts. Sent rows are always treated as already-read (otherwise
  // every send would bump the inbox unread count) and labeled SENT so the
  // renderer's threading logic (useThreadedEmails) can include them in
  // conversation views without surfacing them as standalone inbox rows.
  // Resolve thread_id AFTER inbox upsert so a sent reply to a just-synced
  // inbox row picks up the right thread.
  for (const h of sentHeaders) {
    try {
      const threadId = resolveImapThreadId(h);
      const labels = ["SENT", "READ"];
      if (h.isStarred) labels.push("STARRED");
      const upsertRow = imapHeaderToUpsert(accountId, h, labels, threadId);
      const inserted = upsertEmail(upsertRow);
      fetched++;
      if (inserted) {
        newRows++;
        newEmails.push(
          rowToDashboard({
            id: upsertRow.id,
            thread_id: upsertRow.thread_id,
            account_id: upsertRow.account_id,
            subject: upsertRow.subject,
            from_address: upsertRow.from_address,
            to_address: upsertRow.to_address,
            cc_address: upsertRow.cc_address,
            bcc_address: upsertRow.bcc_address,
            date: upsertRow.date,
            snippet: upsertRow.snippet,
            body: upsertRow.body,
            label_ids: upsertRow.label_ids,
            message_id: upsertRow.message_id,
            in_reply_to: upsertRow.in_reply_to,
          }),
        );
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { accountId, fetched, newRows, newEmails, errors };
}

// ── Gmail provider sync ─────────────────────────────────────────────────

interface SyncStateRow {
  account_id: string;
  history_id: string;
  last_sync_at: number;
}

function getGmailSyncState(accountId: string): SyncStateRow | null {
  return (
    (getDb()
      .prepare("SELECT account_id, history_id, last_sync_at FROM sync_state WHERE account_id = ?")
      .get(accountId) as SyncStateRow | undefined) ?? null
  );
}

function setGmailSyncState(accountId: string, historyId: string): void {
  getDb()
    .prepare(
      `INSERT INTO sync_state (account_id, history_id, last_sync_at)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         history_id = excluded.history_id,
         last_sync_at = excluded.last_sync_at`,
    )
    .run(accountId, historyId, Date.now());
}

function gmailHeaderToUpsert(
  accountId: string,
  h: GmailMessageHeader,
): UpsertEmail {
  return {
    id: h.id,
    account_id: accountId,
    thread_id: h.threadId,
    subject: h.subject,
    from_address: h.from,
    to_address: h.to,
    cc_address: h.cc,
    bcc_address: h.bcc,
    body: "", // bodies fetched on demand by fetchBodyForEmail
    body_text: null,
    snippet: h.snippet,
    date: h.date,
    fetched_at: Date.now(),
    label_ids: JSON.stringify(h.labelIds),
    attachments: null,
    message_id: h.messageId,
    in_reply_to: h.inReplyTo,
  };
}

/**
 * Sync a single Gmail account.
 *
 * Two paths:
 *   - First sync (no stored historyId): list the latest 50 inbox messages,
 *     batch-fetch their headers, upsert, then persist Gmail's profile
 *     historyId so the next call goes incremental.
 *   - Incremental: ask Gmail's history.list for changes since the stored
 *     historyId. Fetch headers for newly-added messages, upsert. For
 *     archived/deleted messages, drop INBOX from their label_ids (they
 *     stay in the DB so search/sent views still see them, but they no
 *     longer show up in the inbox query). For read/unread changes, flip
 *     the corresponding label.
 *
 * On HISTORY_EXPIRED (Gmail purges history records ~7d after creation),
 * fall back to the first-sync path and overwrite the stored historyId.
 */
async function syncGmailAccountNow(accountId: string): Promise<SyncResult> {
  const errors: string[] = [];
  const newEmails: DashboardEmailRow[] = [];
  let fetched = 0;
  let newRows = 0;

  const stored = getGmailSyncState(accountId);
  let useFullSync = !stored;

  if (stored) {
    try {
      const changes = await getGmailHistoryChanges(accountId, stored.history_id);
      if (changes.newIds.length > 0) {
        const headers = await getGmailHeaders(accountId, changes.newIds);
        for (const h of headers) {
          try {
            const upsertRow = gmailHeaderToUpsert(accountId, h);
            const inserted = upsertEmail(upsertRow);
            fetched++;
            if (inserted) {
              newRows++;
              newEmails.push(
                rowToDashboard({
                  id: upsertRow.id,
                  thread_id: upsertRow.thread_id,
                  account_id: upsertRow.account_id,
                  subject: upsertRow.subject,
                  from_address: upsertRow.from_address,
                  to_address: upsertRow.to_address,
                  cc_address: upsertRow.cc_address,
                  bcc_address: upsertRow.bcc_address,
                  date: upsertRow.date,
                  snippet: upsertRow.snippet,
                  body: upsertRow.body,
                  label_ids: upsertRow.label_ids,
                  message_id: upsertRow.message_id,
                  in_reply_to: upsertRow.in_reply_to,
                }),
              );
            }
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
          }
        }
      }
      if (changes.removedIds.length > 0) {
        // Remove INBOX from label_ids so the row stops showing up in the
        // inbox query. We don't DELETE; the row may still be needed for
        // thread context or search.
        const stmt = getDb().prepare(
          "UPDATE emails SET label_ids = ? WHERE id = ?",
        );
        for (const gid of changes.removedIds) {
          const id = `gmail:${accountId}:${gid}`;
          const row = getDb()
            .prepare("SELECT label_ids FROM emails WHERE id = ?")
            .get(id) as { label_ids: string | null } | undefined;
          if (!row) continue;
          let labels: string[] = [];
          try {
            labels = row.label_ids ? (JSON.parse(row.label_ids) as string[]) : [];
          } catch {
            labels = [];
          }
          stmt.run(JSON.stringify(labels.filter((l) => l !== "INBOX")), id);
        }
      }
      // Read/unread flips — toggle the UNREAD label in the stored JSON.
      const flipUnread = (gids: string[], unread: boolean): void => {
        const stmt = getDb().prepare(
          "UPDATE emails SET label_ids = ? WHERE id = ?",
        );
        for (const gid of gids) {
          const id = `gmail:${accountId}:${gid}`;
          const row = getDb()
            .prepare("SELECT label_ids FROM emails WHERE id = ?")
            .get(id) as { label_ids: string | null } | undefined;
          if (!row) continue;
          let labels: string[] = [];
          try {
            labels = row.label_ids ? (JSON.parse(row.label_ids) as string[]) : [];
          } catch {
            labels = [];
          }
          const next = unread
            ? [...new Set([...labels, "UNREAD"])]
            : labels.filter((l) => l !== "UNREAD");
          stmt.run(JSON.stringify(next), id);
        }
      };
      flipUnread(changes.readIds, false);
      flipUnread(changes.unreadIds, true);

      setGmailSyncState(accountId, changes.historyId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "HISTORY_EXPIRED") {
        log.info("gmail history expired, falling back to full sync", {
          accountId,
        });
        useFullSync = true;
      } else {
        errors.push(msg);
      }
    }
  }

  if (useFullSync) {
    // Pull headers from a Gmail label and upsert. Returns the historyId
    // associated with the listing so the caller can persist sync state.
    // Errors per-message are captured in the outer `errors` array.
    const upsertGmailLabel = async (labelId: string): Promise<string | null> => {
      const { messageIds, historyId } = await listGmailMessages(accountId, {
        maxResults: 100,
        labelIds: [labelId],
      });
      if (messageIds.length === 0) return historyId;
      const headers = await getGmailHeaders(
        accountId,
        messageIds.map((m) => m.id),
      );
      for (const h of headers) {
        try {
          const upsertRow = gmailHeaderToUpsert(accountId, h);
          const inserted = upsertEmail(upsertRow);
          fetched++;
          if (inserted) {
            newRows++;
            newEmails.push(
              rowToDashboard({
                id: upsertRow.id,
                thread_id: upsertRow.thread_id,
                account_id: upsertRow.account_id,
                subject: upsertRow.subject,
                from_address: upsertRow.from_address,
                to_address: upsertRow.to_address,
                cc_address: upsertRow.cc_address,
                bcc_address: upsertRow.bcc_address,
                date: upsertRow.date,
                snippet: upsertRow.snippet,
                body: upsertRow.body,
                label_ids: upsertRow.label_ids,
                message_id: upsertRow.message_id,
                in_reply_to: upsertRow.in_reply_to,
              }),
            );
          }
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      return historyId;
    };

    try {
      // Pull INBOX first; sent rows later get the right thread_id
      // automatically because Gmail's threadId is server-assigned and
      // shared across all messages in the conversation. We persist the
      // historyId returned with the INBOX listing so incremental sync
      // can start from there. The SENT listing returns the same profile
      // historyId, so either is fine to persist.
      const inboxHistoryId = await upsertGmailLabel("INBOX");
      // Then SENT — without this, the user's own replies stay invisible
      // on first sync because the History API only kicks in after a
      // historyId is stored. (Subsequent incremental syncs already track
      // SENT via getGmailHistoryChanges' fetchLabel("SENT") call.)
      await upsertGmailLabel("SENT");
      if (inboxHistoryId) setGmailSyncState(accountId, inboxHistoryId);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { accountId, fetched, newRows, newEmails, errors };
}

export interface DashboardEmailRow {
  id: string;
  threadId: string;
  accountId: string;
  subject: string;
  from: string;
  to: string;
  cc: string | null;
  bcc: string | null;
  date: string;
  snippet: string | null;
  body: string | null;
  labelIds: string | null;
  isUnread: boolean;
  messageId: string | null;
  inReplyTo: string | null;
  /**
   * Joined from `analyses` table when present. The renderer's EmailRow
   * uses this to render priority badges; without it the emails sit on
   * the inbox with no triage labels even after analysis.analyzeBatch
   * has finished writing rows.
   */
  analysis?: {
    needsReply: boolean;
    reason: string;
    priority?: "high" | "medium" | "low" | "skip";
    analyzedAt: number;
  };
  /**
   * Joined from `drafts` table when present. The renderer uses this to
   * render the "draft ready" pill on the row + the prefilled body in
   * the composer when the user opens the thread.
   */
  draft?: {
    body: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    gmailDraftId?: string;
    status: "pending" | "created" | "edited";
    createdAt: number;
    composeMode?: "reply" | "reply-all" | "forward";
    agentTaskId?: string;
  };
}

interface RawEmailRow {
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
  // Joined columns — present when the SELECT in getEmailsForAccount LEFT
  // JOINs analyses + drafts. fetchBodyForEmail's narrower SELECT omits
  // these and the row mapper safely treats them as missing.
  a_needs_reply?: number | null;
  a_reason?: string | null;
  a_priority?: string | null;
  a_analyzed_at?: number | null;
  d_draft_body?: string | null;
  d_gmail_draft_id?: string | null;
  d_status?: string | null;
  d_created_at?: number | null;
  d_agent_task_id?: string | null;
  d_cc?: string | null;
  d_bcc?: string | null;
  d_compose_mode?: string | null;
  d_to_recipients?: string | null;
}

function parseStringArrayOrNull(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : undefined;
  } catch {
    // Plain comma-separated fallback — older drafts table writes used
    // this format before the JSON convention landed.
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

function rowToDashboard(r: RawEmailRow): DashboardEmailRow {
  let labels: string[] = [];
  try {
    labels = r.label_ids ? (JSON.parse(r.label_ids) as string[]) : [];
  } catch {
    labels = [];
  }

  const out: DashboardEmailRow = {
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
    // UNREAD source-of-truth for Gmail-style label sets, falling back to
    // the IMAP-era "READ-when-present" convention. Both providers populate
    // label_ids; UNREAD is what Gmail's modify API toggles, READ is what
    // the IMAP path inserts when \Seen is set on the server.
    isUnread: labels.includes("UNREAD") || (!labels.includes("READ") && !labels.includes("UNREAD")),
    messageId: r.message_id,
    inReplyTo: r.in_reply_to,
  };

  // The IMAP path's "READ" label is stored in label_ids; if neither READ
  // nor UNREAD is present we fall back to "unread = true" so first-fetch
  // rows (no flag info yet) show as bold in the inbox. This matches what
  // listImapMessageHeaders sets via flags?.has("\\Seen").
  if (labels.includes("READ")) out.isUnread = false;
  if (labels.includes("UNREAD")) out.isUnread = true;

  // Joined analysis row.
  if (
    r.a_needs_reply !== undefined &&
    r.a_needs_reply !== null &&
    r.a_analyzed_at !== undefined &&
    r.a_analyzed_at !== null
  ) {
    const priority = r.a_priority ?? undefined;
    out.analysis = {
      needsReply: r.a_needs_reply === 1,
      reason: r.a_reason ?? "",
      priority:
        priority === "high" || priority === "medium" || priority === "low" || priority === "skip"
          ? priority
          : undefined,
      analyzedAt: r.a_analyzed_at,
    };
  }

  // Joined draft row.
  if (r.d_draft_body !== undefined && r.d_draft_body !== null) {
    const status =
      r.d_status === "created" || r.d_status === "edited" ? r.d_status : "pending";
    const composeMode =
      r.d_compose_mode === "reply" ||
      r.d_compose_mode === "reply-all" ||
      r.d_compose_mode === "forward"
        ? r.d_compose_mode
        : undefined;
    out.draft = {
      body: r.d_draft_body,
      to: parseStringArrayOrNull(r.d_to_recipients),
      cc: parseStringArrayOrNull(r.d_cc),
      bcc: parseStringArrayOrNull(r.d_bcc),
      gmailDraftId: r.d_gmail_draft_id ?? undefined,
      status,
      createdAt: r.d_created_at ?? Date.now(),
      composeMode,
      agentTaskId: r.d_agent_task_id ?? undefined,
    };
  }

  return out;
}

/**
 * Fetch the full body for one email on demand (called when the user opens
 * a thread). For IMAP this goes back to the server, parses the RFC 822
 * source, updates the body field in the emails table, and returns the
 * fresh DashboardEmailRow shape. For Gmail (when its provider lifts) the
 * same dispatch lives here.
 */
export async function fetchBodyForEmail(emailId: string): Promise<DashboardEmailRow | null> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, account_id, thread_id, subject,
              from_address, to_address, cc_address, bcc_address,
              date, snippet, body, label_ids,
              message_id, in_reply_to
       FROM emails WHERE id = ?`,
    )
    .get(emailId) as RawEmailRow | undefined;
  if (!row) return null;

  // If we already have a non-empty body, just return what's stored.
  if (row.body && row.body.length > 0) {
    return rowToDashboard(row);
  }

  // Dispatch on the id scheme: imap:<accountId>:<folder>:<uid>
  // or gmail:<accountId>:<gmailId>.
  if (emailId.startsWith("gmail:")) {
    const parsed = parseGmailEmailId(emailId);
    if (!parsed) return rowToDashboard(row);
    try {
      const full = await getGmailMessageFull(parsed.accountId, parsed.gmailId);
      if (!full) return rowToDashboard(row);
      db.prepare(
        "UPDATE emails SET body = ?, body_text = ?, fetched_at = ? WHERE id = ?",
      ).run(full.body, full.bodyText, Date.now(), emailId);
      return rowToDashboard({ ...row, body: full.body });
    } catch (err) {
      log.warn("fetchBodyForEmail (gmail) failed", {
        emailId,
        err: err instanceof Error ? err.message : String(err),
      });
      return rowToDashboard(row);
    }
  }

  const m = /^imap:([^:]+):([^:]+):(\d+)$/.exec(emailId);
  if (!m) {
    // Unknown id scheme — return what we have rather than throwing; old
    // 'sent:<uuid>' rows from compose.send land here.
    return rowToDashboard(row);
  }
  const [, , folder, uidStr] = m;
  if (!folder || !uidStr) return rowToDashboard(row);
  try {
    const full = await getImapMessageFull(row.account_id, folder, Number(uidStr));
    if (!full) return rowToDashboard(row);
    db.prepare(
      "UPDATE emails SET body = ?, body_text = ?, fetched_at = ? WHERE id = ?",
    ).run(full.body, full.bodyText, Date.now(), emailId);
    return rowToDashboard({ ...row, body: full.body });
  } catch (err) {
    log.warn("fetchBodyForEmail failed", {
      emailId,
      err: err instanceof Error ? err.message : String(err),
    });
    return rowToDashboard(row);
  }
}

/**
 * Same SELECT shape as getEmailsForAccount — analysis + draft joined —
 * but for a single thread. Used by emails.getThread when the renderer
 * opens a conversation. Sorted oldest-first to match the conversation
 * UI's render order.
 */
export function getEmailsForThread(
  threadId: string,
  accountId: string,
): DashboardEmailRow[] {
  const rows = getDb()
    .prepare(
      `SELECT e.id, e.thread_id, e.account_id, e.subject,
              e.from_address, e.to_address, e.cc_address, e.bcc_address,
              e.date, e.snippet, e.body, e.label_ids,
              e.message_id, e.in_reply_to,
              a.needs_reply  AS a_needs_reply,
              a.reason       AS a_reason,
              a.priority     AS a_priority,
              a.analyzed_at  AS a_analyzed_at,
              d.draft_body     AS d_draft_body,
              d.gmail_draft_id AS d_gmail_draft_id,
              d.status         AS d_status,
              d.created_at     AS d_created_at,
              d.agent_task_id  AS d_agent_task_id,
              d.cc             AS d_cc,
              d.bcc            AS d_bcc,
              d.compose_mode   AS d_compose_mode,
              d.to_recipients  AS d_to_recipients
       FROM emails e
       LEFT JOIN analyses a ON a.email_id = e.id
       LEFT JOIN drafts   d ON d.email_id = e.id
       WHERE e.thread_id = ? AND e.account_id = ?
       ORDER BY e.date ASC`,
    )
    .all(threadId, accountId) as RawEmailRow[];
  return rows.map(rowToDashboard);
}

export function getEmailsForAccount(
  accountId: string,
  opts: { sent?: boolean } = {},
): DashboardEmailRow[] {
  // V1 doesn't track sent vs inbox separately — IMAP path stores INBOX
  // only. When the user actually sends, we'll insert with a SENT label.
  const where = opts.sent
    ? "e.account_id = ? AND e.label_ids LIKE '%SENT%'"
    : "e.account_id = ? AND (e.label_ids LIKE '%INBOX%' OR e.label_ids IS NULL)";
  // LEFT JOIN analyses + drafts so the renderer's EmailRow can render the
  // priority badge + draft pill on the first paint. Without this join the
  // renderer paints empty rows even when the DB has analyses, because no
  // separate analysis.list call ever fires at boot.
  const rows = getDb()
    .prepare(
      `SELECT e.id, e.thread_id, e.account_id, e.subject,
              e.from_address, e.to_address, e.cc_address, e.bcc_address,
              e.date, e.snippet, e.body, e.label_ids,
              e.message_id, e.in_reply_to,
              a.needs_reply  AS a_needs_reply,
              a.reason       AS a_reason,
              a.priority     AS a_priority,
              a.analyzed_at  AS a_analyzed_at,
              d.draft_body     AS d_draft_body,
              d.gmail_draft_id AS d_gmail_draft_id,
              d.status         AS d_status,
              d.created_at     AS d_created_at,
              d.agent_task_id  AS d_agent_task_id,
              d.cc             AS d_cc,
              d.bcc            AS d_bcc,
              d.compose_mode   AS d_compose_mode,
              d.to_recipients  AS d_to_recipients
       FROM emails e
       LEFT JOIN analyses a ON a.email_id = e.id
       LEFT JOIN drafts   d ON d.email_id = e.id
       WHERE ${where}
       ORDER BY e.date DESC
       LIMIT 500`,
    )
    .all(accountId) as RawEmailRow[];
  return rows.map(rowToDashboard);
}
