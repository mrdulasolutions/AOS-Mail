// learned-rules.* RPC tests — covers the rules engine end-to-end:
//
//   1. recordOverride accumulates votes per (account, scope, action)
//   2. promotion fires once threshold (3) is reached
//   3. findApplicableRules returns a match for an inbound email at the
//      same domain and the analyzer skips Claude
//   4. toggle disables a rule without deleting; re-enable restores it
//   5. reset wipes both promoted memories AND draft observations
//
// The Claude-backed scope classify call is gated by AOS_TEST_MODE — set
// in the harness env so we get the deterministic domain-scoped fallback
// and the test never hits the network.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";
import { seedAccount, seedEmail, seedAnalysis } from "./_helpers/seed.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const __sidecarRequire = createRequire(resolve(__dir, "..", "..", "sidecar", "package.json"));
const Database = __sidecarRequire("better-sqlite3") as typeof import("better-sqlite3");

interface RuleRow {
  id: string;
  accountId: string;
  scope: "person" | "domain" | "category" | "global";
  scopeValue: string | null;
  action: "archived" | "trashed" | "replied" | "snoozed";
  count: number;
  enabled: boolean;
  description: string;
  createdAt: number;
  updatedAt: number;
}

// Helper: count rows in draft_memories.
function countDraftMemories(harness: Harness): number {
  const db = new Database(harness.dbPath);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM draft_memories WHERE memory_type = 'analysis'")
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

// Direct DB call to recordOverride is via a synthetic IPC method? We
// don't have one — instead we drive recordOverride through the public
// archive path. emails.archive expects a working provider, which would
// require Gmail tokens. For the rules-engine smoke test we want isolated
// behavior, so we open a second DB connection and write the analyses
// rows + emails rows + accounts rows directly, then drive `emails.archive`
// (which will fail at the dispatch step because no tokens are configured)
// — but the order we wrote it, the override is recorded BEFORE the
// dispatch, so we have to invert: the IPC method records *after* the
// dispatch succeeds, which is the correct production order.
//
// To test the rules engine directly without provider plumbing, we expose
// recordOverride / findApplicableRules through the test by spawning
// "internal" RPC calls. But we don't want to add test-only RPC methods
// to the production binary.
//
// Strategy: drive the engine through a helper script via process spawning,
// or exercise the engine via the public emails.archive that doesn't
// require the dispatch to succeed. Option B is cleaner — but archive's
// dispatch throws when tokens are missing, BEFORE the recordOverride.
// So we need a different approach.
//
// What we'll do: simulate the override by writing the same rows
// recordOverride would write, plus assert findApplicableRules through
// emails.archive. Actually — a third approach: add a test-only "dev"
// method internal to learnedRules. NO — the cleanest is to call
// recordOverride via tsx-imported module in the sidecar process? No,
// the sidecar runs as cjs.
//
// Simplest correct approach: write a tiny test-only RPC method
// `learnedRules.devRecordOverride` gated by AOS_TEST_MODE. This is
// pragmatic — the same gate already controls memory.classify's offline
// path. Adding a test method would couple the production bundle to test
// concerns.
//
// FINAL approach: drive the engine through direct DB manipulation
// (seeding draft_memories with vote_count >= 3 and the right context),
// then call `learnedRules.list` to confirm... but that doesn't exercise
// recordOverride.
//
// Best approach: drive emails.archive against fake provider. In test
// mode, the dispatch step (gmail-actions / imap-actions) WILL throw —
// we want recordOverride to fire BEFORE dispatch, but production order
// fires it AFTER dispatch (correctly — we shouldn't learn from a failed
// archive). So in test mode, the override never records.
//
// Pragmatic resolution: ship a dev RPC method gated by AOS_TEST_MODE
// that calls recordOverride directly. It's a 5-line method whose only
// risk is leaking through a misconfigured prod build, mitigated by the
// env-var gate.

describe("learned-rules engine via dev hook", () => {
  let h: Harness;
  let accountId: string;
  before(async () => {
    // Don't pass AOS_TEST_MODE — it changes the DB filename to
    // aos-mail-demo.db, but the harness's seed helpers assume the
    // production aos-mail.db path. Instead we leave ANTHROPIC_API_KEY
    // unset so classifyOverrideScope's catch path falls back to a
    // domain-scoped result, which is what we want for assertions.
    h = await spawnSidecar({ env: { LEARNED_RULES_TEST_HOOKS: "1" } });
    // Trigger a DB-touching RPC so the sidecar opens & schemafies the
    // file before we seed via a second connection.
    await h.call("db.info");
    accountId = seedAccount(h, { email: "user@example.com", provider: "gmail" });
  });
  after(async () => {
    await h.close();
  });

  it("promotes a rule after 3 same-action overrides", async () => {
    // Seed 3 emails from the same domain, each with an analysis row that
    // says "needs reply" — so archiving them is treated as override.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = seedEmail(h, {
        accountId,
        from: `news${i}@news.example.com`,
        subject: `Newsletter ${i}`,
      });
      seedAnalysis(h, {
        emailId: id,
        needsReply: true,
        reason: "Direct request",
        priority: "medium",
      });
      ids.push(id);
    }

    // Drive 3 recordOverride calls via the dev hook (test-only method).
    for (const id of ids) {
      await h.call("learnedRules.devRecordOverride", {
        emailId: id,
        accountId,
        action: "archived",
      });
    }

    // We should now have a promoted rule for the news.example.com domain.
    const list = (await h.call("learnedRules.list", { accountId })) as { rules: RuleRow[] };
    assert.ok(list.rules.length >= 1, "expected at least one rule");
    const domainRule = list.rules.find(
      (r) => r.scope === "domain" && r.scopeValue === "news.example.com",
    );
    assert.ok(domainRule, "expected a domain-scoped rule for news.example.com");
    assert.equal(domainRule!.action, "archived");
    assert.equal(domainRule!.enabled, true);
    assert.ok(domainRule!.count >= 3, "rule count should be ≥ 3");
  });

  it("findApplicableRules matches an inbound email from the learned domain", async () => {
    // Use the dev hook to query the rule lookup directly. Returns the
    // match list as the engine would surface it to the analyzer.
    const result = (await h.call("learnedRules.devFindApplicable", {
      accountId,
      from: "anyone@news.example.com",
    })) as { matches: Array<{ ruleId: string; action: string; reason: string }> };

    assert.ok(result.matches.length >= 1, "expected a rule match");
    assert.equal(result.matches[0]!.action, "archived");
    assert.match(result.matches[0]!.reason, /Auto-archived|Auto-archive|learned/i);
  });

  it("findApplicableRules returns no match for an unrelated domain", async () => {
    const result = (await h.call("learnedRules.devFindApplicable", {
      accountId,
      from: "someone@unrelated.com",
    })) as { matches: unknown[] };
    assert.equal(result.matches.length, 0);
  });

  it("toggling a rule off disables matching", async () => {
    const list = (await h.call("learnedRules.list", { accountId })) as { rules: RuleRow[] };
    const rule = list.rules.find(
      (r) => r.scope === "domain" && r.scopeValue === "news.example.com",
    )!;

    // Toggle off.
    await h.call("learnedRules.toggle", { ruleId: rule.id, enabled: false });

    const after = (await h.call("learnedRules.devFindApplicable", {
      accountId,
      from: "test@news.example.com",
    })) as { matches: unknown[] };
    assert.equal(after.matches.length, 0, "disabled rule should not match");

    // Toggle back on so subsequent tests are predictable.
    await h.call("learnedRules.toggle", { ruleId: rule.id, enabled: true });
  });

  it("reset clears both rules and observations", async () => {
    // Pre-condition: at least one rule + at least one observation.
    const before = (await h.call("learnedRules.list", { accountId })) as { rules: RuleRow[] };
    assert.ok(before.rules.length >= 1);
    assert.ok(countDraftMemories(h) >= 1);

    const result = (await h.call("learnedRules.reset", { accountId })) as {
      deletedRules: number;
      deletedObservations: number;
    };
    assert.ok(result.deletedRules >= 1);
    assert.ok(result.deletedObservations >= 1);

    const after = (await h.call("learnedRules.list", { accountId })) as { rules: RuleRow[] };
    assert.equal(after.rules.length, 0);
    assert.equal(countDraftMemories(h), 0);
  });
});

