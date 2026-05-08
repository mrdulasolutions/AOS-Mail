// Morning Briefing — generates a daily 3-paragraph executive briefing of
// what happened in the inbox yesterday and what's pending today.
//
// Why this exists:
//   AOS Mail's V1 agent already triages, archives via learned rules, drafts
//   replies, and looks up senders in the background. The user wakes up to
//   a half-handled inbox but no narrative. The briefing closes that loop —
//   "open the app and see, in plain English, what got handled and what
//   needs you" is the wow moment of a Tier-1 roadmap feature.
//
// Generation strategy:
//   1. Pull yesterday's inbox stats from SQLite (no LLM):
//      - newEmails:        count of emails with date >= yesterday-start
//      - needsReplyCount:  emails with analyses.priority='high' and no
//                          draft sent or sent reply
//      - autoHandledCount: emails archived via learned-rules (proxy via
//                          archive_ready.is_ready=1 + dismissed)
//      - draftsReady:      drafts.status='pending' for yesterday's emails
//      - snoozedCount:     snoozed_emails.snoozed_at >= yesterday-start
//   2. Pull high-priority unreplied threads (subject + sender + reason).
//   3. Pull calendar events for today (if any rows exist for the account).
//   4. Pull extracted action items from thread_summaries (if present).
//   5. Hand the structured summary to Claude (Sonnet) with a prompt that
//      asks for exactly 3 paragraphs (waiting / handled / today). Parse
//      the response into { paragraph1, paragraph2, paragraph3 }.
//
// Cache key: (accountId, isoDate). Idempotent — generating again on the
// same day returns the cached row instead of burning another Claude call.
//
// Date: we use the user's local calendar date (YYYY-MM-DD) at generation
// time. "Yesterday" is one day prior to that.

import { createMessage } from "./anthropic.js";
import { stripJsonFences } from "../lib/prompts/strip-json-fences.js";
import { getDb } from "../db/index.js";
import { createLogger } from "../lib/logger.js";
import { getPreferences } from "../lib/preferences.js";

const log = createLogger("morning-briefing");

// Default to Sonnet — briefings are user-facing prose where Haiku
// noticeably degrades narrative quality, but they're a once-a-day call
// per account so the cost is rounding-error.
const DEFAULT_BRIEFING_MODEL = "claude-sonnet-4-5-20250929";

function resolveBriefingModel(): string {
  const prefs = getPreferences() as { modelConfig?: { briefing?: unknown } };
  const raw = prefs.modelConfig?.briefing;
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_BRIEFING_MODEL;
  const trimmed = raw.trim();
  if (trimmed === "haiku") return "claude-haiku-4-5-20251001";
  if (trimmed === "sonnet") return "claude-sonnet-4-5-20250929";
  if (trimmed === "opus") return "claude-opus-4-20250514";
  return trimmed;
}

export interface BriefingStats {
  newEmails: number;
  needsReplyCount: number;
  autoHandledCount: number;
  draftsReadyCount: number;
  snoozedCount: number;
  upcomingEventsCount: number;
}

export interface BriefingActionItem {
  threadId: string;
  emailId: string;
  subject: string;
  fromEmail: string;
  fromName: string | null;
  reason: string;
  priority: "high" | "medium" | "low";
}

export interface DailyBriefing {
  accountId: string;
  /** ISO calendar date in the user's local time, e.g. "2026-05-08". */
  date: string;
  briefingText: string;
  actionItems: BriefingActionItem[];
  stats: BriefingStats;
  generatedAt: number;
  /** ms-epoch when user clicked "Got it"; null/undefined = still active. */
  dismissedAt: number | null;
}

interface UpcomingEvent {
  summary: string;
  start: string;
  isAllDay: boolean;
}

interface BriefingContext {
  accountEmail: string | null;
  yesterday: { newEmails: number; autoHandledCount: number; snoozedCount: number };
  needsReply: BriefingActionItem[];
  draftsReadyCount: number;
  upcomingEvents: UpcomingEvent[];
  /** Action items extracted from thread_summaries for unreplied threads. */
  extractedActionItems: string[];
}

// ─── ISO date helpers ───────────────────────────────────────────────────

