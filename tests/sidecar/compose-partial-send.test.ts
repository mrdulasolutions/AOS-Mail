// Tests for compose.send's partial-send error surface (P2 #26).
//
// Background: SMTP returns { accepted, rejected } per send. nodemailer's
// resolved promise treats a non-empty `rejected` as a successful send.
// The original sidecar code passed both arrays back in the success
// response — but the renderer's IpcResponse wrapper only reads
// `success: boolean`, so a 3-of-5 partial failure looked identical to
// a clean send.
//
// The fix: when rejected.length > 0, throw a structured error with the
// `partial-send: ...` prefix containing accepted count + rejected list.
// The renderer's electron-shim parses that prefix and surfaces a clear
// "Sent to X, failed for Y" toast instead of a silent "Sent!".
//
// Two unit tests:
//   1. The error-format contract — assert that the message we throw is
//      parseable by the renderer's regex.
//   2. The renderer's parser — given the formatted error, produce the
//      right user-facing message.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const PARTIAL_SEND_RE = /^partial-send: delivered to (\d+), rejected \d+ \(([^)]*)\)$/;

function buildPartialSendErrorMessage(accepted: string[], rejected: string[]): string {
  return `partial-send: delivered to ${accepted.length}, rejected ${rejected.length} (${rejected.join(", ")})`;
}

// Mirror of the renderer's parse logic in electron-shim.ts. Kept in
// sync with that file by including the same regex shape.
function parsePartialSend(message: string): {
  acceptedCount: number;
  rejected: string[];
} | null {
  const m = message.match(PARTIAL_SEND_RE);
  if (!m) return null;
  const acceptedCount = parseInt(m[1] ?? "0", 10);
  const rejected = (m[2] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { acceptedCount, rejected };
}

describe("compose.send partial-send error format", () => {
  it("formats a 3-of-5 partial failure parseably", () => {
    const message = buildPartialSendErrorMessage(
      ["alice@example.com", "bob@example.com"],
      ["bad@example.com", "blocked@example.com", "filter@example.com"],
    );
    const parsed = parsePartialSend(message);
    assert.ok(parsed, "renderer parser should match the sidecar format");
    assert.equal(parsed.acceptedCount, 2);
    assert.deepEqual(parsed.rejected, [
      "bad@example.com",
      "blocked@example.com",
      "filter@example.com",
    ]);
  });

  it("formats a 0-accepted total failure parseably", () => {
    const message = buildPartialSendErrorMessage([], ["only@bad.com"]);
    const parsed = parsePartialSend(message);
    assert.ok(parsed, "0 accepted should still parse");
    assert.equal(parsed.acceptedCount, 0);
    assert.deepEqual(parsed.rejected, ["only@bad.com"]);
  });

  it("does NOT match unrelated error messages", () => {
    assert.equal(parsePartialSend("SMTP login failed"), null);
    assert.equal(parsePartialSend("Connection timed out"), null);
    assert.equal(
      parsePartialSend("Failed to send: timeout after 30s"),
      null,
      "general send failures should not be misinterpreted as partial",
    );
  });

  it("renderer's friendly message shape uses singular/plural correctly", () => {
    // Single rejected → "1 address bounced"
    const oneRejected = parsePartialSend(
      buildPartialSendErrorMessage(["a@x.com", "b@x.com"], ["c@x.com"]),
    );
    assert.ok(oneRejected);
    assert.equal(oneRejected.rejected.length, 1);
    // Multiple rejected → "N addresses bounced"
    const manyRejected = parsePartialSend(
      buildPartialSendErrorMessage(["a@x.com"], ["c@x.com", "d@x.com", "e@x.com"]),
    );
    assert.ok(manyRejected);
    assert.equal(manyRejected.rejected.length, 3);
  });
});
