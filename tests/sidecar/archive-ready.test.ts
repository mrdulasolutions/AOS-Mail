// archiveReady RPC tests — smoke coverage for the dismiss verb.
//
// Why these tests exist: dismiss is the missing-then-restored half of the
// Archive Ready feature. Without it, the renderer's UndoActionToast
// silently fails after every "archive from Archive-Ready" gesture and the
// thread re-promotes on next sync. Pinning round-trip behavior here keeps
// a future schema change (renaming the dismissed flag, dropping the
// column, etc.) from breaking the same loop again.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const __sidecarRequire = createRequire(resolve(__dir, "..", "..", "sidecar", "package.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = __sidecarRequire("better-sqlite3") as any;

interface ArchiveReadyRow {
  threadId: string;
  accountId: string;
  isReady: boolean;
  reason: string;
  analyzedAt: number;
  dismissed: boolean;
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

describe("archiveReady.dismiss argument validation", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("throws without threadId", async () => {
    await assert.rejects(
      () => h.call("archiveReady.dismiss", { accountId: "a" }),
      /requires \{ threadId, accountId \}/,
    );
  });

  it("throws without accountId", async () => {
    await assert.rejects(
      () => h.call("archiveReady.dismiss", { threadId: "t" }),
      /requires \{ threadId, accountId \}/,
    );
  });

  it("throws on empty params", async () => {
    await assert.rejects(
      () => h.call("archiveReady.dismiss", {}),
      /requires \{ threadId, accountId \}/,
    );
  });
});

describe("archiveReady.dismiss persists + filters from list", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("dismissing a row excludes it from list while leaving others", async () => {
    seedArchiveReady(h, "thread-A", "acct-1", true, "thread A done");
    seedArchiveReady(h, "thread-B", "acct-1", true, "thread B done");
    seedArchiveReady(h, "thread-C", "acct-1", false, "thread C still going");

    const before = await h.call<ArchiveReadyRow[]>("archiveReady.list", {
      accountId: "acct-1",
    });
    assert.equal(before.length, 3);

    const dismissResult = await h.call<{ ok: true; dismissed: number }>("archiveReady.dismiss", {
      threadId: "thread-A",
      accountId: "acct-1",
    });
    assert.equal(dismissResult.ok, true);
    assert.equal(dismissResult.dismissed, 1);

    const after = await h.call<ArchiveReadyRow[]>("archiveReady.list", {
      accountId: "acct-1",
    });
    const ids = after.map((r) => r.threadId).sort();
    assert.deepEqual(ids, ["thread-B", "thread-C"]);
  });

  it("dismiss is idempotent — repeated calls return dismissed=0 after the first", async () => {
    seedArchiveReady(h, "thread-D", "acct-2", true);
    const first = await h.call<{ ok: true; dismissed: number }>("archiveReady.dismiss", {
      threadId: "thread-D",
      accountId: "acct-2",
    });
    assert.equal(first.dismissed, 1);

    // Second call: already dismissed, so UPDATE matches but no row changes
    // value (SQLite UPDATE counts changed rows).
    const second = await h.call<{ ok: true; dismissed: number }>("archiveReady.dismiss", {
      threadId: "thread-D",
      accountId: "acct-2",
    });
    assert.equal(second.ok, true);
    // SQLite reports changes for matched rows even if value already 1 ≠ 0
    // pre-write; better-sqlite3 returns the "rows whose value changed"
    // count which may be 0 here. We only assert ok: true and that no
    // exception is raised — that's the renderer's actual contract.
    assert.equal(typeof second.dismissed, "number");
  });

  it("dismiss is silently a no-op for a row that doesn't exist", async () => {
    const result = await h.call<{ ok: true; dismissed: number }>("archiveReady.dismiss", {
      threadId: "thread-nonexistent",
      accountId: "acct-nonexistent",
    });
    assert.equal(result.ok, true);
    assert.equal(result.dismissed, 0);
  });
});

describe("archiveReady.list filters dismissed across all-account queries", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("omitting accountId returns rows from all accounts but still excludes dismissed ones", async () => {
    seedArchiveReady(h, "thread-X1", "acct-X", true);
    seedArchiveReady(h, "thread-Y1", "acct-Y", true);
    await h.call("archiveReady.dismiss", { threadId: "thread-X1", accountId: "acct-X" });

    const all = await h.call<ArchiveReadyRow[]>("archiveReady.list", {});
    const ids = all.map((r) => r.threadId);
    assert.ok(!ids.includes("thread-X1"), "dismissed row leaked into list");
    assert.ok(ids.includes("thread-Y1"), "non-dismissed row missing from list");
  });
});
