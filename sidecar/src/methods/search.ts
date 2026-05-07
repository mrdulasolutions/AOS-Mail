// `search` + `contacts` IPC namespaces — local FTS5 search and contact
// autocomplete. All pure DB queries; no service, no events.
//
// Lifted verbatim (with light editing) from src/main/db/index.ts:
//   - stripHtmlForSearch (kept exported for prompts elsewhere later)
//   - sanitizeFtsQuery
//   - parseAddresses
//   - searchEmails (FTS5 with LIKE fallback)
//   - getSearchSuggestions
//   - rebuildSearchIndex
//   - getContactSuggestions
//
// Demo-mode fakery (the Electron handlers had hardcoded fake data when
// AOS_DEMO_MODE/AOS_TEST_MODE were set) is intentionally omitted — the
// sidecar serves real DB results in all modes; the renderer can decide
// to skip calls in demo mode if it wants.

import { registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("search");

export interface SearchOptions {
  accountId?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  id: string;
  threadId: string;
  accountId: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  date: string;
  snippet: string;
  rank: number;
}

export interface ContactSuggestion {
  email: string;
  name: string;
  frequency: number;
}

// ── HTML stripping + FTS5 query sanitization ──

export function stripHtmlForSearch(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[#\w]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFtsQuery(query: string): string {
  if (query.startsWith('"') && query.endsWith('"')) return query;
  const ftsOperators = new Set(["AND", "OR", "NOT", "NEAR"]);
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (ftsOperators.has(token.toUpperCase())) return token.toUpperCase();
      if (/^(subject|body_text|from_address|to_address):/.test(token)) return token;
      if (/[*"():^{}+\-]/.test(token)) {
        return `"${token.replace(/"/g, '""')}"`;
      }
      return token;
    })
    .join(" ");
}

// ── Address parsing ──

function parseAddresses(str: string): Array<{ name: string; email: string }> {
  if (!str) return [];
  const results: Array<{ name: string; email: string }> = [];

  const parts: string[] = [];
  let current = "";
  let inAngle = false;
  for (const ch of str) {
    if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inAngle) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    const trimmed = part.trim();
    const match = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
    if (match) {
      const name = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
      results.push({ name, email: (match[2] ?? "").trim() });
    } else if (trimmed.includes("@")) {
      results.push({ name: "", email: trimmed });
    }
  }
  return results;
}

// ── Search emails (FTS5 + LIKE fallback) ──

function searchEmails(query: string, options: SearchOptions = {}): SearchResult[] {
  const db = getDb();
  const { accountId, limit = 50, offset = 0 } = options;

  let ftsQuery = query;
  const additionalFilters: string[] = [];

  const fromMatch = query.match(/from:([^\s]+)/i);
  if (fromMatch) {
    additionalFilters.push(`from_address:${fromMatch[1]}`);
    ftsQuery = ftsQuery.replace(fromMatch[0], "").trim();
  }
  const toMatch = query.match(/to:([^\s]+)/i);
  if (toMatch) {
    additionalFilters.push(`to_address:${toMatch[1]}`);
    ftsQuery = ftsQuery.replace(toMatch[0], "").trim();
  }
  const subjectMatch = query.match(/subject:([^\s]+)/i);
  if (subjectMatch) {
    additionalFilters.push(`subject:${subjectMatch[1]}`);
    ftsQuery = ftsQuery.replace(subjectMatch[0], "").trim();
  }

  if (ftsQuery) ftsQuery = sanitizeFtsQuery(ftsQuery);

  const finalQuery = [...additionalFilters, ftsQuery].filter(Boolean).join(" ");
  if (!finalQuery) return [];

  let rows: Array<Record<string, unknown>> = [];
  try {
    let sql = `
      SELECT
        e.id, e.thread_id as threadId, e.account_id as accountId,
        e.subject, e.from_address as "from", e.to_address as "to",
        e.cc_address as "cc", e.bcc_address as "bcc",
        e.date, e.snippet, rank
      FROM emails_fts
      JOIN emails e ON emails_fts.rowid = e.rowid
      WHERE emails_fts MATCH ?
    `;
    const params: (string | number)[] = [finalQuery];
    if (accountId) {
      sql += " AND e.account_id = ?";
      params.push(accountId);
    }
    sql += " ORDER BY rank, e.date DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);
    rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } catch (err) {
    log.error("FTS5 search error, falling back to LIKE", { err: String(err) });
  }

  if (rows.length === 0) {
    try {
      const likePattern = `%${query}%`;
      let sql = `
        SELECT
          e.id, e.thread_id as threadId, e.account_id as accountId,
          e.subject, e.from_address as "from", e.to_address as "to",
          e.cc_address as "cc", e.bcc_address as "bcc",
          e.date, e.snippet, 0 as rank
        FROM emails e
        WHERE (
          e.subject LIKE ? COLLATE NOCASE
          OR e.body_text LIKE ? COLLATE NOCASE
          OR e.from_address LIKE ? COLLATE NOCASE
          OR e.to_address LIKE ? COLLATE NOCASE
        )
      `;
      const params: (string | number)[] = [
        likePattern,
        likePattern,
        likePattern,
        likePattern,
      ];
      if (accountId) {
        sql += " AND e.account_id = ?";
        params.push(accountId);
      }
      sql += " ORDER BY e.date DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);
      rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    } catch (err) {
      log.error("LIKE fallback search error", { err: String(err) });
      return [];
    }
  }

  return rows.map((row) => ({
    id: row.id as string,
    threadId: row.threadId as string,
    accountId: row.accountId as string,
    subject: row.subject as string,
    from: row.from as string,
    to: row.to as string,
    cc: row.cc as string | undefined,
    bcc: row.bcc as string | undefined,
    date: row.date as string,
    snippet: (row.snippet as string) || "",
    rank: row.rank as number,
  }));
}