/** Format `Date` as "YYYY-MM-DD" in the local timezone. */
export function isoLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today's local calendar date as YYYY-MM-DD. */
export function todayIsoDate(): string {
  return isoLocalDate(new Date());
}

/** Returns yesterday's start ms-epoch + today's start ms-epoch in local tz. */
function dayWindow(forIsoDate: string): { yesterdayStart: number; todayStart: number } {
  // Build a Date for the start of `forIsoDate`. SQLite's date column is an
  // ISO string, but our window comparisons use the email row's `date` field
  // (also ISO) so we can lexicographically compare.
  const [y, m, d] = forIsoDate.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`invalid iso date: ${forIsoDate}`);
  const todayStart = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  return { yesterdayStart, todayStart };
}

// ─── Context gathering (pure SQL, no LLM) ───────────────────────────────

interface AccountRow {
  email: string;
}

interface NeedsReplyRow {
  email_id: string;
  thread_id: string;
  subject: string;
  from_address: string;
  reason: string;
  priority: "high" | "medium" | "low" | null;
}

function gatherContext(accountId: string, forIsoDate: string): BriefingContext {
  const db = getDb();
  const { yesterdayStart, todayStart } = dayWindow(forIsoDate);
  const yesterdayStartIso = new Date(yesterdayStart).toISOString();
  const todayStartIso = new Date(todayStart).toISOString();

  const accountRow = db.prepare("SELECT email FROM accounts WHERE id = ?").get(accountId) as
    | AccountRow
    | undefined;

  // newEmails: emails received yesterday in this account's inbox.
  const newEmailsRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM emails
       WHERE account_id = ?
         AND date >= ?
         AND date < ?`,
    )
    .get(accountId, yesterdayStartIso, todayStartIso) as { n: number };

  // autoHandledCount: archive_ready entries marked is_ready=1 dismissed
  // yesterday — proxy for "agent decided this thread is done."
  const autoHandledRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM archive_ready
       WHERE account_id = ?
         AND is_ready = 1
         AND analyzed_at >= ?
         AND analyzed_at < ?`,
    )
    .get(accountId, yesterdayStart, todayStart) as { n: number };

  // snoozedCount: threads the user (or agent) snoozed yesterday.
  const snoozedRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM snoozed_emails
       WHERE account_id = ?
         AND snoozed_at >= ?
         AND snoozed_at < ?`,
    )
    .get(accountId, yesterdayStart, todayStart) as { n: number };

  // needsReply: top high/medium-priority emails from yesterday or earlier
  // that still don't have a sent draft. Limit 10 — anything beyond that
  // gets summarized as "+ N more" in the prompt to keep it short.
  // We only consider emails where the user is actually a recipient (not
  // CC'd or bulk lists) by checking analyses.needs_reply = 1.
  const needsReplyRows = db
    .prepare(
      `SELECT e.id AS email_id, e.thread_id, e.subject, e.from_address,
              a.reason, a.priority
       FROM emails e
       INNER JOIN analyses a ON a.email_id = e.id
       LEFT JOIN drafts d ON d.email_id = e.id AND d.status = 'created'
       WHERE e.account_id = ?
         AND a.needs_reply = 1
         AND a.priority IN ('high', 'medium')
         AND d.email_id IS NULL
         AND e.date < ?
       ORDER BY
         CASE a.priority
           WHEN 'high' THEN 0
           WHEN 'medium' THEN 1
           ELSE 2
         END,
         e.date DESC
       LIMIT 10`,
    )
    .all(accountId, todayStartIso) as NeedsReplyRow[];

  const needsReply: BriefingActionItem[] = needsReplyRows.map((r) => ({
    threadId: r.thread_id,
    emailId: r.email_id,
    subject: r.subject,
    fromEmail: extractEmailAddress(r.from_address),
    fromName: extractDisplayName(r.from_address),
    reason: r.reason,
    priority: (r.priority ?? "medium") as "high" | "medium" | "low",
  }));

  // draftsReady: pending agent-generated drafts the user can review +
  // send. Just status='pending' on drafts whose email is in this account.
  const draftsReadyRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM drafts d
       INNER JOIN emails e ON e.id = d.email_id
       WHERE e.account_id = ?
         AND d.status = 'pending'`,
    )
    .get(accountId) as { n: number };

  // Upcoming events: today's calendar events. Stored locally if calendar
  // sync has run; if not, we just skip (graceful empty state).
  const upcomingEvents = (() => {
    try {
      const tomorrowStart = new Date(todayStart + 24 * 60 * 60 * 1000).toISOString();
      const rows = db
        .prepare(
          `SELECT summary, start_time AS start, is_all_day AS isAllDay
           FROM calendar_events
           WHERE account_id = ?
             AND start_time >= ?
             AND start_time < ?
           ORDER BY start_time ASC
           LIMIT 8`,
        )
        .all(accountId, todayStartIso, tomorrowStart) as Array<{
        summary: string;
        start: string;
        isAllDay: number;
      }>;
      return rows.map((r) => ({
        summary: r.summary,
        start: r.start,
        isAllDay: r.isAllDay === 1,
      }));
    } catch {
      // calendar_events may not exist if sync never ran. Treat as empty.
      return [];
    }
  })();

  // Action items extracted from thread summaries for needs-reply threads.
  // thread_summaries.action_items is a JSON array of strings.
  const extractedActionItems: string[] = (() => {
    if (needsReply.length === 0) return [];
    try {
      const placeholders = needsReply.map(() => "?").join(",");
      const rows = getDb()
        .prepare(
          `SELECT action_items FROM thread_summaries
           WHERE account_id = ?
             AND thread_id IN (${placeholders})`,
        )
        .all(accountId, ...needsReply.map((n) => n.threadId)) as Array<{
        action_items: string;
      }>;
      const items: string[] = [];
      for (const r of rows) {
        try {
          const parsed = JSON.parse(r.action_items) as unknown;
          if (Array.isArray(parsed)) {
            for (const it of parsed) {
              if (typeof it === "string" && it.trim()) items.push(it.trim());
            }
          }
        } catch {
          // skip malformed JSON
        }
      }
      // Cap at 8 — beyond that the LLM gets noisy.
      return items.slice(0, 8);
    } catch {
      // thread_summaries doesn't exist yet → no extracted items.
      return [];
    }
  })();

  return {
    accountEmail: accountRow?.email ?? null,
    yesterday: {
      newEmails: newEmailsRow.n,
      autoHandledCount: autoHandledRow.n,
      snoozedCount: snoozedRow.n,
    },
    needsReply,
    draftsReadyCount: draftsReadyRow.n,
    upcomingEvents,
    extractedActionItems,
  };
}

