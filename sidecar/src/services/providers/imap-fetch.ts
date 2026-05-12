// IMAP message-fetch helpers built on top of openImapClient().
//
// Two operations the sync layer needs:
//   - listMessageHeaders(accountId, folder, opts)  — recent headers in a folder
//   - getMessageFull(accountId, folder, uid)        — full RFC 822 source for one uid
//
// V1 fetches at most ~50 messages per call to keep the inbox snappy and
// out of the imapflow's "huge fetch" path. Pagination by UID descending.
//
// Headers map directly to the emails-table shape the renderer reads.

import { type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { openImapClient } from "./imap.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("imap-fetch");

export interface ImapMessageHeader {
  /** Stable id we use as emails.id — `imap:<accountId>:<folder>:<uid>`. */
  id: string;
  uid: number;
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
  messageId: string | null;
  inReplyTo: string | null;
}

export interface ImapMessageFull extends ImapMessageHeader {
  body: string; // raw RFC 822 source as a UTF-8 string (best-effort)
  bodyText: string | null; // optional plaintext extraction
}

function formatAddressList(
  addrs: Array<{ name?: string; address?: string }> | undefined,
): string {
  if (!addrs || addrs.length === 0) return "";
  return addrs
    .map((a) => {
      const addr = a.address ?? "";
      const name = (a.name ?? "").trim();
      if (name && addr) return `${name} <${addr}>`;
      return addr;
    })
    .filter(Boolean)
    .join(", ");
}

function shortSnippet(text: string | undefined | null, len = 200): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, len);
}

function makeId(accountId: string, folder: string, uid: number): string {
  return `imap:${accountId}:${folder}:${uid}`;
}

/**
 * List the most recent message envelopes in a folder.
 *
 * Default: last 50 in INBOX, newest first. The IMAP server's UID sequence
 * is naturally chronological-ish; we fetch a window starting from the
 * highest known UID. `sinceUid` lets the sync layer poll for newer
 * messages (returns only uids > sinceUid). `beforeUid` walks backwards
 * for "Load more" — returns up to `limit` messages with uid < beforeUid.
 */
export async function listImapMessageHeaders(
  accountId: string,
  folder: string = "INBOX",
  opts: { limit?: number; sinceUid?: number; beforeUid?: number } = {},
): Promise<{ headers: ImapMessageHeader[]; highestUid: number; folder: string }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const client = await openImapClient(accountId);
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const mailbox = client.mailbox;
      if (!mailbox || typeof mailbox === "boolean") {
        return { headers: [], highestUid: 0, folder };
      }
      const uidNext = (mailbox.uidNext ?? 1) as number;
      const highestUid = Math.max(0, uidNext - 1);
      if (highestUid === 0) {
        return { headers: [], highestUid: 0, folder };
      }
      // UID range that captures the requested window.
      // - beforeUid: we want uids strictly less than beforeUid, capped at `limit`.
      //   Used by "Load more" to walk older messages.
      // - sinceUid: we want uids strictly greater than sinceUid, capped at `limit`.
      //   Used by polling to grab newly-arrived messages.
      // - default: newest-first window (highestUid - limit + 1 .. highestUid).
      let lowerBound: number;
      let upperBound: number;
      if (typeof opts.beforeUid === "number" && opts.beforeUid > 1) {
        upperBound = opts.beforeUid - 1;
        lowerBound = Math.max(1, upperBound - limit + 1);
        if (upperBound < 1) {
          return { headers: [], highestUid, folder };
        }
      } else {
        upperBound = highestUid;
        lowerBound = opts.sinceUid
          ? Math.max(opts.sinceUid + 1, Math.max(1, highestUid - limit + 1))
          : Math.max(1, highestUid - limit + 1);
      }
      const range = `${lowerBound}:${upperBound}`;

      const headers: ImapMessageHeader[] = [];
      for await (const msg of client.fetch(
        range,
        { envelope: true, flags: true, uid: true, internalDate: true, threadId: true },
        { uid: true },
      ) as AsyncIterable<FetchMessageObject>) {
        const env = msg.envelope;
        if (!env) continue;
        const uid = msg.uid;
        const flags = msg.flags as Set<string> | undefined;
        const isUnread = !flags?.has("\\Seen");
        const isStarred = !!flags?.has("\\Flagged");
        const dateIso =
          env.date instanceof Date
            ? env.date.toISOString()
            : msg.internalDate instanceof Date
              ? msg.internalDate.toISOString()
              : new Date().toISOString();
        const threadId =
          (msg as unknown as { threadId?: string }).threadId ??
          env.inReplyTo ??
          env.messageId ??
          String(uid);
        headers.push({
          id: makeId(accountId, folder, uid),
          uid,
          threadId,
          subject: env.subject ?? "(no subject)",
          from: formatAddressList(env.from),
          to: formatAddressList(env.to),
          cc: formatAddressList(env.cc) || null,
          bcc: formatAddressList(env.bcc) || null,
          date: dateIso,
          snippet: shortSnippet(env.subject ?? "", 100),
          isUnread,
          isStarred,
          messageId: env.messageId ?? null,
          inReplyTo: env.inReplyTo ?? null,
        });
      }
      // Newest first.
      headers.sort((a, b) => b.uid - a.uid);
      return { headers, highestUid, folder };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      /* best-effort */
    });
  }
}

