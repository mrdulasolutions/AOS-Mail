// `sender` IPC namespace — sender profile / enrichment cache lookup.
//
// Two methods:
//   - `sender.getProfile` / `sender.getCached` — read-only cache hit, returns
//      null when the cache is empty or stale (>7 days). Same surface area as
//      the legacy Electron handler.
//   - `sender.lookup` — actual web-search-backed lookup. Forces a refresh if
//      the cache is stale. Used by the sender-profile bundled extension.
//
// The lookup itself lives in services/sender-lookup.ts so the extensions
// dispatcher (extensions.getEnrichment) can call it directly without
// re-routing through RPC.

import { registerMethod } from "../rpc.js";
import {
  lookupSender as lookupSenderService,
  getCachedSender,
  type SenderProfile,
} from "../services/sender-lookup.js";
import { getDb } from "../db/index.js";

export interface SenderProfileLegacy {
  email: string;
  name: string | null;
  summary: string;
  linkedinUrl: string | null;
  company: string | null;
  title: string | null;
  lookupAt: number;
}

/** Map the new SenderProfile shape onto the legacy {title, lookupAt} surface. */
function toLegacyShape(profile: SenderProfile): SenderProfileLegacy {
  return {
    email: profile.email,
    name: profile.name,
    summary: profile.summary,
    linkedinUrl: profile.linkedinUrl,
    company: profile.company,
    title: profile.role,
    lookupAt: profile.cachedAt,
  };
}

export function registerSenderMethods(): void {
  registerMethod("sender.getProfile", (params) => {
    const { email } = (params as { email?: string }) ?? {};
    if (!email) throw new Error("sender.getProfile: requires { email }");
    const profile = getCachedSender(email);
    return profile ? toLegacyShape(profile) : null;
  });

  // No-fetch cache lookup. Returns the new SenderProfile shape directly.
  // Used by the extension bundle to render an instant cache hit before the
  // background lookup finishes.
  registerMethod("sender.getCached", (params) => {
    const { email } = (params as { email?: string }) ?? {};
    if (!email) throw new Error("sender.getCached: requires { email }");
    return getCachedSender(email);
  });

  // Web-search-backed lookup. Returns the cached profile if fresh,
  // otherwise calls Claude with the web_search tool and caches the result.
  registerMethod("sender.lookup", async (params) => {
    const { email, name, accountId } =
      (params as {
        email?: string;
        name?: string;
        accountId?: string;
      }) ?? {};
    if (!email) throw new Error("sender.lookup: requires { email }");
    return await lookupSenderService({ email, name, accountId });
  });

  // Record user feedback on a sender-profile result. Two effects:
  //   1. 'wrong' / 'partial' ratings invalidate the cached profile so the
  //      next open re-fetches (don't show a known-bad bio twice).
  //   2. Every entry lands in `sender_feedback` for prompt iteration —
  //      we use the bad examples as a few-shot training set when we
  //      revise sender-lookup's prompt.
  registerMethod("sender.recordFeedback", (params) => {
    const { email, rating, notes, accountId, emailId } =
      (params as {
        email?: string;
        rating?: "useful" | "wrong" | "partial";
        notes?: string;
        accountId?: string;
        emailId?: string;
      }) ?? {};
    if (!email) throw new Error("sender.recordFeedback: requires { email }");
    if (rating !== "useful" && rating !== "wrong" && rating !== "partial") {
      throw new Error("sender.recordFeedback: rating must be 'useful' | 'wrong' | 'partial'");
    }
    const db = getDb();
    db.prepare(
      `INSERT INTO sender_feedback (sender_email, rating, notes, account_id, email_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(email, rating, notes ?? null, accountId ?? null, emailId ?? null, Date.now());
    // Invalidate the cached profile on negative feedback so the next
    // load re-fetches with a fresh web search instead of re-serving the
    // same bad bio.
    if (rating === "wrong" || rating === "partial") {
      db.prepare("DELETE FROM sender_profiles WHERE email = ?").run(email);
    }
    return { ok: true };
  });

  // Read-only: get the most recent feedback for an email so the panel can
  // show the user's prior rating + skip showing the prompt again.
  registerMethod("sender.getFeedback", (params) => {
    const { email } = (params as { email?: string }) ?? {};
    if (!email) throw new Error("sender.getFeedback: requires { email }");
    const row = getDb()
      .prepare(
        `SELECT rating, notes, created_at
         FROM sender_feedback
         WHERE sender_email = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(email) as
      | { rating: "useful" | "wrong" | "partial"; notes: string | null; created_at: number }
      | undefined;
    return row ? { rating: row.rating, notes: row.notes, createdAt: row.created_at } : null;
  });
}
