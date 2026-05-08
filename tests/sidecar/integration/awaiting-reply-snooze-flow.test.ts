// Integration test — awaiting-reply ⇄ snooze interaction.
//
// Background: when the user has sent a message and is waiting for a
// reply, the awaiting-reply rail surfaces it. Snoozing the thread should
// suppress the rail entry until the snooze expires. This is exactly the
// kind of cross-feature flow the post-mortem (#5 architectural debt)
// said the suite was missing — both tables ride on the emails+thread_id
// keys, and a regression in either's predicate would surface only when
// the two are exercised together.
//
// Walks the full sequence:
//   1. Seed 2 sent-4-days-ago threads.
//   2. Snooze one of them for 7 days via the public snooze.snooze RPC.
//   3. awaitingReply.list → expects ONLY the unsnoozed thread.
//   4. Manually back-date snooze_until into the past (mock-clock-style)
//      via a direct DB write — same pattern the existing
//      awaiting-reply.test.ts uses for the stale-snooze case.
//   5. Re-list → expects BOTH threads, proving the snooze filter
//      correctly excludes only-active snoozes.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSidecar, type Harness } from "../_helpers/sidecar-process.js";
import { seedAccount, seedEmail } from "../_helpers/seed.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const __sidecarRequire = createRequire(resolve(__dir, "..", "..", "..", "sidecar", "package.json"));
const Database = __sidecarRequire("better-sqlite3") as typeof import("better-sqlite3");

interface AwaitingReplyRow {
  threadId: string;
  accountId: string;
  lastSentAt: string;
  subject: string;
  recipientEmails: string[];
  daysSince: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

// Mutate snooze_until directly so we can simulate "time has passed" without
// waiting 7 days. snooze.snooze rejects past timestamps via the public API,
// so this is the only way to set up the expired-snooze case.
function backdateSnoozeUntil(harness: Harness, threadId: string, accountId: string): void {
  const conn = new Database(harness.dbPath);
  try {
    const past = Date.now() - DAY_MS; // 1 day in the past
    const result = conn
      .prepare(
        `UPDATE snoozed_emails SET snooze_until = ?
         WHERE thread_id = ? AND account_id = ?`,
      )
      .run(past, threadId, accountId);
    if (result.changes === 0) {
      throw new Error(`backdateSnoozeUntil: no row for thread=${threadId} account=${accountId}`);
    }
  } finally {
    conn.close();
  }
}

describe("awaiting-reply ⇄ snooze interaction", () => {
  let h: Harness;
  let accountId: string;

  before(async () => {
    h = await spawnSidecar();
    accountId = seedAccount(h, { email: "user@example.com", provider: "gmail" });

    // Seed thread #1: user sent 4 days ago, no reply.
    seedEmail(h, {
      id: "t-active:in",
      accountId,
      threadId: "t-active",
      from: "alice@external.com",
      to: "user@example.com",
      subject: "Question about pricing",
      date: isoDaysAgo(5),
      labelIds: ["INBOX"],
    });
    seedEmail(h, {
      id: "t-active:out",
      accountId,
      threadId: "t-active",
      from: "user@example.com",
      to: "alice@external.com",
      subject: "Re: Question about pricing",
      date: isoDaysAgo(4),
      labelIds: ["SENT"],
    });

    // Seed thread #2: user sent 4 days ago, no reply (this is the one
    // we'll snooze).
    seedEmail(h, {
      id: "t-snoozed:in",
      accountId,
      threadId: "t-snoozed",
      from: "bob@external.com",
      to: "user@example.com",
      subject: "Following up on contract",
      date: isoDaysAgo(5),
      labelIds: ["INBOX"],
    });
    seedEmail(h, {
      id: "t-snoozed:out",
      accountId,
      threadId: "t-snoozed",
      from: "user@example.com",
      to: "bob@external.com",
      subject: "Re: Following up on contract",
      date: isoDaysAgo(4),
      labelIds: ["SENT"],
    });
  });

  after(async () => {
    await h.close();
  });

  it("baseline — both threads appear in awaitingReply.list before any snooze", async () => {
    const rows = await h.call<AwaitingReplyRow[]>("awaitingReply.list", { accountId });
    const threadIds = rows.map((r) => r.threadId).sort();
    assert.deepEqual(
      threadIds,
      ["t-active", "t-snoozed"],
      "both seeded threads should be awaiting reply before snoozing",
    );
  });

  it("snoozing one thread for 7 days hides ONLY that thread from the list", async () => {
    const sevenDaysFromNow = Date.now() + 7 * DAY_MS;
    await h.call("snooze.snooze", {
      emailId: "t-snoozed:out",
      threadId: "t-snoozed",
      accountId,
      snoozeUntil: sevenDaysFromNow,
    });

    const rows = await h.call<AwaitingReplyRow[]>("awaitingReply.list", { accountId });
    assert.equal(rows.length, 1, "only the unsnoozed thread should remain");
    assert.equal(rows[0]?.threadId, "t-active");
    // Recipients of the user's sent message — sanity-check the row
    // mapper is still painting the right shape in the cross-flow case.
    assert.deepEqual(rows[0]?.recipientEmails, ["alice@external.com"]);
  });

  it("snooze.list reflects the active snooze (cross-check the storage angle)", async () => {
    const result = (await h.call("snooze.list", { accountId })) as {
      data: Array<{ threadId: string; accountId: string; snoozeUntil: number }>;
      expired: unknown[];
    };
    assert.equal(result.expired.length, 0, "no expired snoozes yet");
    assert.equal(result.data.length, 1, "one active snooze in storage");
    assert.equal(result.data[0]?.threadId, "t-snoozed");
    assert.ok(result.data[0]!.snoozeUntil > Date.now(), "snoozeUntil is in the future");
  });

  it("after the snooze expires (back-dated), the thread reappears in the list", async () => {
    // Mock-clock alternative: rather than waiting 7 days, push the
    // existing row's snooze_until into the past via a direct DB write.
    backdateSnoozeUntil(h, "t-snoozed", accountId);

    // Note: snooze.list has a side effect — it sweeps and DELETES expired
    // snoozes for the requested account. We deliberately call
    // awaitingReply.list FIRST so we can prove the awaitingReply
    // detector itself filters by `snooze_until > now` (not by the
    // sweeper having already removed the row).
    const rows = await h.call<AwaitingReplyRow[]>("awaitingReply.list", { accountId });
    const threadIds = rows.map((r) => r.threadId).sort();
    assert.deepEqual(
      threadIds,
      ["t-active", "t-snoozed"],
      "expired snooze should NOT silence the thread; both rows return",
    );
  });

  it("snooze.list call after expiry sweeps the expired rows and returns them as `expired`", async () => {
    // Now that we asserted awaitingReply correctly handled the expired
    // case, exercise snooze.list which performs the side-effecting
    // cleanup and emits the expired set to the renderer.
    const result = (await h.call("snooze.list", { accountId })) as {
      data: Array<{ threadId: string }>;
      expired: Array<{ threadId: string }>;
    };
    assert.equal(result.expired.length, 1, "one expired snooze should be reported");
    assert.equal(result.expired[0]?.threadId, "t-snoozed");
    assert.equal(result.data.length, 0, "expired sweep clears the active list");
  });
});