/**
 * Server-side mailbox search for IMAP accounts.
 *
 * Gmail-style query syntax (`from:foo subject:bar`) doesn't translate to
 * IMAP — the protocol's native SEARCH command takes structured criteria
 * (FROM/SUBJECT/BODY/TEXT), not a free-form `q:` blob. This helper does
 * a substring search across SUBJECT, FROM, and BODY using imapflow's
 * `client.search`, then fetches envelope-only headers for the matching
 * UIDs (newest first, capped at `limit`).
 *
 * Limitations vs. Gmail's `q:`:
 *   - No `from:foo` operator — the entire query is treated as a substring
 *     and matched against subject/from/body via SUBJECT/FROM/BODY.
 *   - No date operators (`after:` / `before:`).
 *   - No label / folder operators (`in:inbox`, `label:work`).
 *
 * Pagination: the IMAP SEARCH command returns the full set of matching
 * UIDs in a single round-trip. We cap the returned headers at
 * `limit + offset` and slice — true cursor pagination would require
 * tracking a UID watermark; for V1 the simple offset is enough since
 * search results are small.
 *
 * Folder defaults to INBOX. IMAP doesn't have an "all-mail" view; the
 * caller can pass another folder if they want to scope differently.
 */
export async function searchImapMessages(
  accountId: string,
  opts: { query: string; folder?: string; limit?: number; offset?: number },
): Promise<{ headers: ImapMessageHeader[]; total: number; folder: string }> {
  const folder = opts.folder ?? "INBOX";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const client = await openImapClient(accountId);
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const q = opts.query.trim();
      if (!q) return { headers: [], total: 0, folder };

      // imapflow.search accepts a SearchObject. To get OR semantics
      // across SUBJECT/FROM/BODY we use the `or` operator: any one of
      // the three substring matches is enough.
      const searchResult = await client.search(
        {
          or: [{ subject: q }, { from: q }, { body: q }],
        },
        { uid: true },
      );
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];
      if (uids.length === 0) return { headers: [], total: 0, folder };

      // Newest first — IMAP SEARCH usually returns ascending UID order,
      // we want descending so latest results show first.
      uids.sort((a, b) => b - a);
      const total = uids.length;
      const slice = uids.slice(offset, offset + limit);
      if (slice.length === 0) return { headers: [], total, folder };

      // Build a comma-separated UID list for the FETCH (imapflow accepts
      // a sequence string with multiple UIDs). Order from the slice is
      // preserved by sorting headers afterwards.
      const range = slice.join(",");
      const headers: ImapMessageHeader[] = [];
      for await (const msg of client.fetch(
        range,
        { envelope: true, flags: true, uid: true, internalDate: true, threadId: true },
        { uid: true },
      ) as AsyncIterable<FetchMessageObject>) {
        const env = msg.envelope;
        if (!env) continue;
        const uid = msg.uid;
        const flags = msg.flags as Set<string> | undefined;
        const isUnread = !flags?.has("\\Seen");
        const isStarred = !!flags?.has("\\Flagged");
        const dateIso =
          env.date instanceof Date
            ? env.date.toISOString()
            : msg.internalDate instanceof Date
              ? msg.internalDate.toISOString()
              : new Date().toISOString();
        const threadId =
          (msg as unknown as { threadId?: string }).threadId ??
          env.inReplyTo ??
          env.messageId ??
          String(uid);
        headers.push({
          id: makeId(accountId, folder, uid),
          uid,
          threadId,
          subject: env.subject ?? "(no subject)",
          from: formatAddressList(env.from),
          to: formatAddressList(env.to),
          cc: formatAddressList(env.cc) || null,
          bcc: formatAddressList(env.bcc) || null,
          date: dateIso,
          snippet: shortSnippet(env.subject ?? "", 100),
          isUnread,
          isStarred,
          messageId: env.messageId ?? null,
          inReplyTo: env.inReplyTo ?? null,
        });
      }
      // Newest first — keep parity with the slice ordering.
      headers.sort((a, b) => b.uid - a.uid);
      return { headers, total, folder };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      /* best-effort */
    });
  }
}

