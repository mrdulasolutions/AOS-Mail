// Learned rules — turn user corrections into auto-actions.
//
// The premise: when the user repeatedly disagrees with the analyzer for a
// particular sender / domain (e.g. archives a "needs reply" newsletter
// 3+ times), we learn the disagreement and start auto-handling it. That
// (a) saves the user from clicking archive over and over, and (b) saves
// the cost+latency of the Claude analysis call for emails the user has
// already taught us to ignore.
//
// Storage: piggybacks on the existing memories tables — no schema change
// required.
//
//   draft_memories          → per-disagreement observations. vote_count
//                             counts how many times we've seen the same
//                             sender domain + action combination. The
//                             email_context column carries a JSON blob
//                             that names the action and last seen time
//                             so we can detect contradictions.
//
//   memories (promoted)     → confidence threshold met (≥3 same-action
//                             observations, no contradictions in 30d).
//                             source = "priority-override", memoryType
//                             = "analysis", content carries a structured
//                             prefix `[learned-rule:archive:N] desc` so
//                             we can recover {action, count} on read.
//                             enabled toggle drives whether the rule
//                             actually fires.
//
// Why structured prefixes instead of new columns: the memories /
// draft_memories tables already round-trip through memory.list,
// memory.update, memory.delete and the renderer's MemoriesTab. Adding
// columns would leak through the existing surface unless we shadowed
// it; keeping rules in the existing tables means the user can see them
// in AI Memories and the Learned Rules card stays a focused view.
//
// Wiring overview:
//   1. recordOverride() called from emails.archive / emails.trash when
//      the user disagrees with an analysis (needs_reply was true).
//      Bumps the matching draft_memory; promotes once threshold hit.
//   2. findApplicableRules() called from email-analyzer.analyzeEmail
//      BEFORE the Claude call. If we have a matching rule (sender or
//      domain), we synthesize an analysis result tagged source =
//      "learned-rule" and skip Claude entirely.
//
// Threshold/confidence model: 3+ observations of the same action AND
// no contradicting action recorded in the last 30 days. Contradiction
// rules:
//   - "archived" / "trashed" → "replied" or "snoozed" contradicts
//   - "replied" / "snoozed"  → "archived" / "trashed" contradicts
//
// Returning the inferred analysis result to the caller is a deliberate
// choice over emitting an event: the analyzer is the only consumer
// today and we want a synchronous read. The notification path
// (analysis-override:learned event) is left untouched — it fires when
// memory.classify produces a new memory, which still happens here.

import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { createMessage } from "./anthropic.js";
import { resolveModelFor } from "./model-config.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("learned-rules");

const PROMOTION_THRESHOLD = 3;
const CONTRADICTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ----- Types -----

export type LearnedAction = "archived" | "trashed" | "replied" | "snoozed";

export interface OverrideInput {
  emailId: string;
  accountId: string;
  override: {
    /** Original analysis result the analyzer produced. */
    from: { needsReply: boolean; priority?: string | null };
    /** What the user effectively decided by their action. */
    to: { needsReply: boolean; priority?: string | null };
    action: LearnedAction;
  };
}

export interface RecordOverrideResult {
  /** Whether a brand-new draft observation was created. */
  observationCreated: boolean;
  /** Whether this call promoted a draft observation to a memory rule. */
  promoted: boolean;
  /** The id of the memory row produced or refreshed (when promoted). */
  memoryId: string | null;
  /** The id of the underlying draft_memories row (always returned). */
  draftMemoryId: string;
  /** Total observation count after this call. */
  voteCount: number;
}

