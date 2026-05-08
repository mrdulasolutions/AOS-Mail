// `memory` IPC namespace — agent persistent-memory CRUD + scope classify.
//
// Memories let the user record per-sender / per-domain / per-category /
// global preferences that the agent uses when triaging or drafting (e.g.
// "for emails from Acme Corp, check #acme-deals in Slack first").
//
// Lifted from src/main/ipc/memory.ipc.ts. Pure DB-backed CRUD against the
// `memories` table plus `memory.classify` which calls Claude Haiku for
// JSON scope classification.
//
// `draftMemory.list` / `draftMemory.delete` are also lifted here (they
// share the table-level concerns with memory). `draftMemory.promote`
// depends on the `consolidateMemoryScopes` helper from
// src/main/services/draft-edit-learner.ts (large, has its own deps), so
// it is intentionally stubbed with a clear "not yet wired" error until
// that service is lifted.

import { randomUUID } from "node:crypto";
import { registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";
import { createMessage } from "../services/anthropic.js";
import { createLogger } from "../lib/logger.js";
import { getPreferences } from "../lib/preferences.js";

const log = createLogger("memory-methods");

// Default model for memory scope classification when nothing's configured.
// This is a tiny JSON-extraction job over a single feedback string, so Haiku
// (or its OpenRouter equivalent) is plenty.
const DEFAULT_CLASSIFY_MODEL = "claude-haiku-4-5-20251001";

/**
 * Resolve which model to use for memory.classify.
 *
 * memory.classify is a short JSON-extraction job — same shape as thread-summary
 * — so we honor `modelConfig.summary` rather than introducing a separate
 * `classify` key in the user-facing settings (it would bloat the AI Models
 * card for a feature most users will never see). Falls back to Haiku.
 *
 * Same provider routing as the rest of the sidecar: claude-* → Anthropic SDK,
 * else → OpenRouter via the createMessage router.
 */
function resolveClassifyModel(): string {
  const prefs = getPreferences() as {
    modelConfig?: { summary?: unknown };
  };
  const raw = prefs.modelConfig?.summary;
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_CLASSIFY_MODEL;
  const trimmed = raw.trim();
  // Legacy tier names — same mapping the rest of the sidecar uses.
  if (trimmed === "haiku") return "claude-haiku-4-5-20251001";
  if (trimmed === "sonnet") return "claude-sonnet-4-5-20250929";
  if (trimmed === "opus") return "claude-opus-4-20250514";
  return trimmed;
}

// ----- Types (mirror src/shared/types.ts; sidecar can't import that path) -----

type MemoryScope = "global" | "person" | "domain" | "category";
type MemorySource = "manual" | "refinement" | "draft-edit" | "priority-override";
type MemoryType = "drafting" | "analysis";

interface Memory {
  id: string;
  accountId: string;
  scope: MemoryScope;
  scopeValue: string | null;
  content: string;
  source: MemorySource;
  sourceEmailId: string | null;
  enabled: boolean;
  memoryType: MemoryType;
  createdAt: number;
  updatedAt: number;
}

interface DraftMemory {
  id: string;
  accountId: string;
  scope: MemoryScope;
  scopeValue: string | null;
  content: string;
  voteCount: number;
  sourceEmailIds: string[];
  senderEmail: string | null;
  senderDomain: string | null;
  subject: string | null;
  emailContext: string | null;
  memoryType: MemoryType;
  createdAt: number;
  lastVotedAt: number;
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

const VALID_SCOPES: MemoryScope[] = ["person", "domain", "category", "global"];

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    accountId: row.account_id,
    scope: row.scope as MemoryScope,
    scopeValue: row.scope_value,
    content: row.content,
    source: row.source as MemorySource,
    sourceEmailId: row.source_email_id,
    enabled: row.enabled === 1,
    memoryType: (row.memory_type ?? "drafting") as MemoryType,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDraftMemory(row: DraftMemoryRow): DraftMemory {
  let sourceEmailIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.source_email_ids);
    if (Array.isArray(parsed)) {
      sourceEmailIds = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    sourceEmailIds = [];
  }
  return {
    id: row.id,
    accountId: row.account_id,
    scope: row.scope as MemoryScope,
    scopeValue: row.scope_value,
    content: row.content,
    voteCount: row.vote_count,
    sourceEmailIds,
    senderEmail: row.sender_email,
    senderDomain: row.sender_domain,
    subject: row.subject,
    emailContext: row.email_context,
    memoryType: (row.memory_type ?? "drafting") as MemoryType,
    createdAt: row.created_at,
    lastVotedAt: row.last_voted_at,
  };
}

// ----- DB helpers (lifted from src/main/db/index.ts) -----

function dbGetMemories(accountId: string): Memory[] {
  const rows = getDb()
    .prepare("SELECT * FROM memories WHERE account_id = ? ORDER BY scope, created_at DESC")
    .all(accountId) as MemoryRow[];
  return rows.map(rowToMemory);
}

function dbGetMemory(id: string): Memory | null {
  const row = getDb().prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | MemoryRow
    | undefined;
  return row ? rowToMemory(row) : null;
}

function dbGetRelevantMemories(
  senderEmail: string,
  accountId: string,
  memoryType: MemoryType,
): Memory[] {
  const db = getDb();
  const lowered = senderEmail.toLowerCase();
  const domain = lowered.includes("@") ? lowered.split("@")[1] : null;

  const personRows = db
    .prepare(
      "SELECT * FROM memories WHERE account_id = ? AND scope = 'person' AND scope_value = ? AND enabled = 1 AND memory_type = ? ORDER BY created_at DESC",
    )
    .all(accountId, lowered, memoryType) as MemoryRow[];

  const domainRows = domain
    ? (db
        .prepare(
          "SELECT * FROM memories WHERE account_id = ? AND scope = 'domain' AND scope_value = ? AND enabled = 1 AND memory_type = ? ORDER BY created_at DESC",
        )
        .all(accountId, domain.toLowerCase(), memoryType) as MemoryRow[])
    : [];

  const categoryRows = db
    .prepare(
      "SELECT * FROM memories WHERE account_id = ? AND scope = 'category' AND enabled = 1 AND memory_type = ? ORDER BY created_at DESC",
    )
    .all(accountId, memoryType) as MemoryRow[];

  const globalRows = db
    .prepare(
      "SELECT * FROM memories WHERE account_id = ? AND scope = 'global' AND enabled = 1 AND memory_type = ? ORDER BY created_at DESC",
    )
    .all(accountId, memoryType) as MemoryRow[];

  return [
    ...personRows.map(rowToMemory),
    ...domainRows.map(rowToMemory),
    ...categoryRows.map(rowToMemory),
    ...globalRows.map(rowToMemory),
  ];
}

function dbSaveMemory(memory: Memory): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO memories
         (id, account_id, scope, scope_value, content, source, source_email_id,
          enabled, memory_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      memory.id,
      memory.accountId,
      memory.scope,
      memory.scopeValue,
      memory.content,
      memory.source,
      memory.sourceEmailId,
      memory.enabled ? 1 : 0,
      memory.memoryType,
      memory.createdAt,
      memory.updatedAt,
    );
}