/**
 * Discover the SENT folder for an IMAP account.
 *
 * IMAP servers don't agree on what to call the sent folder: Gmail's
 * IMAP exposes "[Gmail]/Sent Mail", Dovecot defaults to "Sent", Cyrus
 * uses "INBOX.Sent", and some servers go with "Sent Mail" or "Sent
 * Items". RFC 6154 added a SPECIAL-USE attribute (`\Sent`) that
 * standardizes discovery, so we prefer that. Fall back to the common
 * names so older servers that don't advertise SPECIAL-USE still work.
 *
 * Returns null if no SENT folder can be found — caller should treat
 * that as "this server has no SENT to sync from".
 */
export async function discoverSentFolder(
  accountId: string,
): Promise<string | null> {
  const client = await openImapClient(accountId);
  try {
    const list = await client.list();
    // Prefer the special-use mailbox if the server advertises it.
    const bySpecial = list.find((box) => box.specialUse === "\\Sent");
    if (bySpecial) return bySpecial.path;
    // Fall back to common names. Match against the path (full hierarchy)
    // because the leaf name "Sent" can collide with subfolders. Keep the
    // exact prefix match conservative — we want "Sent" not "Sent/2024".
    const candidates = ["Sent", "Sent Mail", "Sent Items", "[Gmail]/Sent Mail", "INBOX.Sent"];
    for (const name of candidates) {
      const hit = list.find((box) => box.path === name || box.name === name);
      if (hit) return hit.path;
    }
    log.info("no SENT folder found for account", { accountId });
    return null;
  } finally {
    await client.logout().catch(() => {
      /* best-effort */
    });
  }
}

/**
 * List the most recent message envelopes in this account's SENT folder.
 *
 * Same shape as listImapMessageHeaders (and re-uses it after discovery
 * resolves the folder name) so the sync orchestrator can treat both
 * folders uniformly. Returns headers=[] if discovery returns null —
 * callers shouldn't have to special-case "no sent folder", and an
 * empty result is the correct semantic.
 */
export async function listImapSentHeaders(
  accountId: string,
  opts: { limit?: number; sinceUid?: number } = {},
): Promise<{ headers: ImapMessageHeader[]; highestUid: number; folder: string }> {
  const folder = await discoverSentFolder(accountId);
  if (!folder) {
    return { headers: [], highestUid: 0, folder: "" };
  }
  return listImapMessageHeaders(accountId, folder, opts);
}

/**
 * Fetch the full RFC 822 source for one message — used when the renderer
 * opens a thread and needs the body.
 */
export async function getImapMessageFull(
  accountId: string,
  folder: string,
  uid: number,
): Promise<ImapMessageFull | null> {
  const client = await openImapClient(accountId);
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = (await client.fetchOne(
        String(uid),
        { source: true, envelope: true, flags: true, uid: true, internalDate: true },
        { uid: true },
      )) as FetchMessageObject | null;
      if (!msg || !msg.envelope) return null;
      const env = msg.envelope;
      const flags = msg.flags as Set<string> | undefined;
      const isUnread = !flags?.has("\\Seen");
      const isStarred = !!flags?.has("\\Flagged");
      const source = msg.source instanceof Buffer ? msg.source : Buffer.alloc(0);
      const dateIso =
        env.date instanceof Date
          ? env.date.toISOString()
          : msg.internalDate instanceof Date
            ? msg.internalDate.toISOString()
            : new Date().toISOString();

      // Parse the RFC 822 source so the renderer gets a real HTML / text
      // body instead of raw mail-headers + base64 mime parts.
      // simpleParser handles MIME multipart, transfer-encoding, charset
      // conversion, inline images (we ignore for V1), attachments, etc.
      let bodyHtml = "";
      let bodyText: string | null = null;
      try {
        const parsed = await simpleParser(source);
        bodyHtml =
          (parsed.html as string | false) ||
          (parsed.textAsHtml ? String(parsed.textAsHtml) : "") ||
          "";
        bodyText = parsed.text ? parsed.text : null;
      } catch {
        // Fall through with empty body — better than crashing the open.
      }

      return {
        id: makeId(accountId, folder, uid),
        uid,
        threadId: env.inReplyTo ?? env.messageId ?? String(uid),
        subject: env.subject ?? "(no subject)",
        from: formatAddressList(env.from),
        to: formatAddressList(env.to),
        cc: formatAddressList(env.cc) || null,
        bcc: formatAddressList(env.bcc) || null,
        date: dateIso,
        snippet: shortSnippet(bodyText ?? env.subject ?? "", 200),
        isUnread,
        isStarred,
        messageId: env.messageId ?? null,
        inReplyTo: env.inReplyTo ?? null,
        body: bodyHtml,
        bodyText,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      /* best-effort */
    });
  }
}