export interface LearnedRule {
  id: string;
  accountId: string;
  scope: "person" | "domain" | "category" | "global";
  scopeValue: string | null;
  action: LearnedAction;
  /** How many overrides fed into this rule. */
  count: number;
  /** Whether the rule fires today (toggleable from settings). */
  enabled: boolean;
  /** Original Claude-classified summary text (for the UI). */
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface ApplicableRuleMatch {
  rule: LearnedRule;
  /** Pre-shaped analysis result to substitute for the Claude call. */
  analysis: {
    needsReply: false;
    reason: string;
    priority: null;
    /** Marks this as auto-derived; the renderer can show "auto-archived". */
    source: "learned-rule";
    ruleId: string;
    action: LearnedAction;
  };
}

// ----- DB row shapes -----

interface DraftMemoryRow {
  id: string;
  account_id: string;
  scope: string;
  scope_value: string | null;
  content: string;
  vote_count: number;
  source_email_ids: string;
  sender_email: string | null;
  sender_domain: string | null;
  subject: string | null;
  email_context: string | null;
  memory_type: string;
  created_at: number;
  last_voted_at: number;
}

interface MemoryRow {
  id: string;
  account_id: string;
  scope: string;
  scope_value: string | null;
  content: string;
  source: string;
  source_email_id: string | null;
  enabled: number;
  memory_type: string;
  created_at: number;
  updated_at: number;
}

// ----- Encoding helpers -----
//
// We encode {action, count} into the existing string columns so we don't
// need a schema migration. The format is unambiguous and parseable.

const PROMOTED_PREFIX_RE = /^\[learned-rule:(archived|trashed|replied|snoozed):(\d+)\]\s*/;

function encodePromotedContent(action: LearnedAction, count: number, description: string): string {
  return `[learned-rule:${action}:${count}] ${description.trim()}`;
}

function decodePromotedContent(
  content: string,
): { action: LearnedAction; count: number; description: string } | null {
  const m = PROMOTED_PREFIX_RE.exec(content);
  if (!m) return null;
  return {
    action: m[1] as LearnedAction,
    count: Number(m[2]),
    description: content.slice(m[0].length),
  };
}

// Per-observation metadata — stashed in draft_memories.email_context as
// JSON. (`emailContext` is a free-form description field today; nothing
// else in the codebase reads it for analysis memories.)
interface ObservationContext {
  kind: "learned-rule-observation";
  action: LearnedAction;
  /** ms timestamps of every override seen so far, newest last. */
  history: Array<{ action: LearnedAction; at: number; emailId: string }>;
}

function encodeObservationContext(ctx: ObservationContext): string {
  return JSON.stringify(ctx);
}

function decodeObservationContext(raw: string | null): ObservationContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { kind?: string };
    if (parsed && parsed.kind === "learned-rule-observation") {
      return parsed as ObservationContext;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function pickScopeValue(
  scope: "person" | "domain" | "category" | "global",
  scopeValue: string | null,
  fallbackEmail: string,
  fallbackDomain: string | null,
): string | null {
  if (scope === "global") return null;
  if (scope === "domain") return (scopeValue ?? fallbackDomain ?? "").toLowerCase();
  if (scope === "person") return (scopeValue ?? fallbackEmail).toLowerCase();
  if (scope === "category") return scopeValue;
  return null;
}

function senderDomainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.length > 0 ? d : null;
}

function isContradiction(prev: LearnedAction, next: LearnedAction): boolean {
  // archived/trashed cluster vs replied/snoozed cluster.
  const dismissCluster: ReadonlyArray<LearnedAction> = ["archived", "trashed"];
  const engageCluster: ReadonlyArray<LearnedAction> = ["replied", "snoozed"];
  const prevDismiss = dismissCluster.includes(prev);
  const nextDismiss = dismissCluster.includes(next);
  const prevEngage = engageCluster.includes(prev);
  const nextEngage = engageCluster.includes(next);
  return (prevDismiss && nextEngage) || (prevEngage && nextDismiss);
}

// ----- Scope classification (Claude-backed) -----
//
// We reuse the same JSON-classification approach as memory.classify so the
// user sees consistent scope decisions across the app. The feedback string
// describes the disagreement; Claude returns scope + scopeValue + a clean
// description we can store as the rule's UI label.

const VALID_SCOPES = ["person", "domain", "category", "global"] as const;
type ClassifiedScope = (typeof VALID_SCOPES)[number];

interface ClassifyResult {
  scope: ClassifiedScope;
  scopeValue: string | null;
  description: string;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function classifyOverrideScope(args: {
  action: LearnedAction;
  senderEmail: string;
  senderDomain: string | null;
  subject: string | null;
}): Promise<ClassifyResult> {
  const fallback: ClassifyResult = {
    scope: "domain",
    scopeValue: args.senderDomain ?? args.senderEmail.toLowerCase(),
    description: `Auto-${args.action} mail from ${args.senderDomain ?? args.senderEmail}`,
  };

  // Same pattern as memory.classify: short-circuit in test/demo to avoid
  // burning quota and keep behavior deterministic.
  if (process.env.AOS_TEST_MODE === "true" || process.env.AOS_DEMO_MODE === "true") {
    return fallback;
  }

  try {
    const response = await createMessage(
      {
        model: resolveModelFor("classify"),
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: `The user just ${args.action} an email the analyzer thought needed a reply. Classify the right scope so we can auto-${args.action} similar mail in the future.

Sender email: ${args.senderEmail}
Sender domain: ${args.senderDomain ?? "(unknown)"}
Subject: ${args.subject ?? "(unknown)"}

Determine:
1. scope: "person" (only this sender), "domain" (everyone at ${args.senderDomain}), "category" (a type of email — newsletters, receipts, calendar invites…), or "global" (every email)
2. scopeValue: the email (person), domain (domain), category name (category), or null (global). For newsletters / receipts, prefer "domain" with the actual domain.
3. description: a brief rule label like "Newsletter from acme.com" or "Receipt from stripe.com"

Respond in JSON only: {"scope":"...","scopeValue":"...","description":"..."}`,
          },
        ],
      },
      { caller: "learned-rules.classify" },
    );

