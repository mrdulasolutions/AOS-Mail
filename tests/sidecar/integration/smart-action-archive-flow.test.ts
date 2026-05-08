// Integration test — smart-action archive cascade.
//
// Background: when the user repeatedly archives mail the analyzer marked
// needs-reply, the learned-rules engine should bank that signal, promote
// to a domain rule at 3 observations, and from then on the analyzer
// should skip Claude entirely for incoming mail at that domain.
//
// This is the cross-feature flow that the post-mortem item #5 (architectural
// debt) called out as missing — the previous suite has unit tests for
// recordOverride and findApplicableRules in isolation, but nothing that
// walks the full sequence the way a real "Smart Action archive" UI gesture
// would.
//
// What we drive end-to-end:
//   1. Seed: 1 account + 5 emails, all analyses { needs_reply: true,
//      priority: low }, all from the same sender domain.
//   2. Drive 4 overrides via the dev-hook RPC (the production archive
//      verb requires Gmail tokens, so we bypass dispatch and exercise
//      the learning side directly — same pattern as learned-rules.test.ts).
//   3. Assert a domain rule promoted at observation #3 (count >= 3).
//   4. Drive a 5th override (5 total — well past threshold) and confirm
//      the rule's count keeps incrementing.
//   5. Verify findApplicableRules surfaces the domain rule for a fresh
//      inbound from the same domain — proving the analyzer's fast-path
//      would short-circuit on the next call (analyzeEmail wraps this same
//      lookup; we assert via the dev surface to keep the test offline).

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSidecar, type Harness } from "../_helpers/sidecar-process.js";
import { seedAccount, seedEmail, seedAnalysis } from "../_helpers/seed.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const __sidecarRequire = createRequire(resolve(__dir, "..", "..", "..", "sidecar", "package.json"));
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

interface FindApplicableMatch {
  ruleId: string;
  scope: string;
  scopeValue: string | null;
  action: string;
  count: number;
  reason: string;
}

