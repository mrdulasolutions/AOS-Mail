// Integration test — thread-summary cache lifecycle when a new message
// lands.
//
// Background: summary.thread caches the LLM-generated summary in the
// `thread_summaries` table keyed on (thread_id, account_id) with a
// latest_message_id watermark. When a new message arrives in the
// thread the latest message id changes; the cache must miss and be
// re-populated. This is the cross-feature flow the post-mortem (#5
// architectural debt) called out as missing — neither the per-method
// cache test nor the per-method sync test catches the ordering bug
// where a stale cache could survive a new message arrival.
//
// Walks the full sequence:
//   1. Seed a thread with 3 messages.
//   2. Seed a cache row pointing at the current tail (mimics what a
//      previous summary.thread call would have written). With SKIP_LLM=1
//      we cannot make a real cache via the LLM path, so we seed-prime
//      the table — same pattern the existing summary.test.ts uses.
//   3. summary.thread → expect cached: true (cache row matches tail).
//   4. Add a 4th message to the thread (a new arrival).
//   5. summary.thread → expect cached: false (busted by tail-id change).
//      Under SKIP_LLM, the LLM call rejects after bypass — we assert the
//      error came from the LLM layer, not from the cache-hit short
//      circuit. This proves the cache invalidation logic without
//      depending on Claude.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSidecar, type Harness } from "../_helpers/sidecar-process.js";
import { seedAccount, seedEmail, seedThreadSummary } from "../_helpers/seed.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const __sidecarRequire = createRequire(resolve(__dir, "..", "..", "..", "sidecar", "package.json"));
const Database = __sidecarRequire("better-sqlite3") as typeof import("better-sqlite3");

interface SummaryResult {
  summary: string;
  actionItems: string[];
  decisions: string[];
  cached: boolean;
  createdAt?: number;
}

interface ThreadSummaryRow {
  thread_id: string;
  account_id: string;
  latest_message_id: string;
  summary_text: string;
  action_items: string;
  decisions: string;
  created_at: number;
}