// ─── Email-address parsing ──────────────────────────────────────────────

function extractEmailAddress(raw: string): string {
  // RFC 5322 "Name <email@host>" → email@host. Falls back to the raw
  // string if no angle brackets are present.
  const m = raw.match(/<([^>]+)>/);
  return (m?.[1] ?? raw).trim();
}

function extractDisplayName(raw: string): string | null {
  const m = raw.match(/^([^<]+)</);
  if (!m || !m[1]) return null;
  return m[1].trim().replace(/^"|"$/g, "") || null;
}

// ─── Prompt + LLM call ──────────────────────────────────────────────────

const BRIEFING_SYSTEM_PROMPT = `You are an executive assistant briefing your principal first thing in the morning.

Given a structured summary of yesterday's inbox activity and today's calendar, you produce a JSON object with exactly this shape:

  {
    "briefing_text": "<paragraph 1>\\n\\n<paragraph 2>\\n\\n<paragraph 3>",
    "action_items": ["<top item 1>", "<top item 2>", ...]
  }

Rules:
- briefing_text MUST be EXACTLY three paragraphs separated by a blank line.
- Paragraph 1 — what's waiting on the user. Concrete: who, what, by-when. Use names ("Tom needs a yes/no on the Q3 plan"). If nothing pressing, say "Inbox is clear — nothing demands a response today."
- Paragraph 2 — what got handled. Quantify: "12 newsletters auto-archived, 3 drafts ready for review, 2 threads snoozed for next week." If nothing was handled, say so plainly.
- Paragraph 3 — what's coming up today. Lead with calendar, then deadlines mentioned in unreplied emails. If neither, say "Calendar is open today — good time to focus on the asks above."
- Plain English. Conversational, second-person ("you", "your"). No headers, no lists, no markdown.
- Each paragraph 1–4 sentences. Keep the whole thing under 200 words.
- action_items: 1–5 short imperative phrases ("Reply to Tom on Q3", "Decide on Acme renewal by Wednesday"). Empty array OK if nothing pending.
- Respond ONLY with valid JSON. No markdown fences, no commentary.`;

