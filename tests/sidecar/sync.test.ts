// Sync RPC tests — exercises sync.init, sync.getEmails (with analysis/draft
// joins), and sync.prefetchBodies' body-already-present short-circuit.
//
// Why these specifically:
//   - sync.init was broken in past releases when accounts existed in the
//     DB but their IsConnected flag was wrong; we pin the join behavior.
//   - sync.getEmails LEFT JOINs analyses+drafts; the renderer paints an
//     empty list when this join silently drops rows. We seed an analysis
//     and verify it shows up on the row.
//   - sync.prefetchBodies short-circuits via fetchBodyForEmail when
//     row.body.length > 0. That branch is testable without an IMAP
//     server — we just pre-populate the body field directly.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";
import { seedAccount, seedEmail, seedAnalysis, seedDraft } from "./_helpers/seed.js";

interface SidecarAccountInfo {
  accountId: string;
  email: string;
  isConnected: boolean;
  provider: string;
}

interface DashboardEmailRow {
  id: string;
  threadId: string;
  accountId: string;
  subject: string;
  from: string;
  to: string;
  body: string | null;
  labelIds: string | null;
  isUnread: boolean;
  analysis?: {
    needsReply: boolean;
    reason: string;
    priority?: "high" | "medium" | "low" | "skip";
    analyzedAt: number;
  };
  draft?: {
    body: string;
    status: string;
  };
}

describe("sync.init", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("returns [] when no accounts are seeded", async () => {
    const accounts = await h.call<SidecarAccountInfo[]>("sync.init");
    assert.deepEqual(accounts, []);
  });

  it("returns each seeded account with provider + isConnected flags", async () => {
    seedAccount(h, {
      id: "acct-imap-1",
      email: "imap-user@example.com",
      provider: "imap",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUsername: "imap-user@example.com",
    });
    seedAccount(h, {
      id: "acct-gmail-1",
      email: "gmail-user@example.com",
      provider: "gmail",
    });

    const accounts = await h.call<SidecarAccountInfo[]>("sync.init");
    assert.equal(accounts.length, 2);

    const byEmail = new Map(accounts.map((a) => [a.email, a]));
    const imap = byEmail.get("imap-user@example.com");
    const gmail = byEmail.get("gmail-user@example.com");
    assert.ok(imap, "imap account should be present");
    assert.ok(gmail, "gmail account should be present");
    assert.equal(imap.provider, "imap");
    assert.equal(gmail.provider, "gmail");
    // No tokens / no IMAP creds yet → isConnected must be false.
    assert.equal(imap.isConnected, false);
    assert.equal(gmail.isConnected, false);
    assert.equal(imap.accountId, "acct-imap-1");
    assert.equal(gmail.accountId, "acct-gmail-1");
  });

  it("orders accounts by added_at (insertion order)", async () => {
    // Already inserted in the previous test; verify deterministic order.
    const accounts = await h.call<SidecarAccountInfo[]>("sync.init");
    // imap was inserted first, gmail second; sync.ts orders by added_at ASC.
    assert.equal(accounts[0]?.accountId, "acct-imap-1");
    assert.equal(accounts[1]?.accountId, "acct-gmail-1");
  });
});

describe("sync.getEmails with analysis/draft joins", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("returns rows with the analysis subobject when an analysis is joined", async () => {
    const accountId = seedAccount(h, { email: "joined@example.com", provider: "imap" });
    const emailId = seedEmail(h, {
      accountId,
      subject: "Test thread",
      from: "boss@example.com",
      to: "joined@example.com",
      body: "Body here",
    });
    seedAnalysis(h, {
      emailId,
      needsReply: true,
      reason: "boss is asking",
      priority: "high",
      analyzedAt: 1700000000000,
    });

    const rows = await h.call<DashboardEmailRow[]>("sync.getEmails", { accountId });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.id, emailId);
    assert.ok(row.analysis, "analysis subobject must be present");
    assert.equal(row.analysis.needsReply, true);
    assert.equal(row.analysis.reason, "boss is asking");
    assert.equal(row.analysis.priority, "high");
    assert.equal(row.analysis.analyzedAt, 1700000000000);
  });

  it("returns rows with the draft subobject when a draft is joined", async () => {
    const accountId = seedAccount(h, { email: "draft@example.com", provider: "imap" });
    const emailId = seedEmail(h, {
      accountId,
      subject: "Reply needed",
      from: "client@example.com",
      to: "draft@example.com",
    });
    seedDraft(h, {
      emailId,
      draftBody: "Thanks, we'll get back to you.",
      status: "pending",
      composeMode: "reply",
      to: ["client@example.com"],
    });

    const rows = await h.call<DashboardEmailRow[]>("sync.getEmails", { accountId });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.ok(row.draft);
    assert.equal(row.draft.body, "Thanks, we'll get back to you.");
    assert.equal(row.draft.status, "pending");
  });

  it("returns rows with neither analysis nor draft when none are joined", async () => {
    const accountId = seedAccount(h, { email: "plain@example.com", provider: "imap" });
    seedEmail(h, { accountId, subject: "Plain email" });

    const rows = await h.call<DashboardEmailRow[]>("sync.getEmails", { accountId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.analysis, undefined);
    assert.equal(rows[0]?.draft, undefined);
  });

  it("filters by accountId", async () => {
    const a = seedAccount(h, { email: "a@example.com", provider: "imap" });
    const b = seedAccount(h, { email: "b@example.com", provider: "imap" });
    seedEmail(h, { accountId: a, subject: "A1" });
    seedEmail(h, { accountId: b, subject: "B1" });
    seedEmail(h, { accountId: b, subject: "B2" });

    const rowsA = await h.call<DashboardEmailRow[]>("sync.getEmails", { accountId: a });
    const rowsB = await h.call<DashboardEmailRow[]>("sync.getEmails", { accountId: b });
    assert.equal(rowsA.length, 1);
    assert.equal(rowsB.length, 2);
    assert.equal(rowsA[0]?.subject, "A1");
  });

  it("throws when accountId is missing", async () => {
    await assert.rejects(
      () => h.call("sync.getEmails", {}),
      /requires \{ accountId \}/,
    );
  });
});

