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

import { registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";

export interface UsageStats {
  today: { totalCostCents: number; totalCalls: number };
  thisWeek: { totalCostCents: number; totalCalls: number };
  thisMonth: { totalCostCents: number; totalCalls: number };
  byModel: Array<{ model: string; costCents: number; calls: number }>;
  byCaller: Array<{ caller: string; costCents: number; calls: number }>;
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

function getStats(): UsageStats {
  const db = getDb();
  const single = (sql: string) => db.prepare(sql).get() as { cost: number; calls: number };
  const today = single(
    "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE date(created_at) = date('now')",
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

function getHistory(limit: number): LlmCallRecord[] {
  return getDb()
    .prepare("SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT ?")
    .all(limit) as LlmCallRecord[];
}

export function registerUsageMethods(): void {
  registerMethod("usage.getStats", () => getStats());

  registerMethod("usage.getHistory", (params) => {
    const requested = (params as { limit?: number })?.limit ?? 50;
    const limit = Math.min(Math.max(requested, 1), 500);
    return getHistory(limit);
  });
}
