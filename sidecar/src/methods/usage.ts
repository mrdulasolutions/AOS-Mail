// `usage` IPC namespace — Claude API cost + call history visibility.
//
// Lifted from src/main/services/anthropic-service.ts (getUsageStats,
// getCallHistory) and the two settings.ipc.ts handlers that wrap them.
// Pure SELECT queries against llm_calls. No service / no events.
//
// The Electron version exposed these under the ipcMain channels
// "settings:get-usage-stats" and "settings:get-call-history" — bound to
// the renderer-side `window.api.usage.getStats / getCallHistory` namespace.
// We rebind them under cleaner names: `usage.getStats`, `usage.getHistory`.
// The renderer-side shim in installRealNamespaces preserves the legacy
// surface name (window.api.usage.*) while the wire calls go to the new
// names.
//
// We additionally surface "today" / "this month" aggregates and an enriched
// history endpoint that joins emails to expose subjects to the renderer.
// This powers the Agent Activity tray and the Agent Activity sub-tab in
// Settings → Agent Tools without making the renderer chatty about emails.

import { registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";

export interface UsageStats {
  today: { totalCostCents: number; totalCalls: number };
  thisWeek: { totalCostCents: number; totalCalls: number };
  thisMonth: { totalCostCents: number; totalCalls: number };
  byModel: Array<{ model: string; costCents: number; calls: number }>;
  byCaller: Array<{ caller: string; costCents: number; calls: number }>;
}

/** Aggregate stats for one rolling window (day or month). */
export interface UsageWindowStats {
  totalCostCents: number;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  topCaller: string | null;
  topCallerCalls: number;
}

export interface LlmCallRecord {
  id: string;
  created_at: string;
  model: string;
  caller: string;
  email_id: string | null;
  account_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cost_cents: number;
  duration_ms: number;
  success: number;
  error_message: string | null;
}

/** Same as LlmCallRecord plus the resolved email subject (when joinable). */
export interface LlmCallRecordWithSubject extends LlmCallRecord {
  email_subject: string | null;
}

function getStats(): UsageStats {
  const db = getDb();
  const single = (sql: string) => db.prepare(sql).get() as { cost: number; calls: number };
  // "Today" is the user's local calendar day, not the UTC day. SQLite's
  // `date('now')` returns UTC midnight; for a user in PST at 9 PM, that's
  // already past UTC midnight, so a 2 PM PST call would show in "today"
  // even though the user's "today" hasn't ended (or vice versa for early
  // morning). See post-mortem P3 #13. Use 'localtime' on both sides to
  // align created_at (UTC stored) with the local calendar boundary.
  const today = single(
    "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE date(created_at, 'localtime') = date('now', 'localtime')",
  );
  const thisWeek = single(
    "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-7 days')",
  );
  const thisMonth = single(
    "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days')",
  );
  const byModel = db
    .prepare(
      "SELECT model, COALESCE(SUM(cost_cents), 0) as costCents, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days') GROUP BY model ORDER BY costCents DESC",
    )
    .all() as Array<{ model: string; costCents: number; calls: number }>;
  const byCaller = db
    .prepare(
      "SELECT caller, COALESCE(SUM(cost_cents), 0) as costCents, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days') GROUP BY caller ORDER BY costCents DESC",
    )
    .all() as Array<{ caller: string; costCents: number; calls: number }>;
  return {
    today: { totalCostCents: today.cost, totalCalls: today.calls },
    thisWeek: { totalCostCents: thisWeek.cost, totalCalls: thisWeek.calls },
    thisMonth: { totalCostCents: thisMonth.cost, totalCalls: thisMonth.calls },
    byModel,
    byCaller,
  };
}

/**
 * Aggregate window stats with success/failure split + top caller. Used by
 * the Agent Activity tray (today badge) and the Settings stats card. We
 * keep the SQL narrow and do two queries — one aggregate, one top-caller —
 * because expressing "argmax over caller" inline gets ugly fast and the
 * row counts are tiny.
 */
function getWindowStats(whereClause: string): UsageWindowStats {
  const db = getDb();
  const agg = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_cents), 0) as cost,
         COUNT(*) as calls,
         SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCalls,
         SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failedCalls
       FROM llm_calls
       WHERE ${whereClause}`,
    )
    .get() as {
    cost: number;
    calls: number;
    successCalls: number | null;
    failedCalls: number | null;
  };
  const top = db
    .prepare(
      `SELECT caller, COUNT(*) as n
       FROM llm_calls
       WHERE ${whereClause}
       GROUP BY caller
       ORDER BY n DESC
       LIMIT 1`,
    )
    .get() as { caller: string; n: number } | undefined;
  return {
    totalCostCents: agg.cost,
    totalCalls: agg.calls,
    successCalls: agg.successCalls ?? 0,
    failedCalls: agg.failedCalls ?? 0,
    topCaller: top?.caller ?? null,
    topCallerCalls: top?.n ?? 0,
  };
}

function getStatsToday(): UsageWindowStats {
  // Local calendar day — see comment in getStats() above (P3 #13).
  return getWindowStats("date(created_at, 'localtime') = date('now', 'localtime')");
}

function getStatsThisMonth(): UsageWindowStats {
  return getWindowStats("created_at >= datetime('now', '-30 days')");
}

function getHistory(limit: number): LlmCallRecord[] {
  return getDb()
    .prepare("SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT ?")
    .all(limit) as LlmCallRecord[];
}

/**
 * History rows joined with the emails table on `email_id`. The join is a
 * LEFT JOIN so calls without a resolvable email (e.g. analysis batches,
 * thread summaries that key on thread_id, lookups for raw message ids the
 * client never persisted) still show up — `email_subject` is just null.
 *
 * We intentionally don't expose any other email fields. Subject is enough
 * context for the audit UI; everything else stays out of the renderer.
 */
function getHistoryWithSubjects(limit: number): LlmCallRecordWithSubject[] {
  return getDb()
    .prepare(
      `SELECT c.*, e.subject AS email_subject
       FROM llm_calls c
       LEFT JOIN emails e ON e.id = c.email_id
       ORDER BY c.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as LlmCallRecordWithSubject[];
}

export function registerUsageMethods(): void {
  registerMethod("usage.getStats", () => getStats());

  registerMethod("usage.getHistory", (params) => {
    const requested = (params as { limit?: number })?.limit ?? 50;
    const limit = Math.min(Math.max(requested, 1), 500);
    return getHistory(limit);
  });

  // Enriched history for the Agent Activity UI. We keep this server-side
  // even though filter-by-caller / filter-by-model / search-on-subject would
  // be trivial in JS — at typical workloads (a few hundred calls / day)
  // the full payload over the bridge is cheaper than re-fetching whenever
  // the user toggles a filter, and we get fewer round-trips on tray opens.
  // The renderer applies the filters client-side after one fetch.
  registerMethod("usage.getHistoryWithSubjects", (params) => {
    const requested = (params as { limit?: number })?.limit ?? 200;
    const limit = Math.min(Math.max(requested, 1), 1000);
    return getHistoryWithSubjects(limit);
  });

  registerMethod("usage.getStatsToday", () => getStatsToday());
  registerMethod("usage.getStatsThisMonth", () => getStatsThisMonth());
}
