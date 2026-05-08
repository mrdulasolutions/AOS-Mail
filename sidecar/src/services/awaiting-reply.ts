// Awaiting-reply detector — finds threads where the user sent the latest
// message and is waiting on a response.
//
// Pure SQL, no LLM. The local `emails` table stores both inbox and sent
// rows since the thread-depth merge; for each thread the LATEST message
// (highest `date`) tells us who spoke last. If that row's labelIds
// include "SENT" AND it's older than the threshold, the thread is a
// nudge candidate.
//
// V1 uses a single global threshold (default 3 days). Per-recipient
// learning is V2 — the call signature already takes a `thresholdDays`
// option so future code can pass per-recipient values without changing
// the surface.
//
// Automated/list mail is filtered out: if the latest sent message went
// to a noreply-style address, there's nobody to nudge. We don't have
// List-Unsubscribe headers in the local schema, so we use the same
// address-pattern check as sender-lookup for the recipient list.

import { getDb } from "../db/index.js";

export interface AwaitingReplyThread {
  threadId: string;
  accountId: string;
  /** ISO date of the most recent SENT message in the thread. */
  lastSentAt: string;
  /** Subject of the latest message (the user's outbound). */
  subject: string;
  /** Cleaned-up recipient addresses extracted from to_address. */
  recipientEmails: string[];
  /** Days elapsed since lastSentAt (floor of integer days). */
  daysSince: number;
}

interface ThreadLatestRow {
  thread_id: string;
  account_id: string;
  subject: string;
  to_address: string;
  date: string;
  label_ids: string | null;
}

// Same automated-address heuristic used in sender-lookup. If the user's
// latest reply went to one of these, there's no human waiting on the
// other end to nudge.
const AUTOMATED_RECIPIENT_PATTERNS = [
  /noreply/i,
  /no-reply/i,
  /donotreply/i,
  /do-not-reply/i,
  /notifications?@/i,
  /mailer-daemon/i,
  /postmaster/i,
  /bounces?@/i,
  /^(?:list|lists)@/i,
];

function isAutomatedRecipient(email: string): boolean {
  return AUTOMATED_RECIPIENT_PATTERNS.some((p) => p.test(email));
}

// Parse a header-style to_address ("First Last <a@b>, c@d") into a flat
// list of bare email addresses. Permissive — the only consumer is the
// renderer's row label and the automated-recipient filter, neither of
// which needs RFC-precise parsing.
const ADDR_RE = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
function parseRecipients(toAddress: string): string[] {
  const matches = toAddress.match(ADDR_RE);
  if (!matches) return [];
  const seen = new Set<string>();
  for (const m of matches) seen.add(m.toLowerCase());
  return [...seen];
}

function hasSentLabel(labelIdsJson: string | null): boolean {
  if (!labelIdsJson) return false;
  try {
    const arr = JSON.parse(labelIdsJson) as unknown;
    if (!Array.isArray(arr)) return false;
    return arr.some((l) => l === "SENT");
  } catch {
    return false;
  }
}

export interface FindAwaitingReplyOpts {
  /** Default 3 days. */
  thresholdDays?: number;
  /** Hard cap to keep the renderer responsive. Default 50. */
  limit?: number;
}

export function findAwaitingReplyThreads(
  accountId: string,
  opts: FindAwaitingReplyOpts = {},
): AwaitingReplyThread[] {
  const thresholdDays = opts.thresholdDays ?? 3;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Cutoff in ms — anything strictly OLDER than now-thresholdDays counts.
  const cutoffMs = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;

  // For each (account, thread) pull the row with the maximum date. SQLite
  // doesn't have a native "argmax"; we use the standard correlated-subquery
  // trick: filter to rows whose date matches the per-thread max. Keeps the
  // query single-pass when the (account, date) index is available.
  const rows = getDb()
    .prepare(
      `SELECT e.thread_id, e.account_id, e.subject, e.to_address, e.date, e.label_ids
       FROM emails e
       WHERE e.account_id = ?
         AND e.date = (
           SELECT MAX(e2.date) FROM emails e2
           WHERE e2.thread_id = e.thread_id AND e2.account_id = e.account_id
         )
       ORDER BY e.date DESC`,
    )
    .all(accountId) as ThreadLatestRow[];

  const out: AwaitingReplyThread[] = [];
  const seenThreadIds = new Set<string>();
  for (const r of rows) {
    // The correlated subquery can return more than one row per thread when
    // two messages share the same exact `date` string. Keep the first one
    // we see (already ordered DESC by date) so the result is deduped.
    if (seenThreadIds.has(r.thread_id)) continue;
    seenThreadIds.add(r.thread_id);

    if (!hasSentLabel(r.label_ids)) continue;

    const lastSentMs = Date.parse(r.date);
    if (Number.isNaN(lastSentMs)) continue;
    if (lastSentMs >= cutoffMs) continue;

    const recipients = parseRecipients(r.to_address ?? "");
    if (recipients.length === 0) continue;
    // Skip threads whose latest send went only to automated addresses —
    // there's no human on the other end. If at least one human recipient
    // is present, surface the thread.
    const hasHumanRecipient = recipients.some((e) => !isAutomatedRecipient(e));
    if (!hasHumanRecipient) continue;

    const daysSince = Math.floor((Date.now() - lastSentMs) / (24 * 60 * 60 * 1000));
    out.push({
      threadId: r.thread_id,
      accountId: r.account_id,
      lastSentAt: r.date,
      subject: r.subject,
      recipientEmails: recipients.filter((e) => !isAutomatedRecipient(e)),
      daysSince,
    });
    if (out.length >= limit) break;
  }
  return out;
}
