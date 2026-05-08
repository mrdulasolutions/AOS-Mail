// `analysis` IPC namespace — Claude-powered triage.
//
// V1:
//   analysis.analyze(emailId)        — run triage on one email, persist
//                                       the result, return the result.
//   analysis.analyzeBatch(emailIds)  — same, in parallel; returns per-id
//                                       results so the renderer can
//                                       fan-out badge updates.
//   analysis.overridePriority(...)   — manual override, persists.
//   analysis.list(accountId, limit)  — read recent analyses.

import { registerMethod } from "../rpc.js";
import { analyzeEmail, type AnalysisResult } from "../services/email-analyzer.js";
import { recordOverride } from "../services/learned-rules.js";
import { getDb } from "../db/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("analysis-methods");

interface EmailRowForAnalysis {
  id: string;
  account_id: string;
  from_address: string;
  to_address: string;
  subject: string;
  date: string;
  body: string;
}

interface AccountRow {
  id: string;
  email: string;
}

interface PriorAnalysisRow {
  needs_reply: number;
  priority: string | null;
}

interface EmailAccountRow {
  account_id: string;
}

function getEmailRow(emailId: string): EmailRowForAnalysis | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, account_id, from_address, to_address, subject, date, body
         FROM emails WHERE id = ?`,
      )
      .get(emailId) as EmailRowForAnalysis | undefined) ?? null
  );
}

function getAccountEmail(accountId: string): string | null {
  const row = getDb().prepare("SELECT email FROM accounts WHERE id = ?").get(accountId) as
    | AccountRow
    | undefined;
  return row?.email ?? null;
}

function persistAnalysis(emailId: string, result: AnalysisResult): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO analyses
         (email_id, needs_reply, reason, priority, analyzed_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(emailId, result.needsReply ? 1 : 0, result.reason, result.priority ?? null, Date.now());
}

async function analyzeOne(emailId: string): Promise<AnalysisResult> {
  const row = getEmailRow(emailId);
  if (!row) throw new Error(`email ${emailId} not found`);
  // Body might be empty (header-only sync). Best-effort proceed; the
  // analyzer falls back to the subject.
  const result = await analyzeEmail({
    emailId,
    accountId: row.account_id,
    userEmail: getAccountEmail(row.account_id) ?? undefined,
    email: {
      id: row.id,
      from: row.from_address,
      to: row.to_address,
      subject: row.subject,
      date: row.date,
      body: row.body || row.subject,
    },
  });
  persistAnalysis(emailId, result);
  return result;
}

export function registerAnalysisMethods(): void {
  registerMethod("analysis.analyze", async (params) => {
    const { emailId } = (params as { emailId?: string }) ?? {};
    if (!emailId) throw new Error("analysis.analyze: requires { emailId }");
    return analyzeOne(emailId);
  });

  registerMethod("analysis.analyzeBatch", async (params) => {
    const { emailIds } = (params as { emailIds?: string[] }) ?? {};
    if (!Array.isArray(emailIds)) {
      throw new Error("analysis.analyzeBatch: requires { emailIds: string[] }");
    }
    const results: Array<{ emailId: string; result?: AnalysisResult; error?: string }> = [];
    // Cap concurrency to 4 — we don't want to blast Claude rate limits on
    // a 100-message batch.
    const ids = emailIds;
    const limit = 4;
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const idx = cursor++;
        const id = ids[idx];
        if (!id) continue;
        try {
          const result = await analyzeOne(id);
          results.push({ emailId: id, result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("analyze failed", { emailId: id, err: message });
          results.push({ emailId: id, error: message });
        }
      }
    }
    await Promise.all(Array.from({ length: limit }, () => worker()));
    return { results };
  });

  registerMethod("analysis.overridePriority", (params) => {
    const { emailId, newNeedsReply, newPriority, reason } =
      (params as {
        emailId?: string;
        newNeedsReply?: boolean;
        newPriority?: string | null;
        reason?: string;
      }) ?? {};
    if (!emailId) throw new Error("analysis.overridePriority: requires { emailId }");

    // Read what the analyzer previously said BEFORE we overwrite — if the
    // user is contradicting the analyzer (e.g. analyzer said
    // "needsReply=true, priority=medium" but the user says
    // "needsReply=false"), that's a learned-rules signal we need to
    // capture before persistAnalysis clobbers the original row.
    const prior = getDb()
      .prepare("SELECT needs_reply, priority FROM analyses WHERE email_id = ?")
      .get(emailId) as PriorAnalysisRow | undefined;

    persistAnalysis(emailId, {
      needsReply: !!newNeedsReply,
      reason: reason ?? "Manual override",
      priority: (newPriority ?? null) as AnalysisResult["priority"],
    });

    // Mirror maybeRecordOverride in emails.ts: if the analyzer thought
    // this email needed a reply and the user just said "no, it doesn't",
    // that's an archive-style override. Feed it to learned-rules so
    // future similar mail can be auto-handled. Fire-and-forget — the
    // learned-rules engine includes a Claude classify call that we don't
    // want to block the IPC verb on.
    if (prior && prior.needs_reply === 1 && newNeedsReply === false) {
      const emailRow = getDb()
        .prepare("SELECT account_id FROM emails WHERE id = ?")
        .get(emailId) as EmailAccountRow | undefined;
      if (emailRow?.account_id) {
        recordOverride({
          emailId,
          accountId: emailRow.account_id,
          override: {
            from: { needsReply: true, priority: prior.priority },
            to: { needsReply: false, priority: newPriority ?? null },
            action: "archived",
          },
        }).catch((err) => {
          log.warn("recordOverride failed for manual override", {
            emailId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    return { ok: true };
  });

  registerMethod("analysis.list", (params) => {
    const { accountId, limit } = (params as { accountId?: string; limit?: number }) ?? {};
    const cap = Math.min(Math.max(limit ?? 200, 1), 1000);
    const rows = accountId
      ? (getDb()
          .prepare(
            `SELECT a.email_id, a.needs_reply, a.reason, a.priority, a.analyzed_at
             FROM analyses a JOIN emails e ON e.id = a.email_id
             WHERE e.account_id = ?
             ORDER BY a.analyzed_at DESC LIMIT ?`,
          )
          .all(accountId, cap) as Array<{
          email_id: string;
          needs_reply: number;
          reason: string;
          priority: string | null;
          analyzed_at: number;
        }>)
      : (getDb()
          .prepare(
            `SELECT email_id, needs_reply, reason, priority, analyzed_at
             FROM analyses ORDER BY analyzed_at DESC LIMIT ?`,
          )
          .all(cap) as Array<{
          email_id: string;
          needs_reply: number;
          reason: string;
          priority: string | null;
          analyzed_at: number;
        }>);
    return rows.map((r) => ({
      emailId: r.email_id,
      needsReply: r.needs_reply === 1,
      reason: r.reason,
      priority: r.priority,
      analyzedAt: r.analyzed_at,
    }));
  });
}