function formatContextForPrompt(ctx: BriefingContext, forIsoDate: string): string {
  const lines: string[] = [];
  lines.push(`Account: ${ctx.accountEmail ?? "(unknown)"}`);
  lines.push(`Date being briefed (today): ${forIsoDate}`);
  lines.push("");
  lines.push(`Yesterday's stats:`);
  lines.push(`  - New emails received: ${ctx.yesterday.newEmails}`);
  lines.push(`  - Auto-handled (archived by agent): ${ctx.yesterday.autoHandledCount}`);
  lines.push(`  - Snoozed: ${ctx.yesterday.snoozedCount}`);
  lines.push(`  - Drafts the agent prepared (awaiting your review): ${ctx.draftsReadyCount}`);
  lines.push("");
  lines.push(`Top items needing your reply (${ctx.needsReply.length}):`);
  if (ctx.needsReply.length === 0) {
    lines.push("  (none — inbox is clear)");
  } else {
    for (const item of ctx.needsReply) {
      const who = item.fromName ? `${item.fromName} <${item.fromEmail}>` : item.fromEmail;
      lines.push(`  - [${item.priority}] ${who}: "${item.subject}" — ${item.reason}`);
    }
  }
  if (ctx.extractedActionItems.length > 0) {
    lines.push("");
    lines.push("Action items extracted from those threads:");
    for (const it of ctx.extractedActionItems) {
      lines.push(`  - ${it}`);
    }
  }
  lines.push("");
  lines.push(`Today's calendar (${ctx.upcomingEvents.length} events):`);
  if (ctx.upcomingEvents.length === 0) {
    lines.push("  (no events synced)");
  } else {
    for (const ev of ctx.upcomingEvents) {
      const when = ev.isAllDay
        ? `all day`
        : new Date(ev.start).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          });
      lines.push(`  - ${when}: ${ev.summary}`);
    }
  }
  return lines.join("\n");
}

interface LlmBriefingResponse {
  briefingText: string;
  actionItems: string[];
}

async function generateBriefingText(
  ctx: BriefingContext,
  forIsoDate: string,
  accountId: string,
): Promise<LlmBriefingResponse> {
  const userPrompt = formatContextForPrompt(ctx, forIsoDate);
  const response = await createMessage(
    {
      model: resolveBriefingModel(),
      max_tokens: 800,
      system: [
        {
          type: "text",
          text: BRIEFING_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userPrompt }],
    },
    {
      caller: "morning-briefing",
      accountId,
    },
  );

  const block = response.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  const cleaned = stripJsonFences(raw);

  try {
    const parsed = JSON.parse(cleaned) as {
      briefing_text?: unknown;
      action_items?: unknown;
    };
    const text = typeof parsed.briefing_text === "string" ? parsed.briefing_text.trim() : "";
    const items = Array.isArray(parsed.action_items)
      ? parsed.action_items.filter((x): x is string => typeof x === "string")
      : [];
    if (!text) {
      throw new Error("empty briefing_text from LLM");
    }
    return { briefingText: text, actionItems: items };
  } catch (err) {
    log.warn("briefing JSON parse failed", {
      err: err instanceof Error ? err.message : String(err),
      raw: raw.slice(0, 200),
    });
    // Fallback to a deterministic briefing built from the structured
    // context so the user still sees something useful when the LLM call
    // misbehaves.
    return {
      briefingText: buildFallbackBriefing(ctx),
      actionItems: ctx.needsReply.slice(0, 5).map((n) => {
        const who = n.fromName ?? n.fromEmail;
        return `Reply to ${who} on "${n.subject}"`;
      }),
    };
  }
}