describe("sync.prefetchBodies", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("returns [] for empty input", async () => {
    const result = await h.call<unknown[]>("sync.prefetchBodies", { ids: [] });
    assert.deepEqual(result, []);
  });

  it("returns [] when ids param is missing", async () => {
    const result = await h.call<unknown[]>("sync.prefetchBodies", {});
    assert.deepEqual(result, []);
  });

  it("returns [{id, body}] for ids whose bodies are already populated", async () => {
    // The fetchBodyForEmail short-circuit returns the stored body when
    // row.body.length > 0 — no IMAP/Gmail server needed.
    const accountId = seedAccount(h, { email: "prefetch@example.com", provider: "imap" });
    const idA = seedEmail(h, {
      id: `imap:${accountId}:INBOX:1001`,
      accountId,
      body: "Body A — already fetched",
    });
    const idB = seedEmail(h, {
      id: `imap:${accountId}:INBOX:1002`,
      accountId,
      body: "Body B — already fetched",
    });

    const result = await h.call<Array<{ id: string; body: string }>>("sync.prefetchBodies", {
      ids: [idA, idB],
    });
    assert.equal(result.length, 2);
    const byId = new Map(result.map((r) => [r.id, r.body]));
    assert.equal(byId.get(idA), "Body A — already fetched");
    assert.equal(byId.get(idB), "Body B — already fetched");
  });

  it("skips ids that don't exist (returns whatever subset succeeds)", async () => {
    // The handler logs and continues on per-id failure; missing ids return
    // null from fetchBodyForEmail, which is filtered out before push.
    const accountId = seedAccount(h, { email: "skip@example.com", provider: "imap" });
    const realId = seedEmail(h, {
      id: `imap:${accountId}:INBOX:2001`,
      accountId,
      body: "real body",
    });
    const result = await h.call<Array<{ id: string; body: string }>>("sync.prefetchBodies", {
      ids: [realId, "imap:nonexistent:INBOX:9999"],
    });
    // Only the real id makes it through. The bogus id has no row, so
    // fetchBodyForEmail returns null and the id is omitted.
    const ids = result.map((r) => r.id);
    assert.ok(ids.includes(realId));
    assert.equal(ids.includes("imap:nonexistent:INBOX:9999"), false);
  });
});

describe("sync.start / sync.stop / sync.setInterval", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("sync.start without accountId throws", async () => {
    await assert.rejects(
      () => h.call("sync.start", {}),
      /requires \{ accountId \}/,
    );
  });

  it("sync.start returns the current intervalMs", async () => {
    const result = await h.call<{ ok: true; intervalMs: number }>("sync.start", {
      accountId: "test-acct",
    });
    assert.equal(result.ok, true);
    assert.ok(result.intervalMs >= 5_000);
    // Stop so we don't leave a timer churning in the harness.
    await h.call("sync.stop", { accountId: "test-acct" });
  });

  it("sync.setInterval clamps below 5s and above 1h to current value", async () => {
    // Get the baseline.
    const before = await h.call<{ ok: true; intervalMs: number }>("sync.setInterval", {
      intervalMs: 90_000,
    });
    assert.equal(before.intervalMs, 90_000);

    // Out of range values are silently ignored.
    const tooSmall = await h.call<{ ok: true; intervalMs: number }>("sync.setInterval", {
      intervalMs: 100,
    });
    assert.equal(tooSmall.intervalMs, 90_000);

    const tooBig = await h.call<{ ok: true; intervalMs: number }>("sync.setInterval", {
      intervalMs: 999_999_999,
    });
    assert.equal(tooBig.intervalMs, 90_000);

    // In-range value sticks.
    const ok = await h.call<{ ok: true; intervalMs: number }>("sync.setInterval", {
      intervalMs: 60_000,
    });
    assert.equal(ok.intervalMs, 60_000);
  });
});
