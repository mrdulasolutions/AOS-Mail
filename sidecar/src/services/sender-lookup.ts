// Sender profile lookup — calls Claude with the web_search tool to find a
// brief professional profile for an unknown sender, caches the result in
// `sender_profiles` for 7 days.
//
// Lifted from src/extensions/mail-ext-web-search/src/web-search-provider.ts
// but with three changes for the sidecar shape:
//
//   1. Runs in the sidecar (not the renderer), so the Anthropic call goes
//      through the same `createMessage` recording path as analysis/drafts —
//      every web-search lookup lands in `llm_calls` for cost tracking.
//   2. Cache lives in the existing `sender_profiles` SQLite table instead of
//      the renderer's `extension_storage` keyed namespace. The legacy table
//      already has the right columns (summary, linkedin_url, company,
//      title, lookup_at). 7-day TTL enforced on read.
//   3. Honors `modelConfig.senderLookup` from preferences. Web search is
//      Anthropic-only, so a non-Claude id throws a clear error rather than
//      silently routing to OpenRouter (which doesn't expose web_search).
//
// The companion bundled-extension wrapper (renderer-side) treats this as a
// black-box enrichment for the "sender-profile" panel: enqueue → render.

import { createMessage, isWebSearchCapableModel } from "./anthropic.js";
import { resolveModelFor } from "./model-config.js";
import { getDb } from "../db/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("sender-lookup");

// Cache TTL — 7 days. After expiry we re-fetch (modeled after the
// Electron-era extension-storage cache).
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Detection patterns for automated/no-reply senders. We never run the
// lookup on these — there's no person to look up.
const AUTOMATED_PATTERNS = [
  /noreply/i,
  /no-reply/i,
  /donotreply/i,
  /do-not-reply/i,
  /notifications?@/i,
  /mailer-daemon/i,
  /postmaster/i,
  /\bmailer\b/i,
  /bounces?@/i,
];

export interface SenderProfile {
  email: string;
  name: string | null;
  role: string | null;
  company: string | null;
  summary: string;
  linkedinUrl: string | null;
  sources: Array<{ title: string; url: string }>;
  cachedAt: number;
  isAutomated: boolean;
}

export interface LookupInput {
  email: string;
  name?: string;
  accountId?: string;
}

function isAutomatedAddress(email: string): boolean {
  return AUTOMATED_PATTERNS.some((p) => p.test(email));
}

interface SenderProfileRow {
  email: string;
  name: string | null;
  summary: string;
  linkedin_url: string | null;
  company: string | null;
  title: string | null;
  lookup_at: number;
}

function rowToProfile(row: SenderProfileRow): SenderProfile {
  return {
    email: row.email,
    name: row.name,
    role: row.title,
    company: row.company,
    summary: row.summary,
    linkedinUrl: row.linkedin_url,
    // sources are not persisted in the legacy table — they're shown live
    // on first fetch and dropped from the cache to keep the table narrow.
    sources: [],
    cachedAt: row.lookup_at,
    isAutomated: false,
  };
}

function readCached(email: string): SenderProfile | null {
  const row = getDb()
    .prepare<[string]>(
      `SELECT email, name, summary, linkedin_url, company, title, lookup_at
       FROM sender_profiles WHERE email = ?`,
    )
    .get(email.toLowerCase()) as SenderProfileRow | undefined;
  if (!row) return null;
  return rowToProfile(row);
}

function isFresh(profile: SenderProfile): boolean {
  return Date.now() - profile.cachedAt < CACHE_TTL_MS;
}

