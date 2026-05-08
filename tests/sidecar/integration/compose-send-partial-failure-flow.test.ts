// Integration test — compose.send partial-failure end-state.
//
// Background: when SMTP accepts SOME recipients but rejects others (bad
// addresses, filter blocks, recipient policy), nodemailer surfaces this
// as a successful resolved promise with a non-empty `rejected` array.
// compose.send must NOT silently treat this as success — but it must
// also NOT lose the half-success: the message DID go out to the
// accepted set, so a SENT row must persist in the local emails table
// (otherwise the user's Sent view loses the record).
//
// Post-mortem #5 architectural-debt #5 specifically called this out as
// a flow not covered by existing tests — compose-partial-send.test.ts
// covers the error-format contract but doesn't drive compose.send
// itself. This file walks the full sequence:
//
//   1. Seed an account.
//   2. Call compose.send with a `__testHookResult` simulating a partial
//      result (1 accepted, 1 rejected) — see the COMPOSE_TEST_HOOKS
//      gate in src/methods/compose.ts.
//   3. Assert the call rejects with a parseable `partial-send: …` error
//      message AND that the rejected count is 1.
//   4. Assert the emails table has a SENT-labeled row for the
//      simulated send — proving the half-success isn't lost.
//
// The hook that makes this possible is gated by COMPOSE_TEST_HOOKS=1 +
// NODE_ENV != production, mirroring the LEARNED_RULES_TEST_HOOKS=1
// pattern in learned-rules.ts. Production binaries close this surface.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSidecar, type Harness } from "../_helpers/sidecar-process.js";
import { seedAccount } from "../_helpers/seed.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const __sidecarRequire = createRequire(resolve(__dir, "..", "..", "..", "sidecar", "package.json"));
const Database = __sidecarRequire("better-sqlite3") as typeof import("better-sqlite3");

interface EmailRow {
  id: string;
  account_id: string;
  thread_id: string;
  subject: string;
  to_address: string;
  from_address: string;
  label_ids: string | null;
  message_id: string | null;
}

const PARTIAL_SEND_RE = /^partial-send: delivered to (\d+), rejected (\d+) \(([^)]*)\)$/;