function dbUpdateMemory(
  id: string,
  updates: {
    content?: string;
    enabled?: boolean;
    scope?: MemoryScope;
    scopeValue?: string | null;
  },
): void {
  const existing = dbGetMemory(id);
  if (!existing) return;
  const newContent = updates.content ?? existing.content;
  const newEnabled = updates.enabled ?? existing.enabled;
  const newScope = updates.scope ?? existing.scope;
  const newScopeValue = updates.scopeValue !== undefined ? updates.scopeValue : existing.scopeValue;

  getDb()
    .prepare(
      "UPDATE memories SET content = ?, enabled = ?, scope = ?, scope_value = ?, updated_at = ? WHERE id = ?",
    )
    .run(newContent, newEnabled ? 1 : 0, newScope, newScopeValue, Date.now(), id);
}

function dbDeleteMemory(id: string): void {
  getDb().prepare("DELETE FROM memories WHERE id = ?").run(id);
}

function dbMemoryCategories(accountId: string): string[] {
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT scope_value FROM memories WHERE account_id = ? AND scope = 'category' AND scope_value IS NOT NULL ORDER BY scope_value",
    )
    .all(accountId) as Array<{ scope_value: string }>;
  return rows.map((r) => r.scope_value);
}

function dbGetDraftMemories(accountId: string): DraftMemory[] {
  const rows = getDb()
    .prepare("SELECT * FROM draft_memories WHERE account_id = ? ORDER BY last_voted_at DESC")
    .all(accountId) as DraftMemoryRow[];
  return rows.map(rowToDraftMemory);
}

