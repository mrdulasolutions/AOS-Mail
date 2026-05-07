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

import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { openImapClient } from "./imap.js";

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
 * messages (returns only uids > sinceUid).
 */
export async function listImapMessageHeaders(
  accountId: string,
  folder: string = "INBOX",
  opts: { limit?: number; sinceUid?: number } = {},
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
      // UID range that captures the newest messages first.
      const lowerBound = opts.sinceUid
        ? Math.max(opts.sinceUid + 1, Math.max(1, highestUid - limit + 1))
        : Math.max(1, highestUid - limit + 1);
      const range = `${lowerBound}:${highestUid}`;

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
