// Contract test — type-level only.
//
// This file's job is to fail at `tsc --noEmit` time when the contract in
// src/shared/sidecar-contract.ts drifts from the shape the renderer/sidecar
// rely on. We use:
//   - positive assertions:   `expectAssignable` checks that real shapes fit
//   - negative assertions:   `// @ts-expect-error` blocks fail to compile
//                            iff the negative shape DOES type-check
//
// Runtime test: just one trivial assertion so node:test reports the file
// as passed. The real value is in the static type-checker pass that the
// CI script runs alongside.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  SidecarMethods,
  SidecarMethodName,
  SidecarMethodParams,
  SidecarMethodResult,
} from "../../src/shared/sidecar-contract.js";

// ── Positive type assertions ──────────────────────────────────────────
//
// These are no-op variable bindings whose only purpose is to make the
// type-checker accept (or reject) the shape. They never run.

// 1. Every method name is one of the known string literals.
const _name: SidecarMethodName = "ping";
void _name;

// 2. ping params is void; result has the documented fields.
const _pingResult: SidecarMethodResult<"ping"> = {
  ok: true,
  pid: 123,
  node: "v22",
  ts: "2025-01-01T00:00:00Z",
};
void _pingResult;

// 3. sync.now params has accountId; result has the SyncResultLite shape.
const _syncNowParams: SidecarMethodParams<"sync.now"> = { accountId: "a" };
const _syncNowResult: SidecarMethodResult<"sync.now"> = {
  accountId: "a",
  fetched: 0,
  newRows: 0,
  newEmails: [],
  errors: [],
};
void _syncNowParams;
void _syncNowResult;

// 4. emails.archive params requires emailId, accountId is optional.
const _archiveJustId: SidecarMethodParams<"emails.archive"> = { emailId: "imap:x:y:1" };
const _archiveBoth: SidecarMethodParams<"emails.archive"> = {
  emailId: "imap:x:y:1",
  accountId: "x",
};
void _archiveJustId;
void _archiveBoth;

// 5. summary.thread result includes the cached flag.
const _summary: SidecarMethodResult<"summary.thread"> = {
  summary: "",
  actionItems: [],
  decisions: [],
  cached: false,
};
void _summary;

// 6. theme.set: only the three string literals.
const _themeSet: SidecarMethodParams<"theme.set"> = { theme: "dark" };
void _themeSet;

// ── Negative type assertions ──────────────────────────────────────────
//
// Each block below SHOULD fail to compile if removed. The
// // @ts-expect-error comment swallows the expected error; if the
// underlying types are loose (so the wrong shape DOES compile), the
// "Unused @ts-expect-error directive" diagnostic fires and `tsc --noEmit`
// in the CI script fails.

// 7. Method name not in the contract is rejected.
// @ts-expect-error — "not.a.real.method" is not a SidecarMethodName.
const _badName: SidecarMethodName = "not.a.real.method";
void _badName;

// 8. sync.now requires accountId; empty object is wrong.
// @ts-expect-error — missing accountId.
const _syncNowMissingId: SidecarMethodParams<"sync.now"> = {};
void _syncNowMissingId;

// 9. theme.set rejects non-literal strings.
// @ts-expect-error — "purple" is not "light" | "dark" | "system".
const _badTheme: SidecarMethodParams<"theme.set"> = { theme: "purple" };
void _badTheme;

// 10. compose.deleteLocalDraft requires id (cannot be empty).
// @ts-expect-error — { } missing id.
const _badDelete: SidecarMethodParams<"compose.deleteLocalDraft"> = {};
void _badDelete;

// 11. emails.batchArchive requires string[], not number[]. The @ts-expect-error
//     attaches to each `1`, `2`, `3` individually because each literal is a
//     separate type-check site — TS reports three errors but the directive
//     only suppresses one. Use a single non-string assignment instead.
const _wrongBatchType: SidecarMethodParams<"emails.batchArchive"> = {
  // @ts-expect-error — emailIds must be string[].
  emailIds: [42],
};
void _wrongBatchType;

// 12. SidecarMethods has at minimum the keys we depend on most.
// This will fail to compile if any of them are renamed.
type _MustHave =
  | keyof Pick<
      SidecarMethods,
      | "ping"
      | "settings.get"
      | "settings.set"
      | "settings.validateApiKey"
      | "settings.getEA"
      | "settings.setEA"
      | "settings.getPrompts"
      | "settings.setPrompts"
      | "sync.init"
      | "sync.now"
      | "sync.getEmails"
      | "sync.prefetchBodies"
      | "emails.archive"
      | "emails.trash"
      | "emails.getThread"
      | "compose.send"
      | "compose.saveLocalDraft"
      | "compose.updateLocalDraft"
      | "compose.listLocalDrafts"
      | "compose.deleteLocalDraft"
      | "summary.thread"
      | "theme.get"
      | "theme.set"
    >;
const _exists: _MustHave = "ping";
void _exists;

// ── Tiny runtime test so node:test acknowledges the file ──────────────

describe("sidecar contract — type-level", () => {
  it("compiles", () => {
    // The actual assertion is `tsc --noEmit` over this file. If we got
    // here at runtime, the type-check passed.
    assert.equal(typeof _exists, "string");
  });
});
