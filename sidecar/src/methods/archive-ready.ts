// `archiveReady` IPC namespace — Claude-powered thread completion detector.
//
// V1 (mirrors the analysis namespace):
//   archiveReady.analyze(threadId, accountId)        — analyze one thread, persist
//                                                       to archive_ready, return result.
//   archiveReady.analyzeBatch(threadIds, accountId)  — same, in parallel (≤4);
//                                                       returns per-id results so the
//                                                       renderer can fan-out updates.
//   archiveReady.list(accountId, limit)              — read recent rows.
//   archiveReady.override(threadId, accountId, ...)  — manual override, persists.

import { registerMethod } from "../rpc.js";
import {
  analyzeThread,
  type ArchiveReadyResult,
  type ThreadEmailForAnalysis,
} from "../services/archive-ready-analyzer.js";
import { getDb } from "../db/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("archive-ready-methods");

interface ThreadEmailRow {
  id: string;
  from_address: string;
  to_address: string;
  subject: string;
  date: string;
  body: string;
  snippet: string | null;
  label_ids: string | null;
}

interface AccountRow {
  email: string;
}

function getThreadEmails(
  threadId: string,
  accountId: string,
): ThreadEmailForAnalysis[] {
  const rows = getDb()
    .prepare(
      `SELECT id, from_address, to_address, subject, date, body, snippet, label_ids
       FROM emails WHERE thread_id = ? AND account_id = ?`,
    )
    .all(threadId, accountId) as ThreadEmailRow[];
  return rows.map((r) => ({
    id: r.id,
    from: r.from_address,
    to: r.to_address,
    subject: r.subject,
    date: r.date,
    body: r.body,
    snippet: r.snippet,
    labelIds: r.label_ids ? (JSON.parse(r.label_ids) as string[]) : null,
  }));
}

function getAccountEmail(accountId: string): string | null {
  const row = getDb()
    .prepare("SELECT email FROM accounts WHERE id = ?")
    .get(accountId) as AccountRow | undefined;
  return row?.email ?? null;
}

function persistArchiveReady(
  threadId: string,
  accountId: string,
  result: ArchiveReadyResult,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO archive_ready
         (thread_id, account_id, is_ready, reason, analyzed_at, dismissed)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(
      threadId,
      accountId,
      result.isReady ? 1 : 0,
      result.reason,
      Date.now(),
    );
}

async function analyzeOne(
  threadId: string,
  accountId: string,
): Promise<ArchiveReadyResult> {
  const emails = getThreadEmails(threadId, accountId);
  if (emails.length === 0) {
    throw new Error(`thread ${threadId} not found for account ${accountId}`);
  }
  const result = await analyzeThread({
    threadId,
    accountId,
    userEmail: getAccountEmail(accountId) ?? undefined,
    emails,
  });
  persistArchiveReady(threadId, accountId, result);
  return result;
}

export function registerArchiveReadyMethods(): void {
  registerMethod("archiveReady.analyze", async (params) => {
    const { threadId, accountId } =
      (params as { threadId?: string; accountId?: string }) ?? {};
    if (!threadId || !accountId) {
      throw new Error(
        "archiveReady.analyze: requires { threadId, accountId }",
      );
    }
    return analyzeOne(threadId, accountId);
  });

  registerMethod("archiveReady.analyzeBatch", async (params) => {
    const { threadIds, accountId } =
      (params as { threadIds?: string[]; accountId?: string }) ?? {};
    if (!Array.isArray(threadIds)) {
      throw new Error(
        "archiveReady.analyzeBatch: requires { threadIds: string[], accountId }",
      );
    }
    if (!accountId) {
      throw new Error(
        "archiveReady.analyzeBatch: requires { threadIds, accountId }",
      );
    }
    const acct = accountId;
    const results: Array<{
      threadId: string;
      result?: ArchiveReadyResult;
      error?: string;
    }> = [];
    // Cap concurrency to 4 — same as analysis.analyzeBatch — to keep
    // Claude rate limits sane on large inboxes.
    const ids = threadIds;
    const limit = 4;
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const idx = cursor++;
        const id = ids[idx];
        if (!id) continue;
        try {
          const result = await analyzeOne(id, acct);
          results.push({ threadId: id, result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("analyze failed", { threadId: id, err: message });
          results.push({ threadId: id, error: message });
        }
      }
    }
    await Promise.all(Array.from({ length: limit }, () => worker()));
    return { results };
  });

  registerMethod("archiveReady.override", (params) => {
    const { threadId, accountId, isReady, reason } =
      (params as {
        threadId?: string;
        accountId?: string;
        isReady?: boolean;
        reason?: string;
      }) ?? {};
    if (!threadId || !accountId) {
      throw new Error(
        "archiveReady.override: requires { threadId, accountId, isReady }",
      );
    }
    persistArchiveReady(threadId, accountId, {
      isReady: !!isReady,
      reason: reason ?? "Manual override",
    });
    return { ok: true };
  });

  registerMethod("archiveReady.list", (params) => {
    const { accountId, limit } =
      (params as { accountId?: string; limit?: number }) ?? {};
    const cap = Math.min(Math.max(limit ?? 200, 1), 1000);
    const rows = accountId
      ? (getDb()
          .prepare(
            `SELECT thread_id, account_id, is_ready, reason, analyzed_at, dismissed
             FROM archive_ready
             WHERE account_id = ?
             ORDER BY analyzed_at DESC LIMIT ?`,
          )
          .all(accountId, cap) as Array<{
          thread_id: string;
          account_id: string;
          is_ready: number;
          reason: string;
          analyzed_at: number;
          dismissed: number;
        }>)
      : (getDb()
          .prepare(
            `SELECT thread_id, account_id, is_ready, reason, analyzed_at, dismissed
             FROM archive_ready
             ORDER BY analyzed_at DESC LIMIT ?`,
          )
          .all(cap) as Array<{
          thread_id: string;
          account_id: string;
          is_ready: number;
          reason: string;
          analyzed_at: number;
          dismissed: number;
        }>);
    return rows.map((r) => ({
      threadId: r.thread_id,
      accountId: r.account_id,
      isReady: r.is_ready === 1,
      reason: r.reason,
      analyzedAt: r.analyzed_at,
      dismissed: r.dismissed === 1,
    }));
  });
}