function dbDeleteDraftMemory(id: string): void {
  getDb().prepare("DELETE FROM draft_memories WHERE id = ?").run(id);
}

// ----- JSON-extraction helper for classify (lifts the brace-matching from the
// Electron handler so we tolerate prose around the JSON object). -----

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

// ----- Method registration -----

export function registerMemoryMethods(): void {
  // memory.list(accountId)
  registerMethod("memory.list", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("memory.list: missing accountId");
    return dbGetMemories(accountId);
  });

  // memory.getForEmail(senderEmail, accountId)
  // Returns drafting + analysis memories merged & deduped by id.
  registerMethod("memory.getForEmail", (params) => {
    const { senderEmail, accountId } =
      (params as { senderEmail?: string; accountId?: string }) ?? {};
    if (!senderEmail || !accountId) {
      throw new Error("memory.getForEmail: requires { senderEmail, accountId }");
    }
    const sender = senderEmail.toLowerCase();
    const drafting = dbGetRelevantMemories(sender, accountId, "drafting");
    const analysis = dbGetRelevantMemories(sender, accountId, "analysis");
    const seen = new Set(drafting.map((m) => m.id));
    return [...drafting, ...analysis.filter((m) => !seen.has(m.id))];
  });

  // memory.save({...})
  registerMethod("memory.save", (params) => {
    const p =
      (params as {
        accountId?: string;
        scope?: MemoryScope;
        scopeValue?: string | null;
        content?: string;
        source?: MemorySource;
        sourceEmailId?: string | null;
      }) ?? {};
    if (!p.accountId) throw new Error("memory.save: missing accountId");
    if (!p.scope) throw new Error("memory.save: missing scope");
    if (!p.content) throw new Error("memory.save: missing content");
    const now = Date.now();
    const memory: Memory = {
      id: randomUUID(),
      accountId: p.accountId,
      scope: p.scope,
      scopeValue: p.scopeValue == null ? null : p.scopeValue.toLowerCase(),
      content: p.content,
      source: p.source ?? "manual",
      sourceEmailId: p.sourceEmailId ?? null,
      enabled: true,
      memoryType: "drafting",
      createdAt: now,
      updatedAt: now,
    };
    dbSaveMemory(memory);
    return memory;
  });

  // memory.update(id, updates)
  registerMethod("memory.update", (params) => {
    const { id, updates } =
      (params as {
        id?: string;
        updates?: {
          content?: string;
          enabled?: boolean;
          scope?: MemoryScope;
          scopeValue?: string | null;
        };
      }) ?? {};
    if (!id) throw new Error("memory.update: missing id");
    const patch = { ...(updates ?? {}) };
    if (patch.scopeValue !== undefined && patch.scopeValue !== null) {
      patch.scopeValue = patch.scopeValue.toLowerCase();
    }
    dbUpdateMemory(id, patch);
    return dbGetMemory(id);
  });

  // memory.delete(id)
  registerMethod("memory.delete", (params) => {
    const { id } = (params as { id?: string }) ?? {};
    if (!id) throw new Error("memory.delete: missing id");
    dbDeleteMemory(id);
    return { id };
  });

  // memory.categories(accountId) — distinct category names for autocomplete
  registerMethod("memory.categories", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("memory.categories: missing accountId");
    return dbMemoryCategories(accountId);
  });

  // memory.classify(content, senderEmail, senderDomain) — Claude Haiku scope picker
  registerMethod("memory.classify", async (params) => {
    const { content, senderEmail, senderDomain } =
      (params as { content?: string; senderEmail?: string; senderDomain?: string }) ?? {};
    if (!content || !senderEmail) {
      throw new Error("memory.classify: requires { content, senderEmail }");
    }
    const domain = senderDomain ?? "";

    // Demo/test mode: skip the LLM call entirely so the renderer gets a
    // deterministic answer without burning quota or needing a key.
    if (process.env.AOS_TEST_MODE === "true" || process.env.AOS_DEMO_MODE === "true") {
      return { scope: "person" as MemoryScope, scopeValue: senderEmail, content };
    }

    const fallback = {
      scope: "person" as MemoryScope,
      scopeValue: senderEmail,
      content,
    };

    try {
      const response = await createMessage(
        {
          // Honors modelConfig.summary (this and thread-summary are the
          // two short JSON-extraction jobs in the sidecar — sharing one
          // setting keeps the user-facing AI Models card lean). Routes
          // through createMessage so claude-* → Anthropic, else OpenRouter.
          model: resolveClassifyModel(),
          max_tokens: 256,
          messages: [
            {
              role: "user",
              content: `Classify this email preference/feedback into a scope for future application.

Feedback: "${content}"
Sender email: ${senderEmail}
Sender domain: ${domain}

Determine:
1. scope: "person" (only this sender), "domain" (everyone at ${domain}), "category" (a type of email), or "global" (all emails)
2. scopeValue: the email (person), domain (domain), category name (category), or null (global)
3. content: rephrase the feedback as a clear, reusable instruction (e.g. "Use formal tone" instead of "make it more formal")

Respond in JSON only: {"scope":"...","scopeValue":"...","content":"..."}`,
            },
          ],
        },
        { caller: "memory.classify" },
      );

      const block = response.content[0];
      const text = block && block.type === "text" ? block.text : "";
      const jsonStr = extractJsonObject(text);
      if (!jsonStr) return fallback;

      const parsed = JSON.parse(jsonStr) as {
        scope?: string;
        scopeValue?: string | null;
        content?: string;
      };

      const scope = VALID_SCOPES.includes(parsed.scope as MemoryScope)
        ? (parsed.scope as MemoryScope)
        : "person";
      const scopeValue =
        scope === "global"
          ? null
          : scope === "domain"
            ? (parsed.scopeValue ?? domain)
            : scope === "category"
              ? (parsed.scopeValue ?? null)
              : (parsed.scopeValue ?? senderEmail);

      return {
        scope,
        scopeValue,
        content: parsed.content || content,
      };
    } catch (err) {
      log.warn("memory.classify failed; returning person-scope fallback", {
        err: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  });

  // ----- draft-memory ops -----

  registerMethod("draftMemory.list", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("draftMemory.list: missing accountId");
    return dbGetDraftMemories(accountId);
  });

  registerMethod("draftMemory.delete", (params) => {
    const { id } = (params as { id?: string }) ?? {};
    if (!id) throw new Error("draftMemory.delete: missing id");
    dbDeleteDraftMemory(id);
    return { id };
  });

  // promote depends on consolidateMemoryScopes (a sizable helper from
  // src/main/services/draft-edit-learner.ts that hasn't been lifted yet).
  // Surface a clear error so the renderer can show a useful message; the
  // Electron path still works for users on the legacy build.
  registerMethod("draftMemory.promote", () => {
    throw new Error("draftMemory.promote: not yet wired in sidecar");
  });
}
