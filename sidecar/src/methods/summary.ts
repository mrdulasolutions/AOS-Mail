// Thread-summary RPC.
//
// `summary.thread(threadId, accountId)` returns the cached summary if
// one exists for the current latest-message-id, otherwise calls Claude
// via summarizeThread() and caches the result. The renderer's V1 agent
// panel calls this whenever it opens a multi-message thread.
//
// Cache key: (thread_id, account_id, latest_message_id). When a new
// message lands in the thread, the latest message id changes, the cache
// miss triggers a fresh Claude call, and the renderer paints the new
// summary on next open.

import { registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";
import { summarizeThread } from "../services/thread-summary.js";
import { getEmailsForThread } from "../services/sync.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("summary-method");

interface ThreadSummaryRow {
  thread_id: string;
  account_id: string;
  latest_message_id: string;
  summary_text: string;
  action_items: string;
  decisions: string;
  created_at: number;
}

function ensureSchema(): void {
  // Idempotent — every method call is a no-op once the table exists.
  // Keeping it inline rather than in db/index.ts means callers that
  // never request a summary don't pay any cost, and the migration is
  // colocated with the only consumer.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS thread_summaries (
      thread_id          TEXT NOT NULL,
      account_id         TEXT NOT NULL,
      latest_message_id  TEXT NOT NULL,
      summary_text       TEXT NOT NULL,
      action_items       TEXT NOT NULL DEFAULT '[]',
      decisions          TEXT NOT NULL DEFAULT '[]',
      created_at         INTEGER NOT NULL,
      PRIMARY KEY (thread_id, account_id)
    );
  `);
}

export function registerSummaryMethods(): void {
  ensureSchema();

  registerMethod("summary.thread", async (params) => {
    const { threadId, accountId, force } =
      (params as { threadId?: string; accountId?: string; force?: boolean }) ?? {};
    if (!threadId || !accountId) {
      throw new Error("summary.thread: requires { threadId, accountId }");
    }

    // Pull the thread from local storage. emails.getThread already does
    // the LEFT JOIN so we have analyses+drafts available too, but we
    // only need body/from/to/date/id here.
    const messages = getEmailsForThread(threadId, accountId);
    if (messages.length === 0) {
      return { summary: "", actionItems: [], decisions: [], cached: false };
    }
    // Skip Claude for single-message threads — the per-email analysis
    // already covers what a one-line summary would say. The renderer
    // hides the section when messages.length === 1 anyway.
    if (messages.length === 1) {
      return { summary: "", actionItems: [], decisions: [], cached: false };
    }

    const last = messages[messages.length - 1]!;
    const latestId = last.id;

    // Cache lookup
    if (!force) {
      const cached = getDb()
        .prepare(
          `SELECT thread_id, account_id, latest_message_id, summary_text,
                  action_items, decisions, created_at
           FROM thread_summaries
           WHERE thread_id = ? AND account_id = ?`,
        )
        .get(threadId, accountId) as ThreadSummaryRow | undefined;

      if (cached && cached.latest_message_id === latestId) {
        return {
          summary: cached.summary_text,
          actionItems: safeParseArray(cached.action_items),
          decisions: safeParseArray(cached.decisions),
          cached: true,
          createdAt: cached.created_at,
        };
      }
    }

    // Fresh Claude call
    let summary;
    try {
      summary = await summarizeThread({
        threadId,
        accountId,
        messages: messages.map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          date: m.date,
          body: m.body ?? "",
          bodyText: null,
        })),
      });
    } catch (err) {
      log.warn("summary.thread: summarize failed", {
        threadId,
        accountId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // Persist
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO thread_summaries
           (thread_id, account_id, latest_message_id, summary_text,
            action_items, decisions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, account_id) DO UPDATE SET
           latest_message_id = excluded.latest_message_id,
           summary_text      = excluded.summary_text,
           action_items      = excluded.action_items,
           decisions         = excluded.decisions,
           created_at        = excluded.created_at`,
      )
      .run(
        threadId,
        accountId,
        latestId,
        summary.summary,
        JSON.stringify(summary.actionItems),
        JSON.stringify(summary.decisions),
        now,
      );

    return {
      summary: summary.summary,
      actionItems: summary.actionItems,
      decisions: summary.decisions,
      cached: false,
      createdAt: now,
    };
  });
}

function safeParseArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? (parsed.filter((x) => typeof x === "string") as string[])
      : [];
  } catch {
    return [];
  }
}
