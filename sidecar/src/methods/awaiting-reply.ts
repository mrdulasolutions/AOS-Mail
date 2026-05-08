// `awaitingReply` IPC namespace — surfaces threads where the user sent
// the latest message and is still waiting on a reply, plus a one-call
// nudge drafter that reuses the regular draft-generator with a
// composeMode flip.
//
// Methods:
//   awaitingReply.list({ accountId, thresholdDays? })   — pure SQL detector
//                                                          capped at 50 rows.
//   awaitingReply.draftNudge({ threadId, accountId })   — Claude call: looks
//                                                          up the latest SENT
//                                                          message in the
//                                                          thread and writes a
//                                                          short follow-up.

import { registerMethod } from "../rpc.js";
import { findAwaitingReplyThreads, type AwaitingReplyThread } from "../services/awaiting-reply.js";
import { generateDraft } from "../services/draft-generator.js";
import { getDb } from "../db/index.js";

interface LatestSentRow {
  id: string;
  account_id: string;
  from_address: string;
  to_address: string;
  subject: string;
  date: string;
  body: string;
  label_ids: string | null;
}

/**
 * Pull the most recent SENT message in a thread for the given account.
 * The detector already proved one exists; we re-query here to fetch the
 * full body the drafter needs.
 */
function getLatestSentInThread(threadId: string, accountId: string): LatestSentRow | null {
  // We can't ORDER BY on a JSON column predicate cleanly, so filter via
  // the same LIKE trick used elsewhere in the sidecar (sync.ts), then
  // pick the row with the maximum `date`.
  const rows = getDb()
    .prepare(
      `SELECT id, account_id, from_address, to_address, subject, date, body, label_ids
       FROM emails
       WHERE thread_id = ?
         AND account_id = ?
         AND label_ids LIKE '%"SENT"%'
       ORDER BY date DESC
       LIMIT 1`,
    )
    .all(threadId, accountId) as LatestSentRow[];
  return rows[0] ?? null;
}

export function registerAwaitingReplyMethods(): void {
  registerMethod("awaitingReply.list", (params) => {
    const { accountId, thresholdDays } =
      (params as { accountId?: string; thresholdDays?: number }) ?? {};
    if (!accountId) {
      throw new Error("awaitingReply.list: requires { accountId }");
    }
    const rows: AwaitingReplyThread[] = findAwaitingReplyThreads(accountId, {
      thresholdDays,
      limit: 50,
    });
    return rows;
  });

  registerMethod("awaitingReply.draftNudge", async (params) => {
    const { threadId, accountId } = (params as { threadId?: string; accountId?: string }) ?? {};
    if (!threadId || !accountId) {
      throw new Error("awaitingReply.draftNudge: requires { threadId, accountId }");
    }
    const sent = getLatestSentInThread(threadId, accountId);
    if (!sent) {
      throw new Error(`awaitingReply.draftNudge: no SENT message found in thread ${threadId}`);
    }
    const body = await generateDraft({
      // The drafter persists nothing on its own — it just returns text.
      // We pass the SENT message's id so usage logs attribute the call
      // to a real email row.
      emailId: sent.id,
      accountId: sent.account_id,
      email: {
        from: sent.from_address,
        to: sent.to_address,
        subject: sent.subject,
        date: sent.date,
        body: sent.body || sent.subject,
      },
      composeMode: "nudge",
    });
    return { body };
  });
}
