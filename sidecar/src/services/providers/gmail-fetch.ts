// Gmail-API message fetch helpers — the parallel of imap-fetch.ts.
//
// Three operations the sync layer needs:
//   - listGmailMessages         — IDs of recent inbox messages
//   - getGmailHeader / Headers  — envelope-only fetch (one or batch)
//   - getGmailMessageFull       — full body for one message
//   - getGmailHistoryChanges    — incremental sync via History API
//
// All return the same shapes as the IMAP equivalents so the upsert layer
// in sync.ts doesn't care which provider produced the row.
//
// The Gmail message id we expose is `gmail:<accountId>:<gmailMessageId>`
// — same scheme the IMAP path uses (`imap:<accountId>:<folder>:<uid>`)
// so renderer code that dispatches on a `:` prefix keeps working.

import { google, type gmail_v1, type Auth } from "googleapis";
import { authedClientForAccount } from "../oauth-gmail.js";

function gmailFor(accountId: string): {
  gmail: gmail_v1.Gmail;
  auth: Auth.OAuth2Client;
} {
  const auth = authedClientForAccount(accountId);
  return { gmail: google.gmail({ version: "v1", auth }), auth };
}

export interface GmailMessageHeader {
  /** Stable id we use as emails.id — `gmail:<accountId>:<gmailId>`. */
  id: string;
  gmailId: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string | null;
  bcc: string | null;
  date: string; // ISO
  snippet: string;
  isUnread: boolean;
  isStarred: boolean;
  /** RFC 5322 Message-ID header (not the Gmail message id). */
  messageId: string | null;
  inReplyTo: string | null;
  /** Gmail labels — INBOX / SENT / STARRED / UNREAD / etc. */
  labelIds: string[];
}

export interface GmailMessageFull extends GmailMessageHeader {
  /** HTML body when present, else plain text rendered as-is. */
  body: string;
  /** Plain-text body if available (used for snippets / agent context). */
  bodyText: string | null;
}

export function makeGmailEmailId(accountId: string, gmailId: string): string {
  return `gmail:${accountId}:${gmailId}`;
}

/** Reverse of makeGmailEmailId — returns null on a non-Gmail id. */
export function parseGmailEmailId(emailId: string): {
  accountId: string;
  gmailId: string;
} | null {
  const m = /^gmail:([^:]+):(.+)$/.exec(emailId);
  if (!m) return null;
  return { accountId: m[1]!, gmailId: m[2]! };
}

/**
 * Compare two Gmail historyIds numerically.
 *
 * Gmail historyIds are integer-valued but transmitted as decimal strings
 * (the API explicitly says they may exceed 2^53, so we can't `Number()`
 * them safely). The watermark logic in getGmailHistoryChanges used to
 * compare them with the `>` operator on strings, which gives lexicographic
 * order — `"99" > "100"` is `true`, which means `latest = max(...)` would
 * sometimes regress past a power-of-ten boundary and we'd persist a
 * SMALLER watermark. The next incremental sync would re-fetch the same
 * history range or, worse, fail to advance past the boundary at all.
 *
 * Using BigInt covers Gmail's full historyId range without precision
 * loss. Returns -1, 0, or 1 in the standard comparator shape so callers
 * can reuse it for sorting if needed. An empty/undefined operand sorts
 * before any defined id — used by the watermark code where the initial
 * `latest` may be falsy.
 */
export function compareHistoryIds(a: string | null | undefined, b: string | null | undefined): number {
  const av = a ? BigInt(a) : 0n;
  const bv = b ? BigInt(b) : 0n;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

/**
 * Decode Gmail's url-safe base64 body.data into a UTF-8 string. Gmail uses
 * the variant without padding so we restore it before decoding.
 */
function decodeBase64Url(data: string | undefined | null): string {
  if (!data) return "";
  let std = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4;
  if (pad) std += "=".repeat(4 - pad);
  return Buffer.from(std, "base64").toString("utf-8");
}

/**
 * Walk the MIME tree and collect the first text/html (preferred) and first
 * text/plain part. Multipart/alternative messages have both; we keep them
 * separate so the renderer can show HTML and the agent gets plaintext for
 * cheaper context.
 */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): {
  html: string;
  text: string;
} {
  if (!payload) return { html: "", text: "" };
  let html = "";
  let text = "";
  function walk(part: gmail_v1.Schema$MessagePart): void {
    if (part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (part.mimeType === "text/html" && !html) html = decoded;
      else if (part.mimeType === "text/plain" && !text) text = decoded;
    }
    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }
  walk(payload);
  return { html, text };
}

