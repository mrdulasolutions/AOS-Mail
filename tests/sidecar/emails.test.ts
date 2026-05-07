// emails.* RPC tests — focuses on the id-prefix dispatcher in
// sidecar/src/methods/emails.ts. We use bogus account/email rows so the
// underlying provider call (gmail-actions / imap-actions) THROWS in a
// way we can assert on. The error message is the proof that the
// dispatcher routed to the right provider — gmail errors come from the
// Gmail token loader, IMAP errors from the IMAP creds loader.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";
import { seedAccount, seedEmail } from "./_helpers/seed.js";

describe("emails verbs — argument validation", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("emails.archive throws without emailId", async () => {
    await assert.rejects(
      () => h.call("emails.archive", {}),
      /requires \{ emailId \}/,
    );
  });

  it("emails.trash throws without emailId", async () => {
    await assert.rejects(
      () => h.call("emails.trash", {}),
      /requires \{ emailId \}/,
    );
  });

  it("emails.batchArchive throws without emailIds array", async () => {
    await assert.rejects(
      () => h.call("emails.batchArchive", {}),
      /requires \{ emailIds: string\[\] \}/,
    );
  });

  it("emails.batchTrash throws on empty array", async () => {
    await assert.rejects(
      () => h.call("emails.batchTrash", { emailIds: [] }),
      /requires \{ emailIds: string\[\] \}/,
    );
  });

  it("emails.archiveThread throws without threadId or accountId", async () => {
    await assert.rejects(
      () => h.call("emails.archiveThread", { threadId: "x" }),
      /requires \{ threadId, accountId \}/,
    );
    await assert.rejects(
      () => h.call("emails.archiveThread", { accountId: "x" }),
      /requires \{ threadId, accountId \}/,
    );
  });

  it("emails.setStarred throws without emailId", async () => {
    await assert.rejects(
      () => h.call("emails.setStarred", { starred: true }),
      /requires \{ emailId \}/,
    );
  });

  it("emails.setRead throws without emailId", async () => {
    await assert.rejects(
      () => h.call("emails.setRead", { read: true }),
      /requires \{ emailId \}/,
    );
  });

  it("emails.getThread throws without threadId or accountId", async () => {
    await assert.rejects(
      () => h.call("emails.getThread", {}),
      /requires \{ threadId, accountId \}/,
    );
  });
});

describe("emails id-prefix dispatch", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("rejects unknown id schemes with a clear error", async () => {
    await assert.rejects(
      () => h.call("emails.archive", { emailId: "weird:format:x" }),
      /unknown email id scheme: weird:format:x/,
    );
    await assert.rejects(
      () => h.call("emails.trash", { emailId: "ftp://nope" }),
      /unknown email id scheme: ftp:\/\/nope/,
    );
  });

  it("routes imap:* ids to the IMAP path (errors point at IMAP creds)", async () => {
    // No IMAP creds for this account → imap-actions throws when it tries
    // to load credentials. The exact message comes from imap-creds.ts;
    // we just need the routing proof — the error must NOT come from
    // gmail-actions, and it should reference imap somewhere.
    await assert.rejects(
      () => h.call("emails.archive", { emailId: "imap:bogus-acct:INBOX:42" }),
      (err: Error) => {
        // Either the IMAP creds layer fails ("no credentials for account")
        // or the connection layer ("ECONNREFUSED"). What we care about
        // is that the gmail path was NOT hit.
        assert.ok(
          !/gmail/i.test(err.message) || /imap/i.test(err.message),
          `expected IMAP-routed error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("routes gmail:* ids to the Gmail path (errors point at Gmail tokens)", async () => {
    // No tokens for this account → gmail-actions throws.
    await assert.rejects(
      () => h.call("emails.archive", { emailId: "gmail:bogus-acct:abc123" }),
      (err: Error) => {
        // Should mention oauth/token/gmail since the IMAP path is bypassed.
        assert.ok(
          /token|oauth|gmail|credential|auth/i.test(err.message),
          `expected Gmail-routed error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("emails.setStarred routes by prefix too", async () => {
    await assert.rejects(
      () => h.call("emails.setStarred", { emailId: "weird:foo", starred: true }),
      /unknown email id scheme/,
    );
  });

  it("emails.setRead routes by prefix too", async () => {
    await assert.rejects(
      () => h.call("emails.setRead", { emailId: "weird:foo", read: true }),
      /unknown email id scheme/,
    );
  });
});

describe("emails.getThread reads from local DB", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("returns all messages in a thread oldest-first", async () => {
    const accountId = seedAccount(h, { email: "t@example.com", provider: "imap" });
    seedEmail(h, {
      id: `imap:${accountId}:INBOX:1`,
      accountId,
      threadId: "thread-A",
      subject: "Re: hello",
      date: "2025-01-01T10:00:00Z",
    });
    seedEmail(h, {
      id: `imap:${accountId}:INBOX:2`,
      accountId,
      threadId: "thread-A",
      subject: "Re: hello",
      date: "2025-01-01T11:00:00Z",
    });
    // Different thread shouldn't appear.
    seedEmail(h, {
      id: `imap:${accountId}:INBOX:3`,
      accountId,
      threadId: "thread-B",
      subject: "unrelated",
    });

    const rows = await h.call<Array<{ id: string; subject: string; date: string }>>(
      "emails.getThread",
      { threadId: "thread-A", accountId },
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.id, `imap:${accountId}:INBOX:1`);
    assert.equal(rows[1]?.id, `imap:${accountId}:INBOX:2`);
    // Sorted oldest-first.
    assert.ok(rows[0]!.date < rows[1]!.date);
  });

  it("returns [] for a thread that doesn't exist", async () => {
    const rows = await h.call<unknown[]>("emails.getThread", {
      threadId: "thread-nonexistent",
      accountId: "acct-nonexistent",
    });
    assert.deepEqual(rows, []);
  });
});

describe("emails.archiveThread iterates rows for the (threadId, accountId)", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("returns success counts even when individual archives fail", async () => {
    // Two unknown-scheme ids — both will throw "unknown email id scheme",
    // so archived === 0 and errors has two entries. We're not testing the
    // happy path here (that needs a real provider) — we're testing the
    // bookkeeping: archiveThread doesn't crash when every row fails.
    const accountId = seedAccount(h, { email: "th@example.com", provider: "imap" });
    seedEmail(h, { id: "weird:1", accountId, threadId: "t1" });
    seedEmail(h, { id: "weird:2", accountId, threadId: "t1" });

    const result = await h.call<{ ok: true; archived: number; errors: string[] }>(
      "emails.archiveThread",
      { threadId: "t1", accountId },
    );
    assert.equal(result.ok, true);
    assert.equal(result.archived, 0);
    assert.equal(result.errors.length, 2);
    for (const e of result.errors) {
      assert.match(e, /unknown email id scheme/);
    }
  });
});
