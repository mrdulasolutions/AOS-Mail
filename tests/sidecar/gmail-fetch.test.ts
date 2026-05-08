// Pure-function tests for gmail-fetch helpers.
//
// These don't go through the sidecar harness — they import the helper
// directly so we can drive specific edge cases. The helper-under-test is
// `compareHistoryIds`, which fixed a P1 from the May 2026 post-mortem:
// the watermark code in getGmailHistoryChanges used to compare Gmail
// historyIds with `>` (string compare). Lexicographically, "99" > "100"
// is true — so the watermark would regress past a power-of-ten boundary
// and we'd persist a SMALLER historyId after a sync. Next call's history
// query would re-fetch the same window or, eventually, hit
// HISTORY_EXPIRED (7-day window) and force a full re-sync.
//
// The fix uses BigInt so the comparison is correct across the full Gmail
// historyId range (which can exceed 2^53 — the API explicitly says ids
// are integers, but they're transmitted as strings precisely because
// JavaScript's safe-integer ceiling isn't enough).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compareHistoryIds } from "../../sidecar/src/services/providers/gmail-fetch.js";

describe("compareHistoryIds — numeric, not lexicographic", () => {
  it('returns -1 for "99" vs "100" (the bug we are fixing)', () => {
    // The string-compare bug: "99" > "100" because "9" > "1". We want
    // numeric semantics: 99 < 100, so the result must be -1.
    assert.equal(compareHistoryIds("99", "100"), -1);
  });

  it('returns +1 for "100" vs "99"', () => {
    assert.equal(compareHistoryIds("100", "99"), 1);
  });

  it("returns 0 for equal ids", () => {
    assert.equal(compareHistoryIds("12345", "12345"), 0);
  });

  it("handles ids that fit in normal Number range", () => {
    assert.equal(compareHistoryIds("1000", "999"), 1);
    assert.equal(compareHistoryIds("1000000", "999999"), 1);
  });

  it("handles ids beyond the safe-integer ceiling", () => {
    // Number.MAX_SAFE_INTEGER is 9007199254740991. Gmail historyIds are
    // documented as integers transmitted as strings precisely so they
    // can grow past this. BigInt comparison must still be correct.
    const a = "9007199254740993"; // MAX_SAFE_INTEGER + 2
    const b = "9007199254740992"; // MAX_SAFE_INTEGER + 1
    assert.equal(compareHistoryIds(a, b), 1);
    assert.equal(compareHistoryIds(b, a), -1);
  });

  it("treats null/undefined as smallest (sort before any defined id)", () => {
    assert.equal(compareHistoryIds(null, "1"), -1);
    assert.equal(compareHistoryIds(undefined, "1"), -1);
    assert.equal(compareHistoryIds("1", null), 1);
    assert.equal(compareHistoryIds(null, null), 0);
    assert.equal(compareHistoryIds(undefined, undefined), 0);
  });

  it("works as a comparator for Array.sort", () => {
    const ids = ["100", "9", "1000", "99", "10"];
    const sorted = [...ids].sort(compareHistoryIds);
    assert.deepEqual(sorted, ["9", "10", "99", "100", "1000"]);
  });
});
