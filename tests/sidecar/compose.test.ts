// compose.* RPC tests — focused on the local drafts CRUD lifecycle.
//
// We deliberately don't exercise compose.send: it requires a real
// Gmail/IMAP connection to the SMTP service, which a unit test can't
// stand up. The renderer's e2e suite covers send.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";
import { seedAccount } from "./_helpers/seed.js";

interface LocalDraft {
  id: string;
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  fromAddress?: string;
  threadId?: string;
  inReplyTo?: string;
  isReply: boolean;
  isForward: boolean;
  createdAt: number;
  updatedAt: number;
}

describe("compose local drafts lifecycle", () => {
  let h: Harness;
  let accountId: string;
  before(async () => {
    h = await spawnSidecar();
    accountId = seedAccount(h, { email: "drafter@example.com", provider: "imap" });
  });
  after(async () => {
    await h.close();
  });

  it("listLocalDrafts returns [] on a fresh DB", async () => {
    const drafts = await h.call<LocalDraft[]>("compose.listLocalDrafts");
    assert.deepEqual(drafts, []);
  });

  it("saveLocalDraft → updateLocalDraft → listLocalDrafts → deleteLocalDraft", async () => {
    const saved = await h.call<LocalDraft>("compose.saveLocalDraft", {
      accountId,
      to: ["alice@example.com", "bob@example.com"],
      cc: ["cc@example.com"],
      subject: "Initial draft",
      bodyHtml: "<p>Hello there</p>",
      bodyText: "Hello there",
      isReply: false,
      isForward: false,
    });
    assert.ok(saved.id.startsWith("local:"), "draft id should be prefixed local:");
    assert.equal(saved.accountId, accountId);
    assert.deepEqual(saved.to, ["alice@example.com", "bob@example.com"]);
    assert.deepEqual(saved.cc, ["cc@example.com"]);
    assert.equal(saved.subject, "Initial draft");
    assert.equal(saved.bodyHtml, "<p>Hello there</p>");
    assert.equal(saved.bodyText, "Hello there");
    assert.equal(saved.isReply, false);
    assert.equal(saved.isForward, false);
    assert.ok(saved.createdAt > 0);
    assert.ok(saved.updatedAt > 0);

    // List should now contain it.
    const afterSave = await h.call<LocalDraft[]>("compose.listLocalDrafts");
    assert.equal(afterSave.length, 1);
    assert.equal(afterSave[0]?.id, saved.id);

    // Brief sleep to ensure updatedAt actually moves forward (Date.now()
    // is millisecond resolution but writes happen back-to-back).
    await new Promise((r) => setTimeout(r, 5));

    // Update — change body, drop CC, set subject.
    const updated = await h.call<LocalDraft | null>("compose.updateLocalDraft", {
      id: saved.id,
      bodyHtml: "<p>Updated body</p>",
      bodyText: "Updated body",
      cc: [],
      subject: "Updated subject",
    });
    assert.ok(updated, "updateLocalDraft should return the row");
    assert.equal(updated.id, saved.id);
    assert.equal(updated.bodyHtml, "<p>Updated body</p>");
    assert.equal(updated.bodyText, "Updated body");
    assert.equal(updated.subject, "Updated subject");
    // Empty cc array gets coerced to null in storage and back to undefined.
    assert.equal(updated.cc, undefined);
    // Fields not in the patch should be unchanged.
    assert.deepEqual(updated.to, ["alice@example.com", "bob@example.com"]);
    // updatedAt must be >= createdAt.
    assert.ok(updated.updatedAt >= updated.createdAt);

    // List shows the updated row.
    const afterUpdate = await h.call<LocalDraft[]>("compose.listLocalDrafts");
    assert.equal(afterUpdate.length, 1);
    assert.equal(afterUpdate[0]?.subject, "Updated subject");

    // Delete — list goes back to empty.
    const del = await h.call<{ ok: true }>("compose.deleteLocalDraft", { id: saved.id });
    assert.equal(del.ok, true);
    const afterDelete = await h.call<LocalDraft[]>("compose.listLocalDrafts");
    assert.deepEqual(afterDelete, []);
  });

  it("listLocalDrafts orders by updated_at DESC", async () => {
    const a = await h.call<LocalDraft>("compose.saveLocalDraft", {
      accountId,
      to: ["a@example.com"],
      subject: "A",
      bodyHtml: "",
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = await h.call<LocalDraft>("compose.saveLocalDraft", {
      accountId,
      to: ["b@example.com"],
      subject: "B",
      bodyHtml: "",
    });
    await new Promise((r) => setTimeout(r, 5));
    // Update A so it now has the most recent updatedAt.
    await h.call("compose.updateLocalDraft", { id: a.id, subject: "A — bumped" });

    const list = await h.call<LocalDraft[]>("compose.listLocalDrafts");
    assert.equal(list.length, 2);
    // Newest-updated first.
    assert.equal(list[0]?.id, a.id);
    assert.equal(list[1]?.id, b.id);

    // Cleanup.
    await h.call("compose.deleteLocalDraft", { id: a.id });
    await h.call("compose.deleteLocalDraft", { id: b.id });
  });

  it("saveLocalDraft requires accountId", async () => {
    await assert.rejects(
      () => h.call("compose.saveLocalDraft", {}),
      /requires \{ accountId \}/,
    );
  });

  it("updateLocalDraft returns null for a missing id", async () => {
    const result = await h.call<LocalDraft | null>("compose.updateLocalDraft", {
      id: "local:does-not-exist",
      subject: "doesn't matter",
    });
    assert.equal(result, null);
  });

  it("updateLocalDraft requires id", async () => {
    await assert.rejects(
      () => h.call("compose.updateLocalDraft", { subject: "x" }),
      /requires \{ id \}/,
    );
  });

  it("deleteLocalDraft requires id", async () => {
    await assert.rejects(
      () => h.call("compose.deleteLocalDraft", {}),
      /requires \{ id \}/,
    );
  });

  it("deleteLocalDraft is idempotent for unknown ids", async () => {
    // The handler runs DELETE FROM ... WHERE id = ?, which is safe even
    // when 0 rows match. The renderer relies on this to "ensure deleted".
    const result = await h.call<{ ok: true }>("compose.deleteLocalDraft", {
      id: "local:nonexistent",
    });
    assert.equal(result.ok, true);
  });

  it("getSendAsAliases returns { aliases: [] } for V1", async () => {
    // V1 ships an empty list; this test pins that contract so the
    // renderer's fallback-to-primary-email path keeps working.
    const result = await h.call<{ aliases: unknown[] }>("compose.getSendAsAliases", {
      accountId,
    });
    assert.deepEqual(result, { aliases: [] });
  });
});

describe("compose.send argument validation", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("throws without accountId", async () => {
    await assert.rejects(
      () => h.call("compose.send", { to: ["x@example.com"], subject: "x" }),
      /requires \{ accountId \}/,
    );
  });

  it("throws without to[]", async () => {
    await assert.rejects(
      () => h.call("compose.send", { accountId: "x", to: [], subject: "x" }),
      /requires \{ to \}/,
    );
  });

  it("throws when account is unknown", async () => {
    await assert.rejects(
      () =>
        h.call("compose.send", {
          accountId: "no-such-account",
          to: ["x@example.com"],
          subject: "x",
        }),
      /account no-such-account not found/,
    );
  });
});