    const block = response.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const jsonStr = extractJsonObject(text);
    if (!jsonStr) return fallback;

    const parsed = JSON.parse(jsonStr) as {
      scope?: string;
      scopeValue?: string | null;
      description?: string;
    };

    const scope = (VALID_SCOPES as readonly string[]).includes(parsed.scope ?? "")
      ? (parsed.scope as ClassifiedScope)
      : "domain";
    const scopeValue = pickScopeValue(
      scope,
      parsed.scopeValue ?? null,
      args.senderEmail,
      args.senderDomain,
    );

    const description = (parsed.description ?? "").trim() || fallback.description;
    return { scope, scopeValue, description };
  } catch (err) {
    log.warn("scope classification failed; using domain fallback", {
      err: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

// ----- Public API -----

/**
 * Persist a single user-disagreement observation. If we've seen the same
 * sender/domain + action 3+ times with no recent contradictions, promote
 * to a learned rule (memories table) so analyzeEmail() will short-circuit
 * future calls.
 *
 * Idempotent on the same (accountId, scope, action) — repeated calls just
 * bump vote_count.
 */
export async function recordOverride(input: OverrideInput): Promise<RecordOverrideResult> {
  const db = getDb();

  // Look up the email so we know who it's from. Not strictly required for
  // the flow but the prompt classification needs it.
  const emailRow = db
    .prepare(
      "SELECT from_address, subject, account_id FROM emails WHERE id = ?",
    )
    .get(input.emailId) as
    | { from_address: string; subject: string; account_id: string }
    | undefined;

  const senderEmail = (emailRow?.from_address ?? "").toLowerCase();
  const senderDomain = senderEmail ? senderDomainOf(senderEmail) : null;
  const subject = emailRow?.subject ?? null;

  // Classify the disagreement → scope + scope value + description.
  const classified = await classifyOverrideScope({
    action: input.override.action,
    senderEmail: senderEmail || "unknown@unknown",
    senderDomain,
    subject,
  });

  const now = Date.now();

  // Find an existing draft observation for the same accountId+scope+
  // scopeValue+memoryType so we can bump it, instead of creating a new
  // row each time.
  const existing = db
    .prepare(
      `SELECT * FROM draft_memories
       WHERE account_id = ?
         AND memory_type = 'analysis'
         AND scope = ?
         AND COALESCE(scope_value, '') = COALESCE(?, '')`,
    )
    .all(input.accountId, classified.scope, classified.scopeValue) as DraftMemoryRow[];

  // Filter to the row whose stored action matches what we just saw — if
  // the user has been doing two different things at the same scope, we
  // track them independently so contradictions can fire.
  let row: DraftMemoryRow | null = null;
  for (const candidate of existing) {
    const ctx = decodeObservationContext(candidate.email_context);
    if (ctx && ctx.action === input.override.action) {
      row = candidate;
      break;
    }
  }

  let observationCreated = false;
  let voteCount = 1;
  let draftMemoryId: string;
  const sourceEmailIds: string[] = [input.emailId];
  const history: ObservationContext["history"] = [
    { action: input.override.action, at: now, emailId: input.emailId },
  ];

  if (!row) {
    // Brand-new observation row.
    draftMemoryId = randomUUID();
    observationCreated = true;
    const ctx: ObservationContext = {
      kind: "learned-rule-observation",
      action: input.override.action,
      history,
    };
    db.prepare(
      `INSERT INTO draft_memories
         (id, account_id, scope, scope_value, content,
          vote_count, source_email_ids, sender_email, sender_domain,
          subject, email_context, memory_type, created_at, last_voted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'analysis', ?, ?)`,
    ).run(
      draftMemoryId,
      input.accountId,
      classified.scope,
      classified.scopeValue,
      classified.description,
      1,
      JSON.stringify(sourceEmailIds),
      senderEmail || null,
      senderDomain,
      subject,
      encodeObservationContext(ctx),
      now,
      now,
    );
  } else {
    // Bump existing row.
    draftMemoryId = row.id;
    voteCount = row.vote_count + 1;
    const prevIds = (() => {
      try {
        const parsed: unknown = JSON.parse(row.source_email_ids);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    })();
    const merged = Array.from(new Set([...prevIds, input.emailId]));
    const ctx = decodeObservationContext(row.email_context);
    const newCtx: ObservationContext = {
      kind: "learned-rule-observation",
      action: input.override.action,
      history: [
        ...(ctx?.history ?? []),
        { action: input.override.action, at: now, emailId: input.emailId },
      ].slice(-50), // bounded so the column doesn't grow forever
    };
    db.prepare(
      `UPDATE draft_memories
         SET vote_count = ?, source_email_ids = ?, last_voted_at = ?,
             email_context = ?, content = ?
       WHERE id = ?`,
    ).run(
      voteCount,
      JSON.stringify(merged),
      now,
      encodeObservationContext(newCtx),
      classified.description,
      draftMemoryId,
    );
  }

  // Decide whether to promote — threshold + no-contradiction-in-30d.
  let promoted = false;
  let memoryId: string | null = null;

  if (voteCount >= PROMOTION_THRESHOLD) {
    // Look for any opposite-cluster observation for the same scope in the
    // window. We tolerate same-cluster differences (archived vs trashed
    // both map to "dismiss"); only true reversal blocks promotion.
    const cutoff = now - CONTRADICTION_WINDOW_MS;
    const siblings = db
      .prepare(
        `SELECT email_context FROM draft_memories
         WHERE account_id = ?
           AND memory_type = 'analysis'
           AND scope = ?
           AND COALESCE(scope_value, '') = COALESCE(?, '')
           AND last_voted_at >= ?`,
      )
      .all(input.accountId, classified.scope, classified.scopeValue, cutoff) as Array<{
      email_context: string | null;
    }>;

    let contradicted = false;
    for (const s of siblings) {
      const ctx = decodeObservationContext(s.email_context);
      if (!ctx) continue;
      if (isContradiction(input.override.action, ctx.action)) {
        // Be strict: contradiction means at least one event in window.
        if (ctx.history.some((h) => h.at >= cutoff)) {
          contradicted = true;
          break;
        }
      }
    }

    if (!contradicted) {
      // Upsert the rule. We key on (accountId, scope, scopeValue, action)
      // so re-promotions just bump count + updatedAt.
      const existingMemory = findRuleMemory(
        input.accountId,
        classified.scope,
        classified.scopeValue,
        input.override.action,
      );

      if (existingMemory) {
        memoryId = existingMemory.id;
        const newContent = encodePromotedContent(
          input.override.action,
          voteCount,
          classified.description,
        );
        db.prepare(
          `UPDATE memories
             SET content = ?, updated_at = ?, enabled = 1
           WHERE id = ?`,
        ).run(newContent, now, memoryId);
        promoted = false; // re-bump only — not a new promotion
      } else {
        memoryId = randomUUID();
        db.prepare(
          `INSERT INTO memories
             (id, account_id, scope, scope_value, content, source,
              source_email_id, enabled, memory_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'priority-override', ?, 1, 'analysis', ?, ?)`,
        ).run(
          memoryId,
          input.accountId,
          classified.scope,
          classified.scopeValue,
          encodePromotedContent(input.override.action, voteCount, classified.description),
          input.emailId,
          now,
          now,
        );
        promoted = true;
        log.info("promoted learned rule", {
          memoryId,
          accountId: input.accountId,
          scope: classified.scope,
          scopeValue: classified.scopeValue,
          action: input.override.action,
          count: voteCount,
        });
      }
    }
  }

  return {
    observationCreated,
    promoted,
    memoryId,
    draftMemoryId,
    voteCount,
  };
}

function findRuleMemory(
  accountId: string,
  scope: string,
  scopeValue: string | null,
  action: LearnedAction,
): MemoryRow | null {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memories
       WHERE account_id = ?
         AND source = 'priority-override'
         AND memory_type = 'analysis'
         AND scope = ?
         AND COALESCE(scope_value, '') = COALESCE(?, '')`,
    )
    .all(accountId, scope, scopeValue) as MemoryRow[];
  for (const r of rows) {
    const decoded = decodePromotedContent(r.content);
    if (decoded && decoded.action === action) return r;
  }
  return null;
}

function rowToRule(row: MemoryRow): LearnedRule | null {
  const decoded = decodePromotedContent(row.content);
  if (!decoded) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    scope: row.scope as LearnedRule["scope"],
    scopeValue: row.scope_value,
    action: decoded.action,
    count: decoded.count,
    enabled: row.enabled === 1,
    description: decoded.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * For an incoming email, return any high-confidence rules that match. The
 * analyzer uses this to skip the Claude call.
 *
 * Match semantics, in priority order:
 *   1. enabled person rule for sender@addr
 *   2. enabled domain rule for the part after @
 *   3. enabled global rule
 *
 * Category rules are intentionally not matched here — they need an
 * upstream classifier we don't run yet, and a "category=newsletter" rule
 * that auto-archives every newsletter is too aggressive without that.
 */
export function findApplicableRules(args: {
  email: { from: string; accountId: string };
}): ApplicableRuleMatch[] {
  const sender = (args.email.from ?? "").toLowerCase();
  const domain = senderDomainOf(sender);
  const db = getDb();

  // Pull all rules for the account at once — small set, simpler than 3
  // round trips. Filter in memory.
  const allRows = db
    .prepare(
      `SELECT * FROM memories
       WHERE account_id = ?
         AND source = 'priority-override'
         AND memory_type = 'analysis'
         AND enabled = 1`,
    )
    .all(args.email.accountId) as MemoryRow[];

  const matches: ApplicableRuleMatch[] = [];
  for (const row of allRows) {
    const rule = rowToRule(row);
    if (!rule) continue;
    if (rule.count < PROMOTION_THRESHOLD) continue;

    const matched =
      rule.scope === "global" ||
      (rule.scope === "person" && rule.scopeValue && rule.scopeValue === sender) ||
      (rule.scope === "domain" && rule.scopeValue && domain && rule.scopeValue === domain);

    if (!matched) continue;

    matches.push({
      rule,
      analysis: {
        needsReply: false,
        reason: `Auto-${rule.action} (learned from ${rule.count} similar overrides)`,
        priority: null,
        source: "learned-rule",
        ruleId: rule.id,
        action: rule.action,
      },
    });
  }

  // Stable ordering so callers can pick the most specific rule
  // (person > domain > global) deterministically.
  const scopeOrder: Record<LearnedRule["scope"], number> = {
    person: 0,
    domain: 1,
    category: 2,
    global: 3,
  };
  matches.sort((a, b) => scopeOrder[a.rule.scope] - scopeOrder[b.rule.scope]);
  return matches;
}

/**
 * Read all active+disabled rules for the renderer's Learned Rules card.
 * Returned newest-first.
 */
export function listLearnedRules(accountId?: string): LearnedRule[] {
  const db = getDb();
  const rows = (
    accountId
      ? (db
          .prepare(
            `SELECT * FROM memories
             WHERE account_id = ?
               AND source = 'priority-override'
               AND memory_type = 'analysis'
             ORDER BY updated_at DESC`,
          )
          .all(accountId) as MemoryRow[])
      : (db
          .prepare(
            `SELECT * FROM memories
             WHERE source = 'priority-override' AND memory_type = 'analysis'
             ORDER BY updated_at DESC`,
          )
          .all() as MemoryRow[])
  ).map(rowToRule);
  return rows.filter((r): r is LearnedRule => r !== null);
}

/** Toggle a rule on/off without deleting it. */
export function toggleLearnedRule(ruleId: string, enabled: boolean): LearnedRule | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM memories
       WHERE id = ? AND source = 'priority-override' AND memory_type = 'analysis'`,
    )
    .get(ruleId) as MemoryRow | undefined;
  if (!row) return null;
  db.prepare(
    `UPDATE memories SET enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(enabled ? 1 : 0, Date.now(), ruleId);
  const updated = db
    .prepare(`SELECT * FROM memories WHERE id = ?`)
    .get(ruleId) as MemoryRow | undefined;
  return updated ? rowToRule(updated) : null;
}

/**
 * Reset all learned rules. Both the promoted memories AND the underlying
 * draft observations are cleared so the user can start over with the
 * same accountId without ghosts re-promoting from leftover counts.
 */
export function resetLearnedRules(accountId?: string): { deletedRules: number; deletedObservations: number } {
  const db = getDb();
  const memoryWhere = accountId
    ? `account_id = ? AND source = 'priority-override' AND memory_type = 'analysis'`
    : `source = 'priority-override' AND memory_type = 'analysis'`;
  const draftWhere = accountId
    ? `account_id = ? AND memory_type = 'analysis'`
    : `memory_type = 'analysis'`;

  const memArgs = accountId ? [accountId] : [];
  const draftArgs = accountId ? [accountId] : [];

  // We narrow draft_memories deletion to rows whose email_context is one
  // of our learned-rule observations — never wipe other consumers'
  // analysis-type draft memories (none today, but future-proof).
  const draftRows = db
    .prepare(`SELECT id, email_context FROM draft_memories WHERE ${draftWhere}`)
    .all(...draftArgs) as Array<{ id: string; email_context: string | null }>;
  const ourDraftIds = draftRows
    .filter((r) => decodeObservationContext(r.email_context) !== null)
    .map((r) => r.id);

  let deletedObs = 0;
  if (ourDraftIds.length > 0) {
    const placeholders = ourDraftIds.map(() => "?").join(",");
    const stmt = db.prepare(`DELETE FROM draft_memories WHERE id IN (${placeholders})`);
    deletedObs = stmt.run(...ourDraftIds).changes;
  }

  const memResult = db.prepare(`DELETE FROM memories WHERE ${memoryWhere}`).run(...memArgs);

  return { deletedRules: memResult.changes, deletedObservations: deletedObs };
}
