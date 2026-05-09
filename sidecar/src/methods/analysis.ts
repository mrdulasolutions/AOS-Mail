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
import { track } from "../lib/background-tasks.js";

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

interface ExistingAnalysisRow {
  needs_reply: number;
  reason: string;
  priority: string | null;
  analyzed_at: number;
}

// Short-circuit window for analysis dedupe (P3 #16). On boot we have two
// triage paths fan-out the same email ids — the onNewEmails listener AND
// the cached-emails React-Query effect. Without dedupe we'd run 2x Claude
// calls per email on first launch. 6 hours is conservative: if a user
// manually re-triages (clears + re-adds an account), the override path
// goes through analysis.overridePriority, not analyze, so this freshness
// gate doesn't lock them out.
const ANALYSIS_FRESHNESS_MS = 6 * 60 * 60 * 1000;

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

function getExistingFreshAnalysis(emailId: string): AnalysisResult | null {
  const row = getDb()
    .prepare(
      `SELECT needs_reply, reason, priority, analyzed_at
       FROM analyses WHERE email_id = ?`,
    )
    .get(emailId) as ExistingAnalysisRow | undefined;
  if (!row) return null;
  if (Date.now() - row.analyzed_at > ANALYSIS_FRESHNESS_MS) return null;
  const priority = row.priority;
  return {
    needsReply: row.needs_reply === 1,
    reason: row.reason,
    priority: priority === "high" || priority === "medium" || priority === "low" ? priority : null,
  };
}

// Process-local cooldown for emails whose analysis JUST failed (rate-limit
// exhausted, network error, etc.). Without this, every boot/refresh
// re-tries the same 50 failed emails, which (a) burns more rate-limit
// budget and (b) keeps the user waiting on "Triaging…" for the same set
// of emails forever. We back off ~30 minutes; after that, a real boot or
// the manual "Catch up" button can retry.
//
// In-memory only: a sidecar restart wipes it, which is the right
// behavior — rate-limit pressure is short-lived and the user re-trying
// after a restart is signal that they want to try again.
const FAILURE_COOLDOWN_MS = 30 * 60 * 1000;
const recentFailures = new Map<string, number>();

function isInFailureCooldown(emailId: string): boolean {
  const ts = recentFailures.get(emailId);
  if (!ts) return false;
  if (Date.now() - ts > FAILURE_COOLDOWN_MS) {
    recentFailures.delete(emailId);
    return false;
  }
  return true;
}

function markFailure(emailId: string): void {
  recentFailures.set(emailId, Date.now());
}

async function analyzeOne(emailId: string): Promise<AnalysisResult> {
  // Dedupe boot fan-out. If a fresh analysis already exists, hand it back
  // instead of burning another LLM call. Freshness window is generous
  // (6 hours) so the same boot's two triage paths don't both analyze,
  // but a user re-launching the app the next morning still gets
  // re-analysis if for some reason they want it.
  const existing = getExistingFreshAnalysis(emailId);
  if (existing) {
    return existing;
  }
  // Failure cooldown: skip emails that just failed analysis so we don't
  // hammer the LLM provider after a rate-limit storm. We synthesize a
  // safe, non-persistent placeholder so callers don't spin in a loop —
  // it's NOT written to the analyses table, so the next legitimate
  // refresh after the cooldown will re-try cleanly.
  if (isInFailureCooldown(emailId)) {
    return {
      needsReply: false,
      reason: "(triage queued — provider rate-limited, will retry)",
      priority: null,
    };
  }
  const row = getEmailRow(emailId);
  if (!row) throw new Error(`email ${emailId} not found`);
  // Body might be empty (header-only sync). Best-effort proceed; the
  // analyzer falls back to the subject.
  try {
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
  } catch (err) {
    markFailure(emailId);
    throw err;
  }
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
    // Cap concurrency to 2 — combined with the per-call rateLimit() in
    // services/email-analyzer.ts (30 req/min global), this keeps us
    // comfortably under Anthropic's 50 RPM org cap even when the
    // renderer fan-outs a fresh 100-email triage batch. Prior value of 4
    // raced ahead of the rate limiter and wasted budget on internal
    // back-pressure waits.
    const ids = emailIds;
    const limit = 2;
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
        // Tracked for graceful shutdown — see lib/background-tasks.ts (P3 #18).
        void track(
          "recordOverride.analysis",
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
          }),
        );
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