function buildFallbackBriefing(ctx: BriefingContext): string {
  // Deterministic 3-paragraph fallback so the panel never renders empty
  // when the LLM is unavailable or returns malformed JSON.
  const para1 =
    ctx.needsReply.length === 0
      ? "Inbox is clear — nothing demands a response today."
      : `${ctx.needsReply.length} ${ctx.needsReply.length === 1 ? "thread is" : "threads are"} waiting on you. Top of the list: ${ctx.needsReply
          .slice(0, 3)
          .map((n) => `${n.fromName ?? n.fromEmail} on "${n.subject}"`)
          .join("; ")}.`;
  const para2 =
    ctx.yesterday.autoHandledCount + ctx.draftsReadyCount + ctx.yesterday.snoozedCount === 0
      ? "Nothing got auto-handled overnight — the agent only acts when it's confident."
      : `The agent ${ctx.yesterday.autoHandledCount > 0 ? `auto-handled ${ctx.yesterday.autoHandledCount} ${ctx.yesterday.autoHandledCount === 1 ? "thread" : "threads"}` : ""}${ctx.yesterday.autoHandledCount > 0 && (ctx.draftsReadyCount > 0 || ctx.yesterday.snoozedCount > 0) ? ", " : ""}${ctx.draftsReadyCount > 0 ? `drafted ${ctx.draftsReadyCount} ${ctx.draftsReadyCount === 1 ? "reply" : "replies"} for your review` : ""}${ctx.draftsReadyCount > 0 && ctx.yesterday.snoozedCount > 0 ? ", " : ""}${ctx.yesterday.snoozedCount > 0 ? `and snoozed ${ctx.yesterday.snoozedCount} ${ctx.yesterday.snoozedCount === 1 ? "thread" : "threads"} for later` : ""}.`;
  const para3 =
    ctx.upcomingEvents.length === 0
      ? "Calendar is open today — good time to focus on the asks above."
      : `Today: ${ctx.upcomingEvents
          .slice(0, 3)
          .map((e) => e.summary)
          .join(", ")}.`;
  return `${para1}\n\n${para2}\n\n${para3}`;
}

// ─── Persistence ────────────────────────────────────────────────────────

interface BriefingRow {
  account_id: string;
  date: string;
  briefing_text: string;
  action_items_json: string;
  stats_json: string;
  generated_at: number;
  dismissed_at: number | null;
}

function rowToBriefing(row: BriefingRow): DailyBriefing {
  const actionItems = (() => {
    try {
      const parsed = JSON.parse(row.action_items_json) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x): x is BriefingActionItem => {
        if (!x || typeof x !== "object") return false;
        const o = x as Record<string, unknown>;
        return (
          typeof o.threadId === "string" &&
          typeof o.emailId === "string" &&
          typeof o.subject === "string"
        );
      });
    } catch {
      return [];
    }
  })();
  const stats = (() => {
    try {
      const parsed = JSON.parse(row.stats_json) as unknown;
      if (!parsed || typeof parsed !== "object") return defaultStats();
      const o = parsed as Record<string, unknown>;
      return {
        newEmails: typeof o.newEmails === "number" ? o.newEmails : 0,
        needsReplyCount: typeof o.needsReplyCount === "number" ? o.needsReplyCount : 0,
        autoHandledCount: typeof o.autoHandledCount === "number" ? o.autoHandledCount : 0,
        draftsReadyCount: typeof o.draftsReadyCount === "number" ? o.draftsReadyCount : 0,
        snoozedCount: typeof o.snoozedCount === "number" ? o.snoozedCount : 0,
        upcomingEventsCount: typeof o.upcomingEventsCount === "number" ? o.upcomingEventsCount : 0,
      };
    } catch {
      return defaultStats();
    }
  })();
  return {
    accountId: row.account_id,
    date: row.date,
    briefingText: row.briefing_text,
    actionItems,
    stats,
    generatedAt: row.generated_at,
    dismissedAt: row.dismissed_at,
  };
}

function defaultStats(): BriefingStats {
  return {
    newEmails: 0,
    needsReplyCount: 0,
    autoHandledCount: 0,
    draftsReadyCount: 0,
    snoozedCount: 0,
    upcomingEventsCount: 0,
  };
}

