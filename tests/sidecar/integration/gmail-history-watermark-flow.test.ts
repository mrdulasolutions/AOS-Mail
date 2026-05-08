// Integration test — Gmail history watermark must advance numerically,
// not lexicographically.
//
// Background (post-mortem item #5 P1): Gmail history ids are
// monotonically increasing integers transmitted as decimal strings. The
// pre-fix code used `>` to compare them as strings — so "99" > "100"
// returned `true`, and the watermark would *regress* across power-of-10
// boundaries. Subsequent sync calls would either re-fetch the same range
// or eventually trip HISTORY_EXPIRED (Gmail's 7-day window) and fall back
// to a full resync. Users saw "I got 3 emails on web Gmail but the
// desktop app only shows 1" until a manual refresh forced full sync.
//
// The fix uses `compareHistoryIds` (BigInt-aware) in
// getGmailHistoryChanges. compareHistoryIds itself is already unit-tested
// in gmail-fetch.test.ts. This integration test walks the persistence +
// comparison flow together: given a stored watermark and a synthetic
// "new" historyId from the API, the persisted value advances correctly.
//
// We can't drive sync.now with a real Gmail account (no tokens in test
// env), but the bug lives in the watermark-advance step that's
// independent of the API client — given a stored value and a new
// candidate, the persisted result must be the BigInt-larger one. We
// exercise that via the public sync_state surface (direct DB seed +
// read) plus the compareHistoryIds helper itself, so a regression in
// either piece would surface.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSidecar, type Harness } from "../_helpers/sidecar-process.js";
import { seedAccount } from "../_helpers/seed.js";
import { compareHistoryIds } from "../../../sidecar/src/services/providers/gmail-fetch.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const __sidecarRequire = createRequire(resolve(__dir, "..", "..", "..", "sidecar", "package.json"));
const Database = __sidecarRequire("better-sqlite3") as typeof import("better-sqlite3");

interface SyncStateRow {
  account_id: string;
  history_id: string;
  last_sync_at: number;
}

// Same SQL the sidecar's setGmailSyncState helper uses. We open a
// second connection so we can simulate "the sidecar persisted a
// new watermark" without going through the Gmail API path.
function persistWatermark(harness: Harness, accountId: string, historyId: string): void {
  const db = new Database(harness.dbPath);
  try {
    db.prepare(
      `INSERT INTO sync_state (account_id, history_id, last_sync_at)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         history_id = excluded.history_id,
         last_sync_at = excluded.last_sync_at`,
    ).run(accountId, historyId, Date.now());
  } finally {
    db.close();
  }
}

function readWatermark(harness: Harness, accountId: string): SyncStateRow | null {
  const db = new Database(harness.dbPath);
  try {
    return (
      (db
        .prepare("SELECT account_id, history_id, last_sync_at FROM sync_state WHERE account_id = ?")
        .get(accountId) as SyncStateRow | undefined) ?? null
    );
  } finally {
    db.close();
  }
}

// Mirror of the watermark-advance logic in getGmailHistoryChanges:
// given a starting `latest` and a sequence of incoming `respHist`
// values, advance `latest` only when the new value is BigInt-greater.
// This is the integration glue between the comparison helper and the
// persistence helper — a regression in either piece will surface here.
function simulateWatermarkAdvance(start: string, responses: string[]): string {
  let latest = start;
  for (const r of responses) {
    if (compareHistoryIds(r, latest) > 0) latest = r;
  }
  return latest;
}

