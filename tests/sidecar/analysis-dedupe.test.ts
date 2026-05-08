// analysis.* RPC dedupe + override-tracking tests.
//
// Boot fan-out (P3 #16): the renderer fires analyzeBatch from two parallel
// triage paths on first launch. Without dedupe we'd run two Claude calls
// per email. We pin the freshness short-circuit by:
//   1. Seeding an analysis row directly into the DB
//   2. Calling `analysis.analyze` for that emailId
//   3. Asserting we got the seeded result back even though no API key /
//      Anthropic mock is configured — which is only possible via the
//      cache short-circuit.
//
// If P3 #16 regresses, this test fails because analyzeOne reaches
// analyzeEmail() which tries to talk to Anthropic and throws.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";
import { seedAccount, seedEmail, seedAnalysis } from "./_helpers/seed.js";

interface AnalysisResultPayload {
  needsReply: boolean;
  reason: string;
  priority: "high" | "medium" | "low" | null;
}

describe("analysis dedupe (P3 #16)", () => {
  let harness: Harness;
  let accountId: string;
  let emailId: string;

  before(async () => {
    harness = await spawnSidecar();
    accountId = seedAccount(harness, { email: "user@example.com" });
    emailId = seedEmail(harness, {
      accountId,
      from: "alice@example.com",
      subject: "hi",
      body: "hello world",
    });
  });

  after(async () => {
    await harness.close();
  });

  it("returns the cached analysis when one is fresh", async () => {
    seedAnalysis(harness, {
      emailId,
      needsReply: true,
      reason: "Cached signal",
      priority: "high",
      analyzedAt: Date.now(), // fresh
    });

    // No Anthropic mock — if the dedupe short-circuit doesn't fire,
    // analyzeEmail() will try to call the API and the call fails.
    const result = (await harness.call("analysis.analyze", {
      emailId,
    })) as AnalysisResultPayload;

    assert.equal(result.needsReply, true);
    assert.equal(result.reason, "Cached signal");
    assert.equal(result.priority, "high");
  });

  it("does not short-circuit when the cached row is stale", async () => {
    // Stale = older than the 6-hour freshness window.
    const stale = Date.now() - 7 * 60 * 60 * 1000;
    seedAnalysis(harness, {
      emailId,
      needsReply: false,
      reason: "Stale signal",
      priority: undefined,
      analyzedAt: stale,
    });

    // Now the analyze call should fall through and try to hit Anthropic
    // (no key configured in the test harness, so it errors). We only
    // need to assert it threw — that proves we passed the cache gate.
    await assert.rejects(
      harness.call("analysis.analyze", { emailId }),
      // The exact error depends on the Anthropic SDK; we just want any
      // rejection to confirm we didn't return the stale row.
      /.+/,
    );
  });
});