function readSummaryRow(
  harness: Harness,
  threadId: string,
  accountId: string,
): ThreadSummaryRow | null {
  const db = new Database(harness.dbPath);
  try {
    const row = db
      .prepare(
        `SELECT thread_id, account_id, latest_message_id, summary_text,
                action_items, decisions, created_at
         FROM thread_summaries
         WHERE thread_id = ? AND account_id = ?`,
      )
      .get(threadId, accountId) as ThreadSummaryRow | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

describe("thread-summary cache lifecycle: hit → bust → re-attempt on new message", () => {
  let h: Harness;
  let accountId: string;

  before(async () => {
    h = await spawnSidecar();
    accountId = seedAccount(h, { email: "summarizer@example.com", provider: "imap" });

    // Seed a 3-message thread (oldest → newest by date).
    seedEmail(h, {
      id: `imap:${accountId}:INBOX:101`,
      accountId,
      threadId: "thread-cache-bust",
      from: "alice@external.com",
      to: "summarizer@example.com",
      subject: "Project plan",
      body: "Here's the initial draft of the plan.",
      date: "2025-03-01T09:00:00Z",
    });
    seedEmail(h, {
      id: `imap:${accountId}:INBOX:102`,
      accountId,
      threadId: "thread-cache-bust",
      from: "summarizer@example.com",
      to: "alice@external.com",
      subject: "Re: Project plan",
      body: "Thanks. A few questions inline.",
      date: "2025-03-02T10:00:00Z",
    });
    seedEmail(h, {
      id: `imap:${accountId}:INBOX:103`,
      accountId,
      threadId: "thread-cache-bust",
      from: "alice@external.com",
      to: "summarizer@example.com",
      subject: "Re: Project plan",
      body: "Good points — answers below.",
      date: "2025-03-03T11:00:00Z",
    });
  });

  after(async () => {
    await h.close();
  });

  it("seeded cache row keyed at current tail → summary.thread returns cached: true", async () => {
    // Pre-populate the cache pointing at the current tail (id 103).
    seedThreadSummary(h, {
      threadId: "thread-cache-bust",
      accountId,
      latestMessageId: `imap:${accountId}:INBOX:103`,
      summaryText: "Alice and you traded plan questions.",
      actionItems: ["finalise scope", "send proposal Friday"],
      decisions: ["aim for end-of-quarter delivery"],
      createdAt: 1_700_000_000_000,
    });

    const result = await h.call<SummaryResult>("summary.thread", {
      threadId: "thread-cache-bust",
      accountId,
    });

    assert.equal(result.cached, true, "should hit cache when tail id matches");
    assert.equal(result.summary, "Alice and you traded plan questions.");
    assert.deepEqual(result.actionItems, ["finalise scope", "send proposal Friday"]);
    assert.deepEqual(result.decisions, ["aim for end-of-quarter delivery"]);
    assert.equal(result.createdAt, 1_700_000_000_000);

    // End-state: row hasn't changed. Cache hit must NOT rewrite the
    // existing row.
    const row = readSummaryRow(h, "thread-cache-bust", accountId);
    assert.ok(row, "cache row still present after a hit");
    assert.equal(row.summary_text, "Alice and you traded plan questions.");
    assert.equal(row.created_at, 1_700_000_000_000);
  });

  it("adding a 4th message to the thread changes the latest message id, busting the cache", async () => {
    // Simulate a new arrival in the same thread.
    seedEmail(h, {
      id: `imap:${accountId}:INBOX:104`,
      accountId,
      threadId: "thread-cache-bust",
      from: "summarizer@example.com",
      to: "alice@external.com",
      subject: "Re: Project plan",
      body: "All good — let's lock it in.",
      date: "2025-03-04T08:00:00Z",
    });

    // The handler will first lookup the cache, see latest_message_id
    // mismatch (cache says 103, tail is now 104), bypass the cache, and
    // attempt to call summarizeThread → which under SKIP_LLM has no API
    // key and rejects.
    //
    // The shape of the rejection proves the cache miss: it must come
    // from the LLM layer, NOT from a cache-hit short-circuit. If it
    // returned cached: true that would be the bug we're guarding against.
    await assert.rejects(
      () =>
        h.call("summary.thread", {
          threadId: "thread-cache-bust",
          accountId,
        }),
      (err: Error) => {
        assert.ok(err instanceof Error);
        // Any LLM-layer error is fine — the existence of any throw at
        // this depth means we fell past the cache gate. Validation /
        // empty / single-message branches return non-throwing shapes,
        // so a throw here is dispositive proof of cache bust.
        assert.ok(
          /api[ -_]?key|ANTHROPIC|auth|fetch|network|model|connect|credentials/i.test(err.message),
          `expected LLM-call error after cache bust, got: ${err.message}`,
        );
        return true;
      },
    );

    // End-state: the cache row hasn't been updated yet — the LLM call
    // never completed, so the persistence step never ran. The original
    // row is still in place but now stale (latest_message_id mismatch).
    // This is the desired bookkeeping: a failed re-summarize doesn't
    // wipe the prior cache.
    const row = readSummaryRow(h, "thread-cache-bust", accountId);
    assert.ok(row, "stale cache row should remain after a failed re-summarize");
    assert.equal(
      row.latest_message_id,
      `imap:${accountId}:INBOX:103`,
      "cache row should still point at the stale tail id (we couldn't rewrite it without a real LLM call)",
    );
  });

  it("force: true bypasses even a tail-matching cache and hits the LLM path", async () => {
    // Re-prime the cache to align with the current tail (104) so a
    // non-forced call would hit. Then force=true must bypass.
    seedThreadSummary(h, {
      threadId: "thread-cache-bust",
      accountId,
      latestMessageId: `imap:${accountId}:INBOX:104`,
      summaryText: "Re-aligned to current tail.",
      createdAt: 1_700_000_001_000,
    });

    // Sanity: non-forced call hits.
    const cached = await h.call<SummaryResult>("summary.thread", {
      threadId: "thread-cache-bust",
      accountId,
    });
    assert.equal(cached.cached, true, "fresh cache row should be a hit");

    // force=true must bypass and try the LLM path → rejects under
    // SKIP_LLM.
    await assert.rejects(
      () =>
        h.call("summary.thread", {
          threadId: "thread-cache-bust",
          accountId,
          force: true,
        }),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.ok(
          /api[ -_]?key|ANTHROPIC|auth|fetch|network|model|connect|credentials/i.test(err.message),
          `expected LLM-call error after force bypass, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