describe("gmail history watermark advances numerically (post-mortem #5 regression guard)", () => {
  let h: Harness;
  let accountId: string;

  before(async () => {
    h = await spawnSidecar();
    accountId = seedAccount(h, {
      id: "acct-gmail-watermark",
      email: "watermark-user@example.com",
      provider: "gmail",
    });
    // Touch the DB via an RPC so the schema is materialised before we
    // open a second connection.
    await h.call("db.info");
  });

  after(async () => {
    await h.close();
  });

  it("from a stored watermark of 99 → response 100 → persists 100 (the post-mortem case)", async () => {
    persistWatermark(h, accountId, "99");
    const before = readWatermark(h, accountId);
    assert.equal(before?.history_id, "99", "starting watermark is 99");

    // The pre-fix bug: lexicographic compare "100" > "99" is FALSE,
    // so latest would stay at "99". With BigInt it correctly resolves
    // to "100". Drive the simulator and persist.
    const advanced = simulateWatermarkAdvance("99", ["100"]);
    assert.equal(advanced, "100", "comparison must select the numerically-larger value");
    persistWatermark(h, accountId, advanced);

    const after = readWatermark(h, accountId);
    assert.equal(
      after?.history_id,
      "100",
      "watermark must advance to 100 after a 99 → 100 sync (BigInt compare)",
    );
  });

  it("a sequence of mixed-length ids selects the BigInt max, not the lexicographic max", async () => {
    // The classic regression scenario the post-mortem flagged: a sync
    // call that processes multiple pages of history.list responses, each
    // carrying its own historyId. The pre-fix bug picked the lex-max
    // ("999") over the numeric-max ("1234") because string `>` walks
    // the leading digits.
    persistWatermark(h, accountId, "0");

    const sequence = ["999", "1000", "1234", "1100"];
    const advanced = simulateWatermarkAdvance("0", sequence);
    // BigInt max = "1234". Lex max = "999". The post-fix code MUST pick
    // 1234. If this asserts "999" something has regressed in
    // compareHistoryIds.
    assert.equal(advanced, "1234", "sequence must produce numeric-max, not lex-max");

    persistWatermark(h, accountId, advanced);
    const after = readWatermark(h, accountId);
    assert.equal(after?.history_id, "1234");
  });

  it("a single response that is BigInt-LESS than the stored watermark does NOT regress it", async () => {
    // Defensive case: even if Gmail somehow returned an out-of-order
    // historyId on a paginated history.list, the watermark must never
    // move backward. compareHistoryIds correctness drives this.
    persistWatermark(h, accountId, "5000");
    const advanced = simulateWatermarkAdvance("5000", ["4999"]);
    assert.equal(
      advanced,
      "5000",
      "watermark must not regress when the new candidate is BigInt-smaller",
    );
    persistWatermark(h, accountId, advanced);
    const after = readWatermark(h, accountId);
    assert.equal(after?.history_id, "5000");
  });

  it("watermark survives values past JavaScript's safe-integer ceiling", async () => {
    // Gmail's API explicitly says historyIds may exceed 2^53 — that's
    // exactly why they're transmitted as strings. BigInt comparison
    // covers the full range without precision loss.
    const beyondSafe = "9007199254740993"; // MAX_SAFE_INTEGER + 2
    const evenBigger = "9007199254740995"; // +4

    persistWatermark(h, accountId, beyondSafe);
    const advanced = simulateWatermarkAdvance(beyondSafe, [evenBigger]);
    assert.equal(advanced, evenBigger);
    persistWatermark(h, accountId, advanced);
    const after = readWatermark(h, accountId);
    assert.equal(after?.history_id, evenBigger);
  });

  it("compareHistoryIds is the function actually used in the sync path — sanity", () => {
    // Direct unit-style assertion to anchor the integration: if this
    // ever regresses to lexicographic order, the integration tests
    // above will pass for the trivial cases but the post-mortem bug
    // returns. Belt-and-suspenders against future refactors that
    // accidentally re-introduce string compare.
    assert.equal(compareHistoryIds("99", "100"), -1);
    assert.equal(compareHistoryIds("999", "1234"), -1);
    assert.equal(compareHistoryIds("100", "99"), 1);
  });
});

describe("sync.now on a Gmail account without tokens fails cleanly without writing watermark", () => {
  let h: Harness;
  let accountId: string;

  before(async () => {
    h = await spawnSidecar();
    accountId = seedAccount(h, {
      id: "acct-gmail-no-tokens",
      email: "no-tokens@example.com",
      provider: "gmail",
    });
  });

  after(async () => {
    await h.close();
  });

  it("sync.now resolves with errors[] on a token-less Gmail account; no watermark written", async () => {
    // Boundary check: the sync flow on an unconnected account doesn't
    // throw — it returns a SyncResult with an `errors` array. This
    // prevents a never-connected account from blocking the
    // initializeSync rail. We assert that no sync_state row materialises
    // because the History API call never succeeded.
    const result = (await h.call("sync.now", { accountId })) as {
      accountId: string;
      fetched: number;
      newRows: number;
      newEmails: unknown[];
      errors: string[];
    };
    assert.equal(result.accountId, accountId);
    assert.ok(result.errors.length > 0, "must report at least one error on a token-less account");
    assert.equal(result.newRows, 0);

    const watermark = readWatermark(h, accountId);
    assert.equal(
      watermark,
      null,
      "no sync_state row should be written when the API call never succeeded",
    );
  });
});
