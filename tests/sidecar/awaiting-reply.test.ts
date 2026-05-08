// awaitingReply.* RPC tests — covers the pure-SQL detector and the
// draftNudge routing surface. The LLM call itself is gated behind the
// SKIP_LLM convention used by the rest of this suite (no API key in
// test env → the call fails with a recognizable error), so we assert
// shape and routing rather than the generated body.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";
import { seedAccount, seedEmail } from "./_helpers/seed.js";

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

describe("awaitingReply.list argument validation", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("throws when accountId is missing", async () => {
    await assert.rejects(() => h.call("awaitingReply.list", {}), /requires \{ accountId \}/);
  });
});

describe("awaitingReply.list — detector behavior", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("surfaces a thread whose latest message is the user's SENT 4 days ago", async () => {
    const accountId = seedAccount(h, { email: "user@example.com" });
    // Inbound message arrived 5 days ago; user replied 4 days ago and
    // hasn't heard back since. The detector should pick this up.
    seedEmail(h, {
      id: `t1:msg-in`,
      accountId,
      threadId: "t1",
      from: "alice@example.com",
      to: "user@example.com",
      subject: "Quick favor",
      date: isoDaysAgo(5),
      labelIds: ["INBOX"],
    });
    seedEmail(h, {
      id: `t1:msg-out`,
      accountId,
      threadId: "t1",
      from: "user@example.com",
      to: "alice@example.com",
      subject: "Re: Quick favor",
      date: isoDaysAgo(4),
      labelIds: ["SENT"],
    });

    const rows = await h.call<AwaitingReplyRow[]>("awaitingReply.list", {
      accountId,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.threadId, "t1");
    assert.equal(rows[0]?.accountId, accountId);
    assert.deepEqual(rows[0]?.recipientEmails, ["alice@example.com"]);
    assert.ok((rows[0]?.daysSince ?? 0) >= 3, "daysSince should reflect the 4-day delta");
  });

  it("does not surface threads whose latest message is inbound", async () => {
    const accountId = seedAccount(h, { email: "user2@example.com" });
    // User sent 10 days ago, then a reply came back yesterday — thread
    // is no longer awaiting a reply (the user is on the hook again).
    seedEmail(h, {
      id: `t2:out`,
      accountId,
      threadId: "t2",
      from: "user2@example.com",
      to: "bob@example.com",
      subject: "Question",
      date: isoDaysAgo(10),
      labelIds: ["SENT"],
    });
    seedEmail(h, {
      id: `t2:in`,
      accountId,
      threadId: "t2",
      from: "bob@example.com",
      to: "user2@example.com",
      subject: "Re: Question",
      date: isoDaysAgo(1),
      labelIds: ["INBOX"],
    });

    const rows = await h.call<AwaitingReplyRow[]>("awaitingReply.list", {
      accountId,
    });
    assert.equal(rows.length, 0);
  });

  it("does not surface SENT threads younger than the threshold", async () => {
    const accountId = seedAccount(h, { email: "user3@example.com" });
    // SENT yesterday — under the default 3-day window.
    seedEmail(h, {
      id: `t3:out`,
      accountId,
      threadId: "t3",
      from: "user3@example.com",
      to: "carol@example.com",
      date: isoDaysAgo(1),
      labelIds: ["SENT"],
    });

    const rows = await h.call<AwaitingReplyRow[]>("awaitingReply.list", {
      accountId,
    });
    assert.equal(rows.length, 0);
  });

  it("respects an override thresholdDays", async () => {
    const accountId = seedAccount(h, { email: "user4@example.com" });
    // SENT 2 days ago — under default 3-day, over a 1-day override.
    seedEmail(h, {
      id: `t4:out`,
      accountId,
      threadId: "t4",
      from: "user4@example.com",
      to: "dave@example.com",
      date: isoDaysAgo(2),
      labelIds: ["SENT"],
    });

    const defaultRows = await h.call<AwaitingReplyRow[]>("awaitingReply.list", {
      accountId,
    });
    assert.equal(defaultRows.length, 0, "default threshold should hide the row");

    const overrideRows = await h.call<AwaitingReplyRow[]>("awaitingReply.list", {
      accountId,
      thresholdDays: 1,
    });
    assert.equal(overrideRows.length, 1, "1-day threshold should surface the row");
  });

  it("filters threads whose only recipient is automated (noreply)", async () => {
    const accountId = seedAccount(h, { email: "user5@example.com" });
    seedEmail(h, {
      id: `t5:out`,
      accountId,
      threadId: "t5",
      from: "user5@example.com",
      to: "noreply@service.com",
      date: isoDaysAgo(5),
      labelIds: ["SENT"],
    });

    const rows = await h.call<AwaitingReplyRow[]>("awaitingReply.list", {
      accountId,
    });
    assert.equal(rows.length, 0);
  });
});

describe("awaitingReply.draftNudge", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("throws when threadId or accountId is missing", async () => {
    await assert.rejects(
      () => h.call("awaitingReply.draftNudge", {}),
      /requires \{ threadId, accountId \}/,
    );
    await assert.rejects(
      () => h.call("awaitingReply.draftNudge", { threadId: "t" }),
      /requires \{ threadId, accountId \}/,
    );
  });

  it("throws when no SENT message exists in the thread", async () => {
    const accountId = seedAccount(h, { email: "lonely@example.com" });
    seedEmail(h, {
      id: `tlonely:in`,
      accountId,
      threadId: "tlonely",
      labelIds: ["INBOX"],
    });

    await assert.rejects(
      () =>
        h.call("awaitingReply.draftNudge", {
          threadId: "tlonely",
          accountId,
        }),
      /no SENT message found/,
    );
  });

  it("routes to the drafter when a SENT message is present (LLM call fails without API key)", async () => {
    // With SKIP_LLM=1 (no API key configured), the draft-generator's
    // LLM call rejects. We assert that we *got* to that point — i.e.
    // the method routed correctly past the validation + DB lookup.
    const accountId = seedAccount(h, { email: "router@example.com" });
    seedEmail(h, {
      id: `trouter:out`,
      accountId,
      threadId: "trouter",
      from: "router@example.com",
      to: "external@example.com",
      subject: "Following up",
      body: "Hey, can we sync?",
      date: isoDaysAgo(5),
      labelIds: ["SENT"],
    });

    await assert.rejects(
      () =>
        h.call("awaitingReply.draftNudge", {
          threadId: "trouter",
          accountId,
        }),
      // Any failure from the LLM path is acceptable — what matters is
      // that we got past validation + the SENT lookup. A "no API key"
      // / "401" / "anthropic" / "fetch" -class error proves the route.
      // We accept any throw at this depth; the validation-error tests
      // above prove the early returns work.
      (err: Error) => {
        assert.ok(err instanceof Error);
        // The throw must come from the LLM layer, not validation or
        // the SENT-lookup. Both early-return paths are tested above.
        assert.ok(
          !/requires \{|no SENT message found/.test(err.message),
          `expected post-routing error, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
