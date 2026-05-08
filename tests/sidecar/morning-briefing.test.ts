// Morning briefing + permissions tray tests.
//
// Coverage:
//   1. briefing.getOrGenerate generates a row, second call returns cache.
//   2. briefing.dismiss flips dismissed_at; the row stays in list().
//   3. briefing.list returns recent days newest-first.
//   4. permissions.list aggregates pending drafts + archive_ready entries.
//
// We avoid burning Claude calls in the test by seeding the daily_briefings
// row directly for the cache-hit path. The full LLM path requires
// ANTHROPIC_API_KEY which the SKIP_LLM=1 runner explicitly excludes — we
// don't try to exercise it here. The cache-hit path is the user-visible
// invariant: opening the app on the same day twice should NEVER burn a
// second Claude call.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";
import { seedAccount, seedAnalysis, seedDraft, seedEmail } from "./_helpers/seed.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const __sidecarRequire = createRequire(resolve(__dir, "..", "..", "sidecar", "package.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = __sidecarRequire("better-sqlite3") as any;

interface DailyBriefingRow {
  accountId: string;
  date: string;
  briefingText: string;
  actionItems: unknown[];
  stats: {
    newEmails: number;
    needsReplyCount: number;
    autoHandledCount: number;
    draftsReadyCount: number;
    snoozedCount: number;
    upcomingEventsCount: number;
  };
  generatedAt: number;
  dismissedAt: number | null;
}

function isoLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function seedBriefing(
  h: Harness,
  accountId: string,
  date: string,
  options: {
    briefingText?: string;
    dismissedAt?: number | null;
    generatedAt?: number;
    stats?: Record<string, number>;
    actionItems?: unknown[];
  } = {},
): void {
  const db = new Database(h.dbPath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO daily_briefings
         (account_id, date, briefing_text, action_items_json, stats_json,
          generated_at, dismissed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      date,
      options.briefingText ?? "Para 1.\n\nPara 2.\n\nPara 3.",
      JSON.stringify(options.actionItems ?? []),
      JSON.stringify(options.stats ?? {}),
      options.generatedAt ?? Date.now(),
      options.dismissedAt ?? null,
    );
  } finally {
    db.close();
  }
}

function seedArchiveReady(
  h: Harness,
  threadId: string,
  accountId: string,
  isReady: boolean,
  reason = "ready",
): void {
  const db = new Database(h.dbPath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO archive_ready
         (thread_id, account_id, is_ready, reason, analyzed_at, dismissed)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(threadId, accountId, isReady ? 1 : 0, reason, Date.now());
  } finally {
    db.close();
  }
}

// ───────────────────────────────────────────────────────────────────────
//  briefing.getOrGenerate — cache hit + dismiss persistence
// ───────────────────────────────────────────────────────────────────────

describe("briefing.getOrGenerate cache + dismiss", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("requires accountId", async () => {
    await assert.rejects(() => h.call("briefing.getOrGenerate", {}), /requires \{ accountId \}/);
  });

  it("returns the cached row on second call (no regen)", async () => {
    const acct = seedAccount(h, { email: "matt@example.com" });
    const today = isoLocalDate(new Date());
    seedBriefing(h, acct, today, {
      briefingText: "Cached para 1.\n\nCached para 2.\n\nCached para 3.",
      generatedAt: 1234567890,
      stats: {
        newEmails: 7,
        needsReplyCount: 2,
        autoHandledCount: 5,
        draftsReadyCount: 1,
        snoozedCount: 0,
        upcomingEventsCount: 0,
      },
    });

    const first = await h.call<DailyBriefingRow>("briefing.getOrGenerate", {
      accountId: acct,
    });
    assert.equal(first.date, today);
    assert.equal(first.accountId, acct);
    assert.match(first.briefingText, /Cached para 1\./);
    assert.equal(first.generatedAt, 1234567890);
    assert.equal(first.stats.newEmails, 7);

    // Second call should hit the same cached row — generated_at unchanged
    // proves no regen happened.
    const second = await h.call<DailyBriefingRow>("briefing.getOrGenerate", {
      accountId: acct,
    });
    assert.equal(second.generatedAt, first.generatedAt);
  });
});