function parsePartialSend(message: string): {
  acceptedCount: number;
  rejectedCount: number;
  rejected: string[];
} | null {
  const m = message.match(PARTIAL_SEND_RE);
  if (!m) return null;
  return {
    acceptedCount: parseInt(m[1] ?? "0", 10),
    rejectedCount: parseInt(m[2] ?? "0", 10),
    rejected: (m[3] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function findSentRowsForAccount(harness: Harness, accountId: string): EmailRow[] {
  const db = new Database(harness.dbPath);
  try {
    return db
      .prepare(
        `SELECT id, account_id, thread_id, subject, to_address, from_address,
                label_ids, message_id
         FROM emails
         WHERE account_id = ? AND label_ids LIKE '%SENT%'
         ORDER BY date DESC`,
      )
      .all(accountId) as EmailRow[];
  } finally {
    db.close();
  }
}

describe("compose.send partial failure → throw + persisted SENT row", () => {
  let h: Harness;
  let accountId: string;

  before(async () => {
    h = await spawnSidecar({ env: { COMPOSE_TEST_HOOKS: "1" } });
    accountId = seedAccount(h, {
      email: "sender@example.com",
      provider: "imap",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUsername: "sender@example.com",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
    });
  });

  after(async () => {
    await h.close();
  });

  it("throws partial-send error with rejected.length === 1", async () => {
    let captured: Error | null = null;
    try {
      await h.call("compose.send", {
        accountId,
        to: ["alice@external.com", "bad@external.com"],
        subject: "Status update",
        bodyHtml: "<p>Status update body</p>",
        bodyText: "Status update body",
        // Hook: simulate SMTP delivering to alice, rejecting bad.
        __testHookResult: {
          messageId: "<msg-1@simulated>",
          accepted: ["alice@external.com"],
          rejected: ["bad@external.com"],
        },
      });
    } catch (err) {
      captured = err instanceof Error ? err : new Error(String(err));
    }

    assert.ok(captured, "compose.send must throw on partial failure");
    const parsed = parsePartialSend(captured.message);
    assert.ok(parsed, `error message must match partial-send format; got: ${captured.message}`);
    assert.equal(parsed.acceptedCount, 1);
    assert.equal(parsed.rejectedCount, 1);
    assert.equal(parsed.rejected.length, 1);
    assert.deepEqual(parsed.rejected, ["bad@external.com"]);
  });

  it("DB has the SENT-labeled row for the half-success — we don't lose the record", async () => {
    const rows = findSentRowsForAccount(h, accountId);
    assert.equal(rows.length, 1, "exactly one SENT row should exist");
    const row = rows[0]!;
    assert.equal(row.account_id, accountId);
    assert.equal(row.subject, "Status update");
    // Both addresses go into to_address — the SENT view shows the
    // intended recipient list, not the per-recipient delivery status.
    assert.match(row.to_address, /alice@external\.com/);
    assert.match(row.to_address, /bad@external\.com/);
    // The 'from' field is enriched in compose.send to the account email.
    assert.match(row.from_address, /sender@example\.com/);
    assert.equal(row.message_id, "<msg-1@simulated>");
    // label_ids is a JSON-stringified array; verify SENT is present.
    assert.ok(row.label_ids, "label_ids should be populated");
    assert.match(row.label_ids ?? "", /"SENT"/);
    // The id scheme for compose-sent rows is `sent:<accountId>:<uuid>`.
    assert.ok(
      row.id.startsWith(`sent:${accountId}:`),
      `id should be a sent: scheme prefixed with the accountId; got ${row.id}`,
    );
  });

  it("a clean send (no rejected) returns success and persists the SENT row", async () => {
    // Sanity counterpoint: same hook surface, but with empty rejected
    // — should NOT throw, and a second SENT row should land.
    const result = (await h.call("compose.send", {
      accountId,
      to: ["clean-recipient@external.com"],
      subject: "Clean send",
      bodyHtml: "<p>OK</p>",
      bodyText: "OK",
      __testHookResult: {
        messageId: "<msg-clean@simulated>",
        accepted: ["clean-recipient@external.com"],
        rejected: [],
      },
    })) as {
      id: string;
      threadId: string;
      messageId: string;
      accepted: string[];
      rejected: string[];
    };

    assert.equal(result.messageId, "<msg-clean@simulated>");
    assert.deepEqual(result.accepted, ["clean-recipient@external.com"]);
    assert.equal(result.rejected.length, 0);
    assert.ok(result.id.startsWith(`sent:${accountId}:`));

    const rows = findSentRowsForAccount(h, accountId);
    // Count grew: now both the partial and the clean send have SENT
    // rows.
    assert.equal(rows.length, 2, "second SENT row should land for the clean send");
  });

  it("a total failure (all rejected) still records a SENT row — the message left the queue", async () => {
    // This proves the bookkeeping is the same whether the rejection is
    // partial or total: any time recordSentEmail is called BEFORE the
    // throw, the local Sent view sees the row. The renderer can decide
    // to render it differently based on the error.
    let captured: Error | null = null;
    try {
      await h.call("compose.send", {
        accountId,
        to: ["all-bad-1@external.com", "all-bad-2@external.com"],
        subject: "Total fail",
        bodyHtml: "<p>doomed</p>",
        bodyText: "doomed",
        __testHookResult: {
          messageId: "<msg-total-fail@simulated>",
          accepted: [],
          rejected: ["all-bad-1@external.com", "all-bad-2@external.com"],
        },
      });
    } catch (err) {
      captured = err instanceof Error ? err : new Error(String(err));
    }
    assert.ok(captured);
    const parsed = parsePartialSend(captured.message);
    assert.ok(parsed, `error must parse; got: ${captured.message}`);
    assert.equal(parsed.acceptedCount, 0);
    assert.equal(parsed.rejectedCount, 2);

    const rows = findSentRowsForAccount(h, accountId);
    // Three SENT rows now: partial, clean, total fail.
    assert.equal(rows.length, 3, "total-fail should also have its SENT row recorded");
    const totalFailRow = rows.find((r) => r.message_id === "<msg-total-fail@simulated>");
    assert.ok(totalFailRow, "the total-fail send should have its row");
  });
});