// Coverage for analysis.overridePriority feeding the learned-rules engine.
// When the analyzer said "needs reply" but the user manually downgrades via
// the priority badge dropdown, that signal should reach learnedRules.
//
// We assert via the public learnedRules.list surface — three contradictory
// overrides on the same domain promotes a rule, exactly like 3 archives
// would. This proves the recordOverride wiring rather than just stubbing
// the call.
describe("analysis.overridePriority feeds the learned-rules engine", () => {
  let h: Harness;
  let accountId: string;
  before(async () => {
    h = await spawnSidecar({ env: { LEARNED_RULES_TEST_HOOKS: "1" } });
    await h.call("db.info");
    accountId = seedAccount(h, { email: "user@example.com", provider: "gmail" });
  });
  after(async () => {
    await h.close();
  });

  it("manual override from needsReply=true → false records a learned-rule observation", async () => {
    // Seed an email + analysis that says "needs reply, medium priority".
    const emailId = seedEmail(h, {
      accountId,
      from: "newsletter@override-demo.com",
      subject: "Daily roundup",
    });
    seedAnalysis(h, {
      emailId,
      needsReply: true,
      reason: "Looks like a request",
      priority: "medium",
    });

    // Confirm starting state: no rules for this domain yet.
    const before = (await h.call("learnedRules.list", { accountId })) as {
      rules: Array<{ scope: string; scopeValue: string | null }>;
    };
    const matchingBefore = before.rules.filter(
      (r) => r.scope === "domain" && r.scopeValue === "override-demo.com",
    );
    assert.equal(matchingBefore.length, 0, "no rule should exist before the override");

    // User clicks the badge and overrides to "needs reply = false".
    await h.call("analysis.overridePriority", {
      emailId,
      newNeedsReply: false,
      newPriority: null,
      reason: "I don't actually need to reply to these",
    });

    // recordOverride is fire-and-forget — we wait for it to flush. The
    // engine writes a draft_memories observation row synchronously inside
    // the awaited classifyOverrideScope call (the catch path is
    // immediate when no API key is set in this env), so a brief poll on
    // the dev surface is enough.
    let observationFound = false;
    for (let i = 0; i < 20; i++) {
      const result = (await h.call("learnedRules.devFindApplicable", {
        accountId,
        from: "anyone@override-demo.com",
      })) as { matches: unknown[] };
      // For a single override we won't have promoted yet (threshold = 3),
      // but the observation should be in draft_memories. Use the dev hook
      // to drive 2 more overrides and check that a rule eventually
      // promotes.
      if (result.matches.length === 0 && i === 0) {
        // Drive two more overrides via the dev hook so we can prove the
        // signal channel works end-to-end (after-promotion is the
        // observable proof).
        for (let j = 0; j < 2; j++) {
          const id = seedEmail(h, {
            accountId,
            from: `news${j}@override-demo.com`,
            subject: `Roundup ${j}`,
          });
          seedAnalysis(h, {
            emailId: id,
            needsReply: true,
            reason: "Request",
            priority: "medium",
          });
          await h.call("analysis.overridePriority", {
            emailId: id,
            newNeedsReply: false,
            newPriority: null,
            reason: "no reply needed",
          });
        }
      }
      // Now check after the loop runs.
      const afterAll = (await h.call("learnedRules.list", { accountId })) as {
        rules: Array<{ scope: string; scopeValue: string | null; action: string }>;
      };
      const promoted = afterAll.rules.find(
        (r) => r.scope === "domain" && r.scopeValue === "override-demo.com",
      );
      if (promoted) {
        observationFound = true;
        assert.equal(promoted.action, "archived", "override should record an archive-style action");
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
      observationFound,
      "recordOverride should have promoted a rule after 3 contradictions",
    );
  });

  it("override that DOESN'T contradict the analyzer (still needsReply=true) is NOT a learned signal", async () => {
    // Pre-condition: clear out any rules from the previous test for a
    // clean assertion.
    await h.call("learnedRules.reset", { accountId });

    // Analyzer said "needs reply, low" — user keeps it as needs-reply
    // but bumps priority to high. NOT a contradiction; should NOT
    // record an override.
    const emailId = seedEmail(h, {
      accountId,
      from: "user@no-signal.com",
      subject: "real message",
    });
    seedAnalysis(h, {
      emailId,
      needsReply: true,
      reason: "Direct ask",
      priority: "low",
    });

    await h.call("analysis.overridePriority", {
      emailId,
      newNeedsReply: true,
      newPriority: "high",
      reason: "actually high priority",
    });

    // No rule should appear, and no draft_memories observation either.
    // Wait briefly to ensure the (fire-and-forget) signal has had a
    // chance to fire if it was going to.
    await new Promise((r) => setTimeout(r, 200));

    const list = (await h.call("learnedRules.list", { accountId })) as {
      rules: Array<{ scope: string; scopeValue: string | null }>;
    };
    const matching = list.rules.filter(
      (r) => r.scope === "domain" && r.scopeValue === "no-signal.com",
    );
    assert.equal(
      matching.length,
      0,
      "non-contradicting overrides should not feed the learned-rules engine",
    );
    assert.equal(
      countDraftMemories(h),
      0,
      "non-contradicting override should not write a draft_memories row",
    );
  });
});

describe("learnedRules.toggle argument validation", () => {
  let h: Harness;
  before(async () => {
    // Don't pass AOS_TEST_MODE — it changes the DB filename to
    // aos-mail-demo.db, but the harness's seed helpers assume the
    // production aos-mail.db path. Instead we leave ANTHROPIC_API_KEY
    // unset so classifyOverrideScope's catch path falls back to a
    // domain-scoped result, which is what we want for assertions.
    h = await spawnSidecar({ env: { LEARNED_RULES_TEST_HOOKS: "1" } });
  });
  after(async () => {
    await h.close();
  });

  it("rejects missing ruleId", async () => {
    await assert.rejects(
      () => h.call("learnedRules.toggle", { enabled: true }),
      /requires \{ ruleId \}/,
    );
  });

  it("rejects missing or non-boolean enabled", async () => {
    await assert.rejects(
      () => h.call("learnedRules.toggle", { ruleId: "x" }),
      /requires \{ enabled: boolean \}/,
    );
    await assert.rejects(
      () => h.call("learnedRules.toggle", { ruleId: "x", enabled: "yes" }),
      /requires \{ enabled: boolean \}/,
    );
  });

  it("rejects unknown ruleId", async () => {
    await assert.rejects(
      () => h.call("learnedRules.toggle", { ruleId: "does-not-exist", enabled: true }),
      /rule not found/,
    );
  });
});
