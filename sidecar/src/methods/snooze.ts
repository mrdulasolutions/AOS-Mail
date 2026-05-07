// `snooze` IPC namespace — purely-local thread snoozing (hides threads
// in-app until the snoozeUntil timestamp passes).
//
// Lifted from src/main/services/snooze-service.ts and src/main/ipc/
// snooze.ipc.ts. The setInterval that auto-unsnoozes lives here (30s
// cadence) and emits notifications when snoozes expire — Tauri forwards
// those to the renderer as snooze:unsnoozed events.

import { randomUUID } from "node:crypto";
import { emit, registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";

export interface SnoozedEmail {
  id: string;
  emailId: string;
  threadId: string;
  accountId: string;
  snoozeUntil: number;
  snoozedAt: number;
}

const CHECK_INTERVAL_MS = 30_000;

// ── DB helpers (lifted from src/main/db/index.ts snooze section) ──

function dbSnoozeEmail(
  id: string,
  emailId: string,
  threadId: string,
  accountId: string,
  snoozeUntil: number,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO snoozed_emails (id, email_id, thread_id, account_id, snooze_until, snoozed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, emailId, threadId, accountId, snoozeUntil, Date.now());
}

function dbUnsnoozeEmail(id: string): void {
  getDb().prepare("DELETE FROM snoozed_emails WHERE id = ?").run(id);
}

function dbUnsnoozeByThread(threadId: string, accountId: string): void {
  getDb()
    .prepare("DELETE FROM snoozed_emails WHERE thread_id = ? AND account_id = ?")
    .run(threadId, accountId);
}

function dbGetSnoozedEmails(accountId: string): SnoozedEmail[] {
  return getDb()
    .prepare(
      `SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
              snooze_until as snoozeUntil, snoozed_at as snoozedAt
       FROM snoozed_emails WHERE account_id = ? ORDER BY snooze_until ASC`,
    )
    .all(accountId) as SnoozedEmail[];
}

function dbGetSnoozedByThread(threadId: string, accountId: string): SnoozedEmail | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
                snooze_until as snoozeUntil, snoozed_at as snoozedAt
         FROM snoozed_emails WHERE thread_id = ? AND account_id = ? LIMIT 1`,
      )
      .get(threadId, accountId) as SnoozedEmail) || null
  );
}

function dbGetDueSnoozedEmails(): SnoozedEmail[] {
  return getDb()
    .prepare(
      `SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
              snooze_until as snoozeUntil, snoozed_at as snoozedAt
       FROM snoozed_emails WHERE snooze_until <= ? ORDER BY snooze_until ASC`,
    )
    .all(Date.now()) as SnoozedEmail[];
}

// ── Auto-unsnooze timer ──

let timer: ReturnType<typeof setInterval> | null = null;

function checkDueAndEmit(): void {
  const due = dbGetDueSnoozedEmails();
  if (due.length === 0) return;
  for (const s of due) dbUnsnoozeEmail(s.id);
  emit("snooze:unsnoozed", { emails: due });
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(checkDueAndEmit, CHECK_INTERVAL_MS);
  // Don't keep the Node event loop alive purely on this timer.
  if (typeof timer.unref === "function") timer.unref();
}

// ── RPC registration ──

export function registerSnoozeMethods(): void {
  ensureTimer();

  registerMethod("snooze.snooze", (params) => {
    const { emailId, threadId, accountId, snoozeUntil } =
      (params as {
        emailId?: string;
        threadId?: string;
        accountId?: string;
        snoozeUntil?: number;
      }) ?? {};
    if (!emailId || !threadId || !accountId || typeof snoozeUntil !== "number") {
      throw new Error(
        "snooze.snooze: requires { emailId, threadId, accountId, snoozeUntil }",
      );
    }
    const id = randomUUID();
    dbUnsnoozeByThread(threadId, accountId);
    dbSnoozeEmail(id, emailId, threadId, accountId, snoozeUntil);
    const result: SnoozedEmail = {
      id,
      emailId,
      threadId,
      accountId,
      snoozeUntil,
      snoozedAt: Date.now(),
    };
    emit("snooze:snoozed", { snoozedEmail: result });
    return result;
  });

  registerMethod("snooze.unsnooze", (params) => {
    const { threadId, accountId } =
      (params as { threadId?: string; accountId?: string }) ?? {};
    if (!threadId || !accountId) {
      throw new Error("snooze.unsnooze: requires { threadId, accountId }");
    }
    const existing = dbGetSnoozedByThread(threadId, accountId);
    dbUnsnoozeByThread(threadId, accountId);
    emit("snooze:manually-unsnoozed", {
      threadId,
      accountId,
      snoozeUntil: existing?.snoozeUntil ?? Date.now(),
    });
    return { ok: true };
  });

  // Returns active snoozes + any that expired while the app was closed.
  // Mirrors the Electron handler: processes expired ones inline.
  registerMethod("snooze.list", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("snooze.list: requires { accountId }");
    const allDue = dbGetDueSnoozedEmails();
    const expired: SnoozedEmail[] = [];
    for (const s of allDue) {
      if (s.accountId === accountId) {
        dbUnsnoozeEmail(s.id);
        expired.push(s);
      }
    }
    return { data: dbGetSnoozedEmails(accountId), expired };
  });

  registerMethod("snooze.get", (params) => {
    const { threadId, accountId } =
      (params as { threadId?: string; accountId?: string }) ?? {};
    if (!threadId || !accountId) {
      throw new Error("snooze.get: requires { threadId, accountId }");
    }
    return dbGetSnoozedByThread(threadId, accountId);
  });
}
