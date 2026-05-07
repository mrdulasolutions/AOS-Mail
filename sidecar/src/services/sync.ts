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

  try {
    const { headers } = await listImapMessageHeaders(accountId, "INBOX", { limit: 50 });
    const now = Date.now();
    for (const h of headers) {
      try {
        const labels = ["INBOX"];
        if (!h.isUnread) labels.push("READ");
        if (h.isStarred) labels.push("STARRED");
        const upsertRow: UpsertEmail = {
          id: h.id,
          account_id: accountId,
          thread_id: h.threadId,
          subject: h.subject,
          from_address: h.from,
          to_address: h.to,
          cc_address: h.cc,
          bcc_address: h.bcc,
          body: "", // body fetched on demand
          body_text: null,
          snippet: h.snippet,
          date: h.date,
          fetched_at: now,
          label_ids: JSON.stringify(labels),
          attachments: null,
          message_id: h.messageId,
          in_reply_to: h.inReplyTo,
        };
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
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
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
    try {
      const { messageIds, historyId } = await listGmailMessages(accountId, {
        maxResults: 50,
      });
      if (messageIds.length > 0) {
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
      }
      if (historyId) setGmailSyncState(accountId, historyId);
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
}

function rowToDashboard(r: RawEmailRow): DashboardEmailRow {
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

export function getEmailsForAccount(accountId: string, opts: { sent?: boolean } = {}): DashboardEmailRow[] {
  // V1 doesn't track sent vs inbox separately — IMAP path stores INBOX
  // only. When the user actually sends, we'll insert with a SENT label.
  const where = opts.sent
    ? "account_id = ? AND label_ids LIKE '%SENT%'"
    : "account_id = ? AND (label_ids LIKE '%INBOX%' OR label_ids IS NULL)";
  const rows = getDb()
    .prepare(
      `SELECT id, thread_id, account_id, subject,
              from_address, to_address, cc_address, bcc_address,
              date, snippet, body, label_ids,
              message_id, in_reply_to
       FROM emails
       WHERE ${where}
       ORDER BY date DESC
       LIMIT 500`,
    )
    .all(accountId) as RawEmailRow[];
  return rows.map(rowToDashboard);
}