function parseDate(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  internalDate: string | null | undefined,
): string {
  const dateHeader = getHeader(headers, "date");
  if (dateHeader) {
    const d = new Date(dateHeader);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  if (internalDate) {
    const ms = parseInt(internalDate, 10);
    if (!isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

function snippetOf(s: string, max = 200): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function messageToHeader(
  accountId: string,
  m: gmail_v1.Schema$Message,
): GmailMessageHeader | null {
  if (!m.id) return null;
  const headers = m.payload?.headers;
  const labels = m.labelIds || [];
  const cc = getHeader(headers, "cc");
  const bcc = getHeader(headers, "bcc");
  return {
    id: makeGmailEmailId(accountId, m.id),
    gmailId: m.id,
    threadId: m.threadId || m.id,
    subject: getHeader(headers, "subject") || "(no subject)",
    from: getHeader(headers, "from"),
    to: getHeader(headers, "to"),
    cc: cc || null,
    bcc: bcc || null,
    date: parseDate(headers, m.internalDate),
    snippet: m.snippet || "",
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
    messageId: getHeader(headers, "message-id") || null,
    inReplyTo: getHeader(headers, "in-reply-to") || null,
    labelIds: labels,
  };
}

/**
 * List inbox messages newest-first. Default 50 — same window the IMAP
 * path uses, so the renderer's existing pagination assumption (one screen-
 * full at a time) keeps working. Returns the user's current historyId so
 * the next sync can run incrementally.
 */
export async function listGmailMessages(
  accountId: string,
  opts: {
    maxResults?: number;
    labelIds?: string[];
    q?: string;
    pageToken?: string;
  } = {},
): Promise<{
  messageIds: Array<{ id: string; threadId: string }>;
  historyId: string | null;
  nextPageToken: string | null;
}> {
  const { gmail } = gmailFor(accountId);
  const max = Math.min(Math.max(opts.maxResults ?? 50, 1), 500);

  const profile = await gmail.users.getProfile({ userId: "me" });
  const historyId = profile.data.historyId || null;

  const response = await gmail.users.messages.list({
    userId: "me",
    maxResults: max,
    labelIds: opts.labelIds || ["INBOX"],
    q: opts.q,
    pageToken: opts.pageToken,
  });

  const messages = (response.data.messages || []).map((m) => ({
    id: m.id || "",
    threadId: m.threadId || "",
  }));
  return {
    messageIds: messages.filter((m) => m.id),
    historyId,
    nextPageToken: response.data.nextPageToken || null,
  };
}

/**
 * Server-side mailbox search via Gmail's `users.messages.list` with a
 * `q:` parameter. Gmail's query syntax (`from:foo subject:bar` etc.) is
 * passed through verbatim so users can search exactly the same way they
 * do on web Gmail.
 *
 * Skips the historyId profile roundtrip that listGmailMessages does —
 * search doesn't need a watermark — and surfaces Gmail's
 * resultSizeEstimate so the UI can show a "X results" count without
 * paginating the entire result set.
 */
export async function searchGmailMessages(
  accountId: string,
  opts: { query: string; maxResults?: number; pageToken?: string },
): Promise<{
  messageIds: Array<{ id: string; threadId: string }>;
  nextPageToken: string | null;
  resultSizeEstimate: number;
}> {
  const { gmail } = gmailFor(accountId);
  const max = Math.min(Math.max(opts.maxResults ?? 50, 1), 500);

  const response = await gmail.users.messages.list({
    userId: "me",
    maxResults: max,
    q: opts.query,
    pageToken: opts.pageToken,
    // No labelIds filter — search across all mail (the user can scope
    // via Gmail's query syntax, e.g. `in:inbox` if they want).
  });

  const messages = (response.data.messages || []).map((m) => ({
    id: m.id || "",
    threadId: m.threadId || "",
  }));
  return {
    messageIds: messages.filter((m) => m.id),
    nextPageToken: response.data.nextPageToken || null,
    resultSizeEstimate: response.data.resultSizeEstimate ?? 0,
  };
}

/** Fetch one message in 'metadata' format — envelope without body. */
export async function getGmailHeader(
  accountId: string,
  gmailId: string,
): Promise<GmailMessageHeader | null> {
  const { gmail } = gmailFor(accountId);
  const response = await gmail.users.messages.get({
    userId: "me",
    id: gmailId,
    format: "metadata",
    metadataHeaders: [
      "Subject",
      "From",
      "To",
      "Cc",
      "Bcc",
      "Date",
      "Message-ID",
      "In-Reply-To",
    ],
  });
  return messageToHeader(accountId, response.data);
}

/** Batch-fetch envelopes with concurrency cap (avoid Gmail's 250 QPS limit). */
export async function getGmailHeaders(
  accountId: string,
  gmailIds: string[],
  concurrency: number = 8,
): Promise<GmailMessageHeader[]> {
  const out: GmailMessageHeader[] = [];
  for (let i = 0; i < gmailIds.length; i += concurrency) {
    const chunk = gmailIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      chunk.map((id) => getGmailHeader(accountId, id)),
    );
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
    }
  }
  return out;
}

/** Fetch full message including body. Used by sync.fetchBody. */
export async function getGmailMessageFull(
  accountId: string,
  gmailId: string,
): Promise<GmailMessageFull | null> {
  const { gmail } = gmailFor(accountId);
  const response = await gmail.users.messages.get({
    userId: "me",
    id: gmailId,
    format: "full",
  });
  const header = messageToHeader(accountId, response.data);
  if (!header) return null;
  const { html, text } = extractBody(response.data.payload);
  const body = html || text || "";
  return {
    ...header,
    body,
    bodyText: text || null,
    snippet: header.snippet || snippetOf(text || ""),
  };
}

/**
 * Incremental sync via Gmail's History API. Returns lists of message ids
 * partitioned by what changed since `startHistoryId`:
 *   - newIds      : messageAdded events on INBOX / SENT
 *   - removedIds  : messageDeleted, plus INBOX label removals (archive)
 *   - readIds     : UNREAD label removed
 *   - unreadIds   : UNREAD label added
 *
 * Throws Error("HISTORY_EXPIRED") on a 404 — Gmail expires history records
 * after about a week of inactivity. Caller should fall back to a full
 * inbox refetch and persist the fresh historyId.
 */
export async function getGmailHistoryChanges(
  accountId: string,
  startHistoryId: string,
): Promise<{
  newIds: string[];
  removedIds: string[];
  readIds: string[];
  unreadIds: string[];
  historyId: string;
}> {
  const { gmail } = gmailFor(accountId);
  const newSet = new Set<string>();
  const removedSet = new Set<string>();
  const readSet = new Set<string>();
  const unreadSet = new Set<string>();
  let latest = startHistoryId;

  async function fetchLabel(labelId: string): Promise<void> {
    let pageToken: string | undefined;
    do {
      const response = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: [
          "messageAdded",
          "messageDeleted",
          "labelAdded",
          "labelRemoved",
        ],
        labelId,
        pageToken,
      });
      const history = response.data.history || [];
      for (const item of history) {
        for (const ma of item.messagesAdded || []) {
          if (
            ma.message?.id &&
            ma.message?.labelIds?.includes(labelId)
          ) {
            newSet.add(ma.message.id);
          }
        }
        for (const md of item.messagesDeleted || []) {
          if (md.message?.id) removedSet.add(md.message.id);
        }
        for (const lr of item.labelsRemoved || []) {
          const id = lr.message?.id;
          if (!id) continue;
          // INBOX removal == archived from this client's perspective.
          if (lr.labelIds?.includes("INBOX")) removedSet.add(id);
          if (lr.labelIds?.includes("UNREAD")) readSet.add(id);
        }
        for (const la of item.labelsAdded || []) {
          const id = la.message?.id;
          if (!id) continue;
          if (la.labelIds?.includes("UNREAD")) unreadSet.add(id);
          // SENT label added == draft was sent; treat as a new message so
          // the sender gets the row in their Sent view.
          if (la.labelIds?.includes("SENT")) newSet.add(id);
        }
      }
      const respHist = response.data.historyId || latest;
      // BigInt-aware comparison: see compareHistoryIds. String `>`
      // would do lexicographic compare and regress past 10^N boundaries.
      if (compareHistoryIds(respHist, latest) > 0) latest = respHist;
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
  }

  try {
    await Promise.all([fetchLabel("INBOX"), fetchLabel("SENT")]);
    // A message that was added then deleted in the same window shouldn't
    // appear in both lists — the deletion wins.
    const newIds = [...newSet].filter((id) => !removedSet.has(id));
    return {
      newIds,
      removedIds: [...removedSet],
      readIds: [...readSet].filter(
        (id) => !newSet.has(id) && !removedSet.has(id),
      ),
      unreadIds: [...unreadSet].filter(
        (id) => !newSet.has(id) && !removedSet.has(id),
      ),
      historyId: latest,
    };
  } catch (err: unknown) {
    const e = err as { code?: number; status?: number };
    if (e.code === 404 || e.status === 404) {
      throw new Error("HISTORY_EXPIRED");
    }
    throw err;
  }
}