describe("briefing.dismiss + briefing.list", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("dismiss flips dismissed_at to a non-null timestamp", async () => {
    const acct = seedAccount(h, { email: "matt@example.com" });
    const today = isoLocalDate(new Date());
    seedBriefing(h, acct, today);

    const before = await h.call<DailyBriefingRow>("briefing.getOrGenerate", {
      accountId: acct,
    });
    assert.equal(before.dismissedAt, null);

    const result = await h.call<{ ok: true; briefing: DailyBriefingRow }>("briefing.dismiss", {
      accountId: acct,
      date: today,
    });
    assert.equal(result.ok, true);
    assert.notEqual(result.briefing.dismissedAt, null);
    assert.equal(typeof result.briefing.dismissedAt, "number");

    // Cache hit still returns the row, but with dismissedAt set.
    const after = await h.call<DailyBriefingRow>("briefing.getOrGenerate", {
      accountId: acct,
    });
    assert.notEqual(after.dismissedAt, null);
  });

  it("dismiss is idempotent on a missing row (no-op)", async () => {
    const acct = seedAccount(h, { email: "nobody@example.com" });
    const result = await h.call<{ ok: true; briefing: null }>("briefing.dismiss", {
      accountId: acct,
      date: "2099-01-01",
    });
    assert.equal(result.ok, true);
    assert.equal(result.briefing, null);
  });

  it("list returns last N days newest-first for the given account", async () => {
    const acct = seedAccount(h, { email: "matt@example.com" });
    seedBriefing(h, acct, "2026-05-01", { generatedAt: 1 });
    seedBriefing(h, acct, "2026-05-03", { generatedAt: 3 });
    seedBriefing(h, acct, "2026-05-02", { generatedAt: 2 });

    const rows = await h.call<DailyBriefingRow[]>("briefing.list", {
      accountId: acct,
      limit: 7,
    });
    const dates = rows.map((r) => r.date);
    assert.deepEqual(dates, ["2026-05-03", "2026-05-02", "2026-05-01"]);
  });

  it("list defaults to 7-day window and respects limit cap", async () => {
    const acct = seedAccount(h, { email: "matt2@example.com" });
    for (let day = 1; day <= 10; day++) {
      const dateStr = `2026-04-${String(day).padStart(2, "0")}`;
      seedBriefing(h, acct, dateStr, { generatedAt: day });
    }
    const rows = await h.call<DailyBriefingRow[]>("briefing.list", {
      accountId: acct,
    });
    assert.equal(rows.length, 7);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  permissions.list — aggregates drafts + archive_ready
// ───────────────────────────────────────────────────────────────────────

interface PermissionsListResponse {
  items: Array<{
    kind: "draft" | "archive";
    id: string;
    accountId: string;
    subject: string;
    preview: string;
    threadId?: string;
    emailId?: string;
  }>;
  counts: { drafts: number; archives: number; total: number };
}

describe("permissions.list aggregation", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("returns empty when nothing pending", async () => {
    const acct = seedAccount(h, { email: "empty@example.com" });
    const result = await h.call<PermissionsListResponse>("permissions.list", {
      accountId: acct,
    });
    assert.deepEqual(result.counts, { drafts: 0, archives: 0, total: 0 });
    assert.equal(result.items.length, 0);
  });

  it("includes pending drafts and archive-ready threads", async () => {
    const acct = seedAccount(h, { email: "active@example.com" });
    const emailId = seedEmail(h, {
      accountId: acct,
      subject: "Q3 plan",
      from: "tom@example.com",
      threadId: "thread-q3",
    });
    seedAnalysis(h, {
      emailId,
      needsReply: true,
      reason: "asks for approval",
      priority: "high",
    });
    seedDraft(h, {
      emailId,
      draftBody: "Yes, let's go with option A.",
      status: "pending",
    });

    // archive_ready row referencing a different thread + email.
    const otherEmailId = seedEmail(h, {
      accountId: acct,
      subject: "Newsletter — May",
      from: "news@example.com",
      threadId: "thread-news",
    });
    void otherEmailId;
    seedArchiveReady(h, "thread-news", acct, true, "auto-archived: low signal");

    const result = await h.call<PermissionsListResponse>("permissions.list", {
      accountId: acct,
    });
    assert.equal(result.counts.drafts, 1);
    assert.equal(result.counts.archives, 1);
    assert.equal(result.counts.total, 2);

    const draftItem = result.items.find((i) => i.kind === "draft");
    assert.ok(draftItem, "expected a draft item");
    assert.equal(draftItem!.subject, "Q3 plan");
    assert.equal(draftItem!.emailId, emailId);
    assert.match(draftItem!.preview, /Yes, let's go with option A/);

    const archiveItem = result.items.find((i) => i.kind === "archive");
    assert.ok(archiveItem, "expected an archive item");
    assert.equal(archiveItem!.subject, "Newsletter — May");
    assert.equal(archiveItem!.threadId, "thread-news");
  });

  it("filters by accountId — does not leak rows from other accounts", async () => {
    const acctA = seedAccount(h, { email: "acct-a@example.com" });
    const acctB = seedAccount(h, { email: "acct-b@example.com" });

    const emailA = seedEmail(h, { accountId: acctA, subject: "From A" });
    seedDraft(h, { emailId: emailA, draftBody: "draft A", status: "pending" });

    const emailB = seedEmail(h, { accountId: acctB, subject: "From B" });
    seedDraft(h, { emailId: emailB, draftBody: "draft B", status: "pending" });

    const onlyA = await h.call<PermissionsListResponse>("permissions.list", {
      accountId: acctA,
    });
    const subjects = onlyA.items.map((i) => i.subject);
    assert.ok(subjects.includes("From A"));
    assert.ok(!subjects.includes("From B"));
  });

  it("excludes already-dismissed archive_ready rows", async () => {
    const acct = seedAccount(h, { email: "dismissed@example.com" });
    seedEmail(h, {
      accountId: acct,
      threadId: "thread-stale",
      subject: "Stale newsletter",
    });
    seedArchiveReady(h, "thread-stale", acct, true);
    // Dismiss it — the existing namespace.
    await h.call("archiveReady.dismiss", {
      threadId: "thread-stale",
      accountId: acct,
    });

    const result = await h.call<PermissionsListResponse>("permissions.list", {
      accountId: acct,
    });
    assert.equal(result.counts.archives, 0);
  });
});
