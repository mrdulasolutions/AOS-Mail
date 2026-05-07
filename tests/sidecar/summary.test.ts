// summary.* RPC tests — focuses on the cache-hit/miss/invalidation logic
// in summary.thread, *without* exercising the LLM call path.
//
// We pre-seed thread_summaries with a fake row, then verify:
//   1. cache hit  → returns { cached: true } when latest_message_id matches
//   2. cache miss → returns { cached: false } when latest_message_id changes
//      (we add a third email to the same thread, which moves the latest id;
//      the actual summarizeThread() call will then fail because we're
//      gated by SKIP_LLM, but we only assert that the cache-hit path was
//      bypassed).
//   3. single-message threads return an empty placeholder (no LLM call).

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";
import { seedAccount, seedEmail, seedThreadSummary } from "./_helpers/seed.js";

interface SummaryResult {
  summary: string;
  actionItems: string[];
  decisions: string[];
  cached: boolean;
  createdAt?: number;
}

describe("summary.thread argument validation", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("throws when threadId or accountId is missing", async () => {
    await assert.rejects(
      () => h.call("summary.thread", {}),
      /requires \{ threadId, accountId \}/,
    );
    await assert.rejects(
      () => h.call("summary.thread", { threadId: "t1" }),
      /requires \{ threadId, accountId \}/,
    );
    await assert.rejects(
      () => h.call("summary.thread", { accountId: "a1" }),
      /requires \{ threadId, accountId \}/,
    );
  });
});

describe("summary.thread empty / single-message threads", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("returns placeholder for an empty thread (no messages)", async () => {
    const result = await h.call<SummaryResult>("summary.thread", {
      threadId: "missing-thread",
      accountId: "missing-account",
    });
    assert.deepEqual(result, {
      summary: "",
      actionItems: [],
      decisions: [],
      cached: false,
    });
  });

  it("returns placeholder for a single-message thread (no LLM call)", async () => {
    // The renderer hides the section when length === 1, but the contract
    // still returns the same empty shape. This is testable without LLM.
    const accountId = seedAccount(h, { email: "single@example.com", provider: "imap" });
    seedEmail(h, {
      id: `imap:${accountId}:INBOX:1`,
      accountId,
      threadId: "thread-single",
      body: "lone message",
    });

    const result = await h.call<SummaryResult>("summary.thread", {
      threadId: "thread-single",
      accountId,
    });
    assert.deepEqual(result, {
      summary: "",
      actionItems: [],
      decisions: [],
      cached: false,
    });
  });
});

describe("summary.thread cache hit path", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("returns the cached summary when latest_message_id matches the thread tail", async () => {
    const accountId = seedAccount(h, { email: "cached@example.com", provider: "imap" });
    const id1 = seedEmail(h, {
      id: `imap:${accountId}:INBOX:1`,
      accountId,
      threadId: "thread-cached",
      from: "boss@example.com",
      to: "cached@example.com",
      body: "first",
      date: "2025-01-01T10:00:00Z",
    });
    const id2 = seedEmail(h, {
      id: `imap:${accountId}:INBOX:2`,
      accountId,
      threadId: "thread-cached",
      from: "cached@example.com",
      to: "boss@example.com",
      body: "reply",
      date: "2025-01-01T11:00:00Z",
    });
    // The current "tail" (last by date ASC) is id2. Seed a cache pointing
    // at it.
    seedThreadSummary(h, {
      threadId: "thread-cached",
      accountId,
      latestMessageId: id2,
      summaryText: "Boss asked, you replied.",
      actionItems: ["follow up next week"],
      decisions: ["yes, ship it"],
      createdAt: 1700000000000,
    });

    const result = await h.call<SummaryResult>("summary.thread", {
      threadId: "thread-cached",
      accountId,
    });
    assert.equal(result.cached, true);
    assert.equal(result.summary, "Boss asked, you replied.");
    assert.deepEqual(result.actionItems, ["follow up next week"]);
    assert.deepEqual(result.decisions, ["yes, ship it"]);
    assert.equal(result.createdAt, 1700000000000);
    // Suppress unused warnings — id1/id2 are referenced via the cache row
    // but we don't need to assert on them again.
    void id1;
  });

  it("ignores the cache when force: true is passed", async () => {
    // With force=true the handler skips the cache lookup and proceeds to
    // call summarizeThread. With SKIP_LLM=1 there's no API key, so the
    // call should throw — that's the proof that the cache was bypassed.
    const accountId = seedAccount(h, { email: "forced@example.com", provider: "imap" });
    const id1 = seedEmail(h, {
      id: `imap:${accountId}:INBOX:1`,
      accountId,
      threadId: "thread-forced",
      body: "first",
      date: "2025-01-01T10:00:00Z",
    });
    const id2 = seedEmail(h, {
      id: `imap:${accountId}:INBOX:2`,
      accountId,
      threadId: "thread-forced",
      body: "reply",
      date: "2025-01-01T11:00:00Z",
    });
    seedThreadSummary(h, {
      threadId: "thread-forced",
      accountId,
      latestMessageId: id2,
      summaryText: "should be skipped",
    });

    await assert.rejects(
      () =>
        h.call("summary.thread", {
          threadId: "thread-forced",
          accountId,
          force: true,
        }),
      (err: Error) => {
        // Either the API key is missing (sidecar default) or the LLM
        // call fails — both prove we bypassed the cache.
        assert.ok(
          /api[ -_]?key|ANTHROPIC|auth|fetch|network/i.test(err.message),
          `expected LLM-call error after cache bypass, got: ${err.message}`,
        );
        return true;
      },
    );
    void id1;
  });
});

describe("summary.thread cache invalidation when tail changes", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("falls through to LLM call when latest_message_id no longer matches the thread tail", async () => {
    const accountId = seedAccount(h, { email: "stale@example.com", provider: "imap" });
    const id1 = seedEmail(h, {
      id: `imap:${accountId}:INBOX:1`,
      accountId,
      threadId: "thread-stale",
      body: "first",
      date: "2025-01-01T10:00:00Z",
    });
    const id2 = seedEmail(h, {
      id: `imap:${accountId}:INBOX:2`,
      accountId,
      threadId: "thread-stale",
      body: "second",
      date: "2025-01-01T11:00:00Z",
    });
    // Cache points at id2 (the tail at insert time).
    seedThreadSummary(h, {
      threadId: "thread-stale",
      accountId,
      latestMessageId: id2,
      summaryText: "stale summary",
    });

    // Now add a third message — id3 becomes the new tail. The cache row
    // still references id2 so the cache check fails and we fall through
    // to the LLM call. With SKIP_LLM/no-API-key, that throws.
    const id3 = seedEmail(h, {
      id: `imap:${accountId}:INBOX:3`,
      accountId,
      threadId: "thread-stale",
      body: "third — invalidates cache",
      date: "2025-01-01T12:00:00Z",
    });
    void id1;
    void id3;

    await assert.rejects(
      () =>
        h.call("summary.thread", {
          threadId: "thread-stale",
          accountId,
        }),
      (err: Error) => {
        // Same proof as the force path: invalidated cache → LLM call →
        // no API key in test env → throws.
        assert.ok(
          /api[ -_]?key|ANTHROPIC|auth|fetch|network/i.test(err.message),
          `expected LLM-call error after cache invalidation, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