function readBriefing(accountId: string, isoDate: string): DailyBriefing | null {
  const row = getDb()
    .prepare(
      `SELECT account_id, date, briefing_text, action_items_json,
              stats_json, generated_at, dismissed_at
       FROM daily_briefings
       WHERE account_id = ? AND date = ?`,
    )
    .get(accountId, isoDate) as BriefingRow | undefined;
  if (!row) return null;
  return rowToBriefing(row);
}

function writeBriefing(b: DailyBriefing): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO daily_briefings
         (account_id, date, briefing_text, action_items_json, stats_json,
          generated_at, dismissed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      b.accountId,
      b.date,
      b.briefingText,
      JSON.stringify(b.actionItems),
      JSON.stringify(b.stats),
      b.generatedAt,
      b.dismissedAt,
    );
}

/**
 * Drop briefings older than 7 days. Called opportunistically on every
 * generate so old rows don't accumulate; explicit retention policy
 * keeps the table tiny (≤ 7 rows per account).
 */
function pruneOldBriefings(): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  getDb().prepare("DELETE FROM daily_briefings WHERE generated_at < ?").run(cutoff);
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface GenerateOptions {
  accountId: string;
  /** Defaults to today's local calendar date. */
  date?: string;
  /** If true, regenerate even when a row exists for this date. */
  force?: boolean;
}

/**
 * Get today's briefing (default) or the given date's, generating + caching
 * if it doesn't exist. Idempotent: a second call on the same day returns
 * the cached row without burning another LLM call.
 */
export async function getOrGenerateBriefing(opts: GenerateOptions): Promise<DailyBriefing> {
  const isoDate = opts.date ?? todayIsoDate();
  if (!opts.force) {
    const existing = readBriefing(opts.accountId, isoDate);
    if (existing) return existing;
  }

  const ctx = gatherContext(opts.accountId, isoDate);
  const stats: BriefingStats = {
    newEmails: ctx.yesterday.newEmails,
    needsReplyCount: ctx.needsReply.length,
    autoHandledCount: ctx.yesterday.autoHandledCount,
    draftsReadyCount: ctx.draftsReadyCount,
    snoozedCount: ctx.yesterday.snoozedCount,
    upcomingEventsCount: ctx.upcomingEvents.length,
  };

  // Generate (or fall back) — try the LLM, then a deterministic build.
  let briefingText: string;
  try {
    const generated = await generateBriefingText(ctx, isoDate, opts.accountId);
    briefingText = generated.briefingText;
  } catch (err) {
    log.warn("LLM briefing call failed, using fallback", {
      accountId: opts.accountId,
      err: err instanceof Error ? err.message : String(err),
    });
    briefingText = buildFallbackBriefing(ctx);
  }

  const briefing: DailyBriefing = {
    accountId: opts.accountId,
    date: isoDate,
    briefingText,
    actionItems: ctx.needsReply,
    stats,
    generatedAt: Date.now(),
    dismissedAt: null,
  };
  writeBriefing(briefing);
  pruneOldBriefings();
  return briefing;
}

/**
 * Mark a briefing as dismissed (user clicked "Got it"). Idempotent — a
 * second dismiss is a no-op.
 */
export function dismissBriefing(accountId: string, date: string): DailyBriefing | null {
  const existing = readBriefing(accountId, date);
  if (!existing) return null;
  if (existing.dismissedAt !== null) return existing;
  const now = Date.now();
  getDb()
    .prepare("UPDATE daily_briefings SET dismissed_at = ? WHERE account_id = ? AND date = ?")
    .run(now, accountId, date);
  return { ...existing, dismissedAt: now };
}

/** Last N days of briefings for an account, newest first. */
export function listBriefings(accountId: string, limit = 7): DailyBriefing[] {
  const cap = Math.min(Math.max(limit, 1), 30);
  const rows = getDb()
    .prepare(
      `SELECT account_id, date, briefing_text, action_items_json,
              stats_json, generated_at, dismissed_at
       FROM daily_briefings
       WHERE account_id = ?
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(accountId, cap) as BriefingRow[];
  return rows.map(rowToBriefing);
}