function writeCache(profile: SenderProfile): void {
  // INSERT OR REPLACE so a second lookup updates an existing row.
  // We deliberately drop `sources` and `isAutomated` — neither has a
  // column in the legacy table, and round-tripping them adds churn.
  getDb()
    .prepare<[string, string | null, string, string | null, string | null, string | null, number]>(
      `INSERT OR REPLACE INTO sender_profiles
         (email, name, summary, linkedin_url, company, title, lookup_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      profile.email.toLowerCase(),
      profile.name,
      profile.summary,
      profile.linkedinUrl,
      profile.company,
      profile.role,
      profile.cachedAt,
    );
}

/** Strip `<cite index="…">…</cite>` markers Claude inlines around web-search citations. */
function stripCitations(text: string): string {
  return text.replace(/<cite[^>]*>/gi, "").replace(/<\/cite>/gi, "");
}

interface ParsedProfile {
  name?: string;
  role?: string;
  company?: string;
  summary?: string;
  linkedinUrl?: string;
  sources?: Array<{ title: string; url: string }>;
}

/**
 * Parse the model's reply into a profile. Tolerant of:
 *   - raw JSON
 *   - ```json fenced blocks
 *   - JSON embedded somewhere in prose
 *   - plain prose (used as summary)
 */
function parseProfileResponse(raw: string): ParsedProfile {
  const text = stripCitations(raw).trim();

  // 1. Fenced code block — most common for Claude.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    try {
      const obj = JSON.parse(fenced[1].trim()) as Record<string, unknown>;
      return normalizeParsed(obj);
    } catch {
      /* fall through */
    }
  }

  // 2. Bare JSON object somewhere in the text.
  const bare = text.match(/\{[\s\S]*\}/);
  if (bare && bare[0]) {
    try {
      const obj = JSON.parse(bare[0]) as Record<string, unknown>;
      return normalizeParsed(obj);
    } catch {
      /* fall through */
    }
  }

  // 3. Whole-text JSON.
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    return normalizeParsed(obj);
  } catch {
    /* fall through */
  }

  // 4. Plain prose — use as summary if it's short enough to be useful.
  const cleaned = text
    .replace(/[`{}"[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > 0 && cleaned.length < 1000) {
    return { summary: cleaned };
  }
  return {};
}

function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = stripCitations(v).trim();
  return t.length > 0 ? t : undefined;
}

function normalizeParsed(obj: Record<string, unknown>): ParsedProfile {
  const sourcesRaw = obj.sources;
  const sources: Array<{ title: string; url: string }> = [];
  if (Array.isArray(sourcesRaw)) {
    for (const item of sourcesRaw) {
      if (item && typeof item === "object") {
        const r = item as Record<string, unknown>;
        const title = asString(r.title);
        const url = asString(r.url);
        if (title && url) sources.push({ title, url });
      }
    }
  }
  return {
    name: asString(obj.name),
    role: asString(obj.role) ?? asString(obj.title),
    company: asString(obj.company),
    summary: asString(obj.summary),
    linkedinUrl: asString(obj.linkedinUrl) ?? asString(obj.linkedin_url),
    sources,
  };
}

/**
 * Look up a sender profile. Returns the cached entry if it's still fresh
 * (under 7 days old); otherwise calls Claude with the web_search tool and
 * caches the result.
 *
 * For automated/no-reply addresses, returns a stub profile with
 * `isAutomated: true` and no Claude call.
 */
export async function lookupSender(input: LookupInput): Promise<SenderProfile> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("lookupSender: email is required");

  // Short-circuit for obvious no-reply addresses. Surface a stub profile
  // with isAutomated=true so the panel can render "automated sender" UX
  // without paying for a web search.
  if (isAutomatedAddress(email)) {
    return {
      email,
      name: input.name ?? null,
      role: null,
      company: null,
      summary: "Automated sender — no profile lookup performed.",
      linkedinUrl: null,
      sources: [],
      cachedAt: Date.now(),
      isAutomated: true,
    };
  }

  // Cache hit + fresh — return immediately.
  const cached = readCached(email);
  if (cached && isFresh(cached)) {
    log.debug("cache hit", { email });
    return cached;
  }

  // Sender lookup needs Anthropic-only web_search; the resolver itself is
  // provider-agnostic, so this guard lives at the call site (see the
  // resolver's JSDoc). Use the PRICING-keyed whitelist instead of a
  // `claude-` prefix check — the prefix check would reject any future
  // Anthropic rename (or a versioned id like `aos-claude-…`), and PRICING
  // is the canonical list of models we actually support across the app.
  // See post-mortem P3 #23.
  const model = resolveModelFor("senderLookup");
  if (!isWebSearchCapableModel(model)) {
    throw new Error(
      `Sender lookup requires a model with Anthropic web_search support. Configured model: ${model}. Open Settings → AI Models and set sender lookup to a supported Claude model.`,
    );
  }

  const senderName = (input.name ?? "").trim() || email;
  log.info("looking up sender", { email });

  const response = await createMessage(
    {
      model,
      max_tokens: 600,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        },
      ],
      messages: [
        {
          role: "user",
          content: `Find a brief professional profile for the person at email "${email}"${
            senderName !== email ? ` (display name: "${senderName}")` : ""
          }. Search the web for their LinkedIn, company website, or other public sources.

Skip the lookup if the address looks automated or no-reply (do not invent a profile in that case — just say so in the summary).

Respond with ONLY valid JSON, no markdown fences:
{
  "name": "Full name",
  "role": "Job title or role",
  "company": "Company or organization",
  "summary": "2-3 sentence summary of who they are and what they do",
  "linkedinUrl": "LinkedIn profile URL if found",
  "sources": [{ "title": "Source name", "url": "https://..." }]
}

If you can't find anything specific, return:
{
  "name": "${senderName}",
  "summary": "No public information found for this email address."
}`,
        },
      ],
    },
    {
      caller: "sender-lookup",
      accountId: input.accountId,
    },
  );

  // Concatenate every text block (web_search interleaves tool_use with
  // narrative text and a final summary block).
  let raw = "";
  for (const block of response.content) {
    if (block.type === "text") raw += block.text;
  }

  const parsed = parseProfileResponse(raw);
  const profile: SenderProfile = {
    email,
    name: parsed.name ?? (senderName !== email ? senderName : null),
    role: parsed.role ?? null,
    company: parsed.company ?? null,
    summary: parsed.summary ?? "No public information found for this email address.",
    linkedinUrl: parsed.linkedinUrl ?? null,
    sources: parsed.sources ?? [],
    cachedAt: Date.now(),
    isAutomated: false,
  };

  try {
    writeCache(profile);
  } catch (err) {
    log.warn("failed to write profile cache", { email, err: String(err) });
  }
  return profile;
}

/** Read-only cache hit. Returns null if no cache or cache is stale. */
export function getCachedSender(email: string): SenderProfile | null {
  if (!email) return null;
  const profile = readCached(email.trim().toLowerCase());
  if (!profile) return null;
  if (!isFresh(profile)) return null;
  return profile;
}
