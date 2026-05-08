// IMAP unarchive smoke tests.
//
// Bug fix this covers: pre-rebuild, unarchiveMessage on an IMAP id always
// threw "not yet implemented" / "requires destination UID tracking",
// breaking the smart-action 5s undo on every IMAP account.
//
// What we can pin without a real IMAP server: the function no longer
// throws the old "not implemented" message, the dispatcher routes to the
// IMAP path (not Gmail), and it reports a clean "no archive-tracking row"
// error when called for a message we never archived. The full archive →
// undo loop needs an IMAP test server — out of scope here, covered by
// future integration tests against greenmail / dovecot in CI.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";
import { seedAccount } from "./_helpers/seed.js";

describe("emails.unarchive on IMAP — no longer hard-throws 'not implemented'", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("rejects with a clear 'no archive-tracking row' error rather than 'not implemented'", async () => {
    const accountId = seedAccount(h, { email: "u@example.com", provider: "imap" });

    // No archive ever ran for this id, so unarchive looks up the tracking
    // table, finds nothing, and throws cleanly. Crucially the error must
    // NOT be the old "not yet implemented" / "destination UID tracking"
    // line — that's the regression this test pins against.
    await assert.rejects(
      () =>
        h.call("emails.unarchive", {
          emailId: `imap:${accountId}:INBOX:42`,
          accountId,
        }),
      (err: Error) => {
        assert.ok(
          !/not yet implemented/i.test(err.message),
          `unarchive should not surface 'not implemented'; got: ${err.message}`,
        );
        assert.ok(
          /no archive-tracking row|cannot reverse move/i.test(err.message),
          `expected 'no archive-tracking row' diagnostic, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("rejects unknown id schemes the same way other emails verbs do", async () => {
    await assert.rejects(
      () => h.call("emails.unarchive", { emailId: "weird:format:1" }),
      /unknown email id scheme/,
    );
  });

  it("requires emailId", async () => {
    await assert.rejects(() => h.call("emails.unarchive", {}), /requires \{ emailId \}/);
  });
});
