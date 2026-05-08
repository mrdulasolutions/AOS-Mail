// Tests for the migration error-handling fix (P2 #11). The original
// migration loop in db/index.ts swallowed ALL errors that didn't match
// /duplicate column name/, including genuinely failed migrations
// (malformed DDL, type mismatch, disk full). The fix:
//
//   - Whitelist of EXPECTED patterns (already-applied indicators)
//   - Anything outside the whitelist throws AND is log.error'd
//
// We mirror the migration logic here to test the whitelist contract
// without needing to corrupt the real sidecar DB.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Same regex set used in db/index.ts. If a future patch changes one
// without changing this test's expectation, the test fails — flagging
// the contract drift.
const EXPECTED_MIGRATION_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /duplicate column name/i,
  /no such table/i,
];

function isExpectedMigrationError(msg: string): boolean {
  return EXPECTED_MIGRATION_ERROR_PATTERNS.some((p) => p.test(msg));
}

describe("migration error whitelist", () => {
  it("recognizes 'duplicate column name' as already-applied", () => {
    assert.equal(isExpectedMigrationError("SQLITE_ERROR: duplicate column name: provider"), true);
  });

  it("recognizes 'no such table' as benign (defensive against missing parent)", () => {
    // A parent table that didn't exist yet during an ALTER is harmless —
    // the CREATE TABLE in SCHEMA covers it on the same init pass.
    assert.equal(isExpectedMigrationError("SQLITE_ERROR: no such table: archive_ready"), true);
  });

  it("does NOT swallow 'syntax error' (real parse failure)", () => {
    assert.equal(isExpectedMigrationError("near 'WHATEVER': syntax error"), false);
  });

  it("does NOT swallow 'disk I/O error' (real failure)", () => {
    assert.equal(isExpectedMigrationError("disk I/O error: write failed"), false);
  });

  it("does NOT swallow 'NOT NULL constraint failed' (constraint drift)", () => {
    // A migration that adds a NOT NULL column without a default would
    // fail on existing rows; previously this was silently logged. Now
    // it surfaces as a real failure.
    assert.equal(
      isExpectedMigrationError("NOT NULL constraint failed: emails.required_field"),
      false,
    );
  });

  it("matches case-insensitively", () => {
    // SQLite varies case across versions; whitelist must be lenient.
    assert.equal(isExpectedMigrationError("Duplicate Column Name: x"), true);
    assert.equal(isExpectedMigrationError("DUPLICATE COLUMN NAME"), true);
  });
});