function getSearchSuggestions(query: string, limit = 10): string[] {
  const db = getDb();
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT from_address as address
         FROM emails WHERE from_address LIKE ?
         ORDER BY date DESC LIMIT ?`,
      )
      .all(`%${query}%`, limit) as Array<{ address: string }>;
    return rows.map((r) => r.address);
  } catch (err) {
    log.error("search suggestions error", { err: String(err) });
    return [];
  }
}

function rebuildSearchIndex(): void {
  const db = getDb();
  log.info("rebuilding FTS5 emails_fts");
  try {
    db.exec("DELETE FROM emails_fts");
    db.exec(`
      INSERT INTO emails_fts(rowid, subject, body_text, from_address, to_address)
      SELECT rowid, subject, COALESCE(body_text, body), from_address, to_address FROM emails
    `);
    db.exec("INSERT INTO emails_fts(emails_fts) VALUES('optimize')");
    log.info("FTS5 emails_fts rebuilt");
  } catch (err) {
    log.error("rebuild failed", { err: String(err) });
    throw err;
  }
}

function getContactSuggestions(query: string, limit = 10): ContactSuggestion[] {
  const db = getDb();
  const likePattern = `%${query}%`;
  const contacts = new Map<string, { name: string; email: string; frequency: number }>();

  try {
    const fromRows = db
      .prepare(
        `SELECT from_address AS address, COUNT(*) AS freq
         FROM emails WHERE from_address LIKE ? COLLATE NOCASE
         GROUP BY from_address COLLATE NOCASE ORDER BY freq DESC LIMIT ?`,
      )
      .all(likePattern, limit * 3) as Array<{ address: string; freq: number }>;

    for (const row of fromRows) {
      for (const addr of parseAddresses(row.address)) {
        const key = addr.email.toLowerCase();
        const existing = contacts.get(key);
        if (existing) {
          existing.frequency += row.freq;
          if (addr.name && !existing.name) existing.name = addr.name;
        } else {
          contacts.set(key, { name: addr.name, email: addr.email, frequency: row.freq });
        }
      }
    }

    const toRows = db
      .prepare(
        `SELECT to_address AS address, COUNT(*) AS freq
         FROM emails WHERE to_address LIKE ? COLLATE NOCASE
         GROUP BY to_address COLLATE NOCASE ORDER BY freq DESC LIMIT ?`,
      )
      .all(likePattern, limit * 3) as Array<{ address: string; freq: number }>;

    const queryLower = query.toLowerCase();
    for (const row of toRows) {
      for (const addr of parseAddresses(row.address)) {
        if (
          !addr.name.toLowerCase().includes(queryLower) &&
          !addr.email.toLowerCase().includes(queryLower)
        ) {
          continue;
        }
        const key = addr.email.toLowerCase();
        const existing = contacts.get(key);
        if (existing) {
          existing.frequency += row.freq;
          if (addr.name && !existing.name) existing.name = addr.name;
        } else {
          contacts.set(key, { name: addr.name, email: addr.email, frequency: row.freq });
        }
      }
    }

    const profileRows = db
      .prepare(
        `SELECT email, name, company
         FROM sender_profiles
         WHERE email LIKE ? COLLATE NOCASE
            OR name LIKE ? COLLATE NOCASE
            OR company LIKE ? COLLATE NOCASE
         LIMIT ?`,
      )
      .all(likePattern, likePattern, likePattern, limit * 2) as Array<{
      email: string;
      name: string | null;
      company: string | null;
    }>;
    for (const row of profileRows) {
      const key = row.email.toLowerCase();
      const existing = contacts.get(key);
      if (existing) {
        if (row.name && !existing.name) existing.name = row.name;
      } else {
        contacts.set(key, { name: row.name || "", email: row.email, frequency: 0 });
      }
    }
  } catch (err) {
    log.error("contact suggestions error", { err: String(err) });
    return [];
  }

  return [...contacts.values()].sort((a, b) => b.frequency - a.frequency).slice(0, limit);
}

// ── RPC registration ──

export function registerSearchMethods(): void {
  registerMethod("search.query", (params) => {
    const { query, options } = (params as { query?: string; options?: SearchOptions }) ?? {};
    if (typeof query !== "string") throw new Error("search.query: requires { query }");
    return searchEmails(query, options ?? {});
  });

  registerMethod("search.suggestions", (params) => {
    const { query, limit } = (params as { query?: string; limit?: number }) ?? {};
    if (typeof query !== "string") throw new Error("search.suggestions: requires { query }");
    return getSearchSuggestions(query, limit);
  });

  registerMethod("search.rebuildIndex", () => {
    rebuildSearchIndex();
    return { ok: true };
  });

  registerMethod("contacts.suggest", (params) => {
    const { query, limit } = (params as { query?: string; limit?: number }) ?? {};
    if (typeof query !== "string") throw new Error("contacts.suggest: requires { query }");
    return getContactSuggestions(query, limit);
  });
}
