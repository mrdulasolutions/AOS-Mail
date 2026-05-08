// `permissions` IPC namespace — Agent activity awaiting approval.
//
// Surface for the renderer's PermissionsTray (top-right titlebar dropdown).
// One verb today: `permissions.list` aggregates two streams the agent
// can't auto-execute without user sign-off:
//
//   1. Pending drafts (drafts where status='pending') — the agent
//      generated a reply but didn't send it. The tray lets the user
//      Approve (sends via compose.send) or Skip (just dismisses).
//   2. Archive-ready threads (archive_ready where is_ready=1 AND
//      dismissed=0) — the agent thinks the thread is finished and
//      can be archived. Approve archives via emails.archiveThread;
//      Skip dismisses via archiveReady.dismiss.
//
// We deliberately *don't* implement Approve/Skip here — those calls
// already live in the existing namespaces (compose.send, drafts.save,
// emails.archiveThread, archiveReady.dismiss). The tray just lists what's
// pending and lets the renderer dispatch the existing verbs. That keeps
// the permission tray narrow and reusable.

import { registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";

export type PermissionItemKind = "draft" | "archive";

export interface PermissionItem {
  kind: PermissionItemKind;
  /** Stable id for the renderer's React key. */
  id: string;
  accountId: string;
  /** Sort key — newest first. */
  createdAt: number;
  // ── shared display fields ──
  subject: string;
  /** Short plain-text preview of the proposed action. */
  preview: string;
  // ── kind-specific identifiers (the renderer dispatches these to the
  //    existing verbs to actually approve / skip). ──
  /** For kind='draft': the email the draft replies to. */
  emailId?: string;
  /** For kind='archive': the thread to archive. */
  threadId?: string;
  /** Reason from the agent — surfaced in the tray as a tooltip. */
  reason?: string;
}

interface PendingDraftRow {
  email_id: string;
  account_id: string;
  draft_body: string;
  status: string;
  created_at: number;
  subject: string;
  from_address: string;
  thread_id: string;
}

interface ArchiveReadyRow {
  thread_id: string;
  account_id: string;
  reason: string;
  analyzed_at: number;
  subject: string;
  from_address: string;
}

function listPendingDrafts(accountId: string | null): PendingDraftRow[] {
  const sql = `SELECT d.email_id, e.account_id, d.draft_body, d.status,
                      d.created_at, e.subject, e.from_address, e.thread_id
               FROM drafts d
               INNER JOIN emails e ON e.id = d.email_id
               WHERE d.status = 'pending'
                 ${accountId ? "AND e.account_id = ?" : ""}
               ORDER BY d.created_at DESC
               LIMIT 50`;
  const stmt = getDb().prepare(sql);
  return (accountId ? stmt.all(accountId) : stmt.all()) as PendingDraftRow[];
}

function listArchiveReady(accountId: string | null): ArchiveReadyRow[] {
  // Pick the latest email per thread for a representative subject/sender.
  // We use an INNER JOIN against the most-recent email in the thread.
  // For thread_id values without any email rows (shouldn't happen but
  // defensive), the row is dropped — no blank entries in the tray.
  const sql = `SELECT ar.thread_id, ar.account_id, ar.reason, ar.analyzed_at,
                      e.subject, e.from_address
               FROM archive_ready ar
               INNER JOIN emails e
                 ON e.thread_id = ar.thread_id
                 AND e.account_id = ar.account_id
                 AND e.date = (
                   SELECT MAX(date) FROM emails
                   WHERE thread_id = ar.thread_id
                     AND account_id = ar.account_id
                 )
               WHERE ar.is_ready = 1
                 AND ar.dismissed = 0
                 ${accountId ? "AND ar.account_id = ?" : ""}
               ORDER BY ar.analyzed_at DESC
               LIMIT 50`;
  const stmt = getDb().prepare(sql);
  return (accountId ? stmt.all(accountId) : stmt.all()) as ArchiveReadyRow[];
}

function trimPreview(text: string, max = 120): string {
  // Drafts come in as HTML or plain text; strip tags for a 1-line preview.
  // We don't render HTML in the tray — just a sanity-check glance.
  const stripped = text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= max) return stripped;
  return stripped.slice(0, max - 1).trimEnd() + "…";
}

function shortFrom(raw: string): string {
  // "Name <email>" → Name; otherwise just the address.
  const m = raw.match(/^([^<]+)</);
  if (m && m[1]) return m[1].trim().replace(/^"|"$/g, "");
  return raw;
}

export function registerPermissionsMethods(): void {
  // List the items currently awaiting the user's approval. Combines
  // pending drafts + archive-ready threads, sorted newest-first.
  registerMethod("permissions.list", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    const acct = accountId ?? null;

    const drafts = listPendingDrafts(acct).map<PermissionItem>((r) => ({
      kind: "draft",
      id: `draft:${r.email_id}`,
      accountId: r.account_id,
      createdAt: r.created_at,
      subject: r.subject,
      preview: `Reply ready: ${trimPreview(r.draft_body, 100)}`,
      emailId: r.email_id,
      threadId: r.thread_id,
      reason: `Drafted reply to ${shortFrom(r.from_address)}`,
    }));

    const archives = listArchiveReady(acct).map<PermissionItem>((r) => ({
      kind: "archive",
      id: `archive:${r.thread_id}:${r.account_id}`,
      accountId: r.account_id,
      createdAt: r.analyzed_at,
      subject: r.subject,
      preview: `Archive thread: ${trimPreview(r.reason, 100)}`,
      threadId: r.thread_id,
      reason: r.reason,
    }));

    const all = [...drafts, ...archives].sort((a, b) => b.createdAt - a.createdAt);
    return {
      items: all,
      counts: {
        drafts: drafts.length,
        archives: archives.length,
        total: all.length,
      },
    };
  });
}
