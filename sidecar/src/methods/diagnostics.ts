// Diagnostics methods.
//
// `diagnostics.reportError` — accept a renderer-side crash report (stack,
// componentStack, message) from React error boundaries, log it, and persist
// to the `error_log` table for later debugging. Errors are kept around in
// SQLite (capped at 200 rows by trimming on insert) so a packaged user can
// dump them without enabling PostHog.
//
// The table is created lazily here — same pattern as llm_calls in db/index.ts.
// We don't add it to schema.ts because it's purely diagnostic state, not part
// of the canonical email/account graph.

import { registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("diagnostics");

const MAX_ROWS = 200;
const MAX_STACK_LEN = 8000;
const MAX_MESSAGE_LEN = 1000;

let tableEnsured = false;

function ensureErrorLogTable(): void {
  if (tableEnsured) return;
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'renderer',
      message TEXT NOT NULL,
      stack TEXT,
      component_stack TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_error_log_created_at ON error_log(created_at);
  `);
  tableEnsured = true;
}

interface ReportErrorParams {
  message?: string;
  stack?: string;
  componentStack?: string;
  source?: string;
}

function clip(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  return input.length > max ? input.slice(0, max) : input;
}

export function registerDiagnosticsMethods(): void {
  registerMethod("diagnostics.reportError", (rawParams) => {
    ensureErrorLogTable();
    const params = (rawParams ?? {}) as ReportErrorParams;
    const message = clip(params.message ?? "Unknown renderer error", MAX_MESSAGE_LEN);
    const stack = clip(params.stack ?? "", MAX_STACK_LEN);
    const componentStack = clip(params.componentStack ?? "", MAX_STACK_LEN);
    const source = clip(params.source ?? "renderer", 64) || "renderer";

    log.error("renderer error reported", {
      source,
      message,
      // First line of stack only — full stacks live in the table.
      stack_head: stack.split("\n")[0] ?? "",
    });

    const d = getDb();
    d.prepare(
      `INSERT INTO error_log (source, message, stack, component_stack)
       VALUES (?, ?, ?, ?)`,
    ).run(source, message, stack || null, componentStack || null);

    // Trim oldest rows past the cap. Cheap maintenance — error_log is
    // diagnostic data, not user content.
    d.prepare(
      `DELETE FROM error_log
       WHERE id IN (
         SELECT id FROM error_log ORDER BY id DESC LIMIT -1 OFFSET ?
       )`,
    ).run(MAX_ROWS);

    return { ok: true as const };
  });

  // Read-back helper for diagnostics tooling. Useful when triaging a user's
  // crash report without firing up the DB shell.
  registerMethod("diagnostics.recentErrors", (rawParams) => {
    ensureErrorLogTable();
    const params = (rawParams ?? {}) as { limit?: number };
    const limit = Math.min(Math.max(params.limit ?? 50, 1), MAX_ROWS);
    const rows = getDb()
      .prepare(
        `SELECT id, created_at, source, message, stack, component_stack
         FROM error_log
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      created_at: string;
      source: string;
      message: string;
      stack: string | null;
      component_stack: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      source: r.source,
      message: r.message,
      stack: r.stack ?? "",
      componentStack: r.component_stack ?? "",
    }));
  });
}