// Count rows in `memories` table where source = priority-override. Mirrors
// what learnedRules.list reads from (just the storage angle).
function countLearnedRuleMemories(harness: Harness, accountId: string): number {
  const db = new Database(harness.dbPath);
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories
         WHERE source = 'priority-override' AND memory_type = 'analysis' AND account_id = ?`,
      )
      .get(accountId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function countDraftObservations(harness: Harness, accountId: string): number {
  const db = new Database(harness.dbPath);
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM draft_memories
         WHERE memory_type = 'analysis' AND account_id = ?`,
      )
      .get(accountId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe("smart-action archive flow → learned-rule → analyzer short-circuit", () => {
  let h: Harness;
  let accountId: string;

  before(async () => {
    h = await spawnSidecar({ env: { LEARNED_RULES_TEST_HOOKS: "1" } });
    // Touch the DB so schema is materialized before we seed via a
    // separate connection.
    await h.call("db.info");
    accountId = seedAccount(h, {
      email: "user@example.com",
      provider: "gmail",
    });
  });

  after(async () => {
    await h.close();
  });

  it("seeds 5 needs-reply emails from the same domain and walks 4 archives → rule promotes", async () => {
    // ── Seed ────────────────────────────────────────────────────────
    const emailIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = seedEmail(h, {
        accountId,
        from: `digest-${i}@newsroom.example.com`,
        subject: `Daily digest ${i}`,
      });
      seedAnalysis(h, {
        emailId: id,
        needsReply: true,
        reason: "Looks like a request",
        priority: "low",
      });
      emailIds.push(id);
    }

    // Sanity: starting state — no rule, no observation.
    assert.equal(
      countLearnedRuleMemories(h, accountId),
      0,
      "fresh account should have no priority-override memories",
    );
    assert.equal(
      countDraftObservations(h, accountId),
      0,
      "fresh account should have no draft observations",
    );

    // ── Walk 4 archives (Smart Action picks 4 of 5) ─────────────────
    // First 3 build to threshold; the 4th re-bumps an already-promoted
    // rule. We explicitly inspect the count after each one.
    for (let i = 0; i < 4; i++) {
      const result = (await h.call("learnedRules.devRecordOverride", {
        emailId: emailIds[i],
        accountId,
        action: "archived",
      })) as {
        observationCreated: boolean;
        promoted: boolean;
        memoryId: string | null;
        draftMemoryId: string;
        voteCount: number;
      };

      // First archive → fresh observation, no promotion yet.
      if (i === 0) {
        assert.equal(result.observationCreated, true, "first archive creates a draft obs");
        assert.equal(result.promoted, false, "no rule promoted at vote 1");
        assert.equal(result.voteCount, 1);
      }
      // Third archive crosses the threshold (PROMOTION_THRESHOLD = 3).
      if (i === 2) {
        assert.equal(result.promoted, true, "third archive promotes the observation to a rule");
        assert.ok(result.memoryId, "promoted result carries a memoryId");
        assert.equal(result.voteCount, 3);
      }
      // Fourth archive — rule already exists, so promoted = false but
      // voteCount keeps climbing. Confirms idempotent re-bump.
      if (i === 3) {
        assert.equal(result.promoted, false, "post-promotion bumps don't fire promoted again");
        assert.equal(result.voteCount, 4);
      }
    }

    // ── End-state assertions ────────────────────────────────────────
    // Exactly one promoted memory row for newsroom.example.com.
    const ruleMemoryCount = countLearnedRuleMemories(h, accountId);
    assert.equal(
      ruleMemoryCount,
      1,
      "expected exactly one promoted memory for newsroom.example.com",
    );
    // The draft observation is upserted (not duplicated) — one row that
    // accumulated the votes.
    assert.equal(
      countDraftObservations(h, accountId),
      1,
      "draft observation should be upserted, not duplicated",
    );

    // Rule shape via the public list surface — what the renderer's
    // Learned Rules card reads.
    const list = (await h.call("learnedRules.list", { accountId })) as { rules: RuleRow[] };
    assert.equal(list.rules.length, 1, "exactly one rule in the list");
    const rule = list.rules[0]!;
    assert.equal(rule.scope, "domain", "Claude-classify fallback yields domain scope");
    assert.equal(rule.scopeValue, "newsroom.example.com");
    assert.equal(rule.action, "archived");
    assert.equal(rule.enabled, true);
    assert.ok(rule.count >= 3, `rule.count should be ≥ 3 (got ${rule.count})`);
  });

  it("a 5th archive from the SAME domain keeps incrementing the rule's confidence", async () => {
    // Pre-state: from prior `it`, rule exists at count=4. Find it.
    const before = (await h.call("learnedRules.list", { accountId })) as { rules: RuleRow[] };
    const ruleBefore = before.rules.find(
      (r) => r.scope === "domain" && r.scopeValue === "newsroom.example.com",
    );
    assert.ok(ruleBefore, "previous test should have promoted a domain rule");
    const initialCount = ruleBefore.count;

    // Seed + record one more override.
    const newEmailId = seedEmail(h, {
      accountId,
      from: "fifth@newsroom.example.com",
      subject: "Yet another digest",
    });
    seedAnalysis(h, {
      emailId: newEmailId,
      needsReply: true,
      reason: "Direct request",
      priority: "low",
    });

    const result = (await h.call("learnedRules.devRecordOverride", {
      emailId: newEmailId,
      accountId,
      action: "archived",
    })) as { promoted: boolean; voteCount: number };

    assert.equal(result.promoted, false, "post-promotion bumps don't fire promoted again");
    assert.ok(result.voteCount > initialCount, "voteCount must advance");

    // Verify the rule's count increased on the public surface.
    const after = (await h.call("learnedRules.list", { accountId })) as { rules: RuleRow[] };
    const ruleAfter = after.rules.find(
      (r) => r.scope === "domain" && r.scopeValue === "newsroom.example.com",
    );
    assert.ok(ruleAfter);
    assert.ok(
      ruleAfter.count > initialCount,
      `count should advance past ${initialCount}, got ${ruleAfter.count}`,
    );
  });

  it("findApplicableRules returns a match for a fresh inbound at the learned domain", async () => {
    // This is the analyzer's fast-path: when a new email lands from a
    // sender at the learned domain, analyzeEmail() asks
    // findApplicableRules first, and on a hit synthesizes an
    // analysis result with source: "learned-rule" (no Claude call).
    //
    // We assert the rule lookup directly via the dev hook (the same
    // function the analyzer wraps). End-to-end behavior: given
    // confidence >= 3, a NEW email from the same domain would skip the
    // Claude call.
    const result = (await h.call("learnedRules.devFindApplicable", {
      accountId,
      from: "anyone-fresh@newsroom.example.com",
    })) as { matches: FindApplicableMatch[] };

    assert.equal(result.matches.length, 1, "expected exactly one matching rule");
    const match = result.matches[0]!;
    assert.equal(match.scope, "domain");
    assert.equal(match.scopeValue, "newsroom.example.com");
    assert.equal(match.action, "archived");
    assert.ok(match.count >= 3, "rule must be at-or-above the promotion threshold to fire");
    assert.match(match.reason, /Auto-archive|learned/i);
  });

  it("does not match an unrelated domain — rule scope is correctly limited", async () => {
    // Defense-in-depth: prove that the rule for newsroom.example.com
    // doesn't accidentally match a different domain. A misclassified
    // scope would auto-archive the user's real mail.
    const result = (await h.call("learnedRules.devFindApplicable", {
      accountId,
      from: "boss@important-company.com",
    })) as { matches: FindApplicableMatch[] };
    assert.equal(result.matches.length, 0, "unrelated domain must not match");
  });
});
