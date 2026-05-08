// Pure-function tests for the per-feature model resolver.
//
// Doesn't go through the sidecar harness — `resolveModelFor` is a pure
// read of `preferences.json` plus a static defaults table, so we exercise
// it in-process. We swap AOS_MAIL_DATA_DIR to a fresh tmp directory at
// the very top of the file (before any sidecar import touches the FS),
// then drive the cache via `setPreference` (which updates both disk and
// the in-memory cache atomically).
//
// Coverage:
//   1. Defaults — every feature returns its hard-coded default when
//      preferences are empty.
//   2. Tier translation — "haiku" / "sonnet" / "opus" resolve to the
//      concrete Claude ids the rest of the sidecar uses.
//   3. Pass-through — concrete OpenRouter and Claude ids round-trip
//      unchanged.
//   4. Refinement fallback — `refinement` inherits `drafts` when its own
//      key is unset (preserves prior behavior of the old resolveRefineModel
//      helper).
//   5. Classify fallback — `classify` inherits `summary` when its own key
//      is unset (preserves prior behavior of the old resolveClassifyModel
//      helper in learned-rules.ts).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// CRITICAL: AOS_MAIL_DATA_DIR must be set BEFORE any sidecar import that
// might call getDataDir(). Static imports below pick it up via env-var
// reads inside getDataDir(), and the preferences module's cache only
// loads on first access (which happens inside the test bodies).
const TMP_DIR = mkdtempSync(join(tmpdir(), "aos-mail-resolver-test-"));
process.env.AOS_MAIL_DATA_DIR = TMP_DIR;
writeFileSync(join(TMP_DIR, "preferences.json"), "{}");

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setPreference } from "../../sidecar/src/lib/preferences.js";
import { resolveModelFor } from "../../sidecar/src/services/model-config.js";

after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("resolveModelFor — defaults (empty modelConfig)", () => {
  before(() => {
    setPreference("modelConfig", undefined);
  });

  it("analysis defaults to Sonnet", () => {
    assert.equal(resolveModelFor("analysis"), "claude-sonnet-4-5-20250929");
  });
  it("drafts defaults to Sonnet", () => {
    assert.equal(resolveModelFor("drafts"), "claude-sonnet-4-5-20250929");
  });
  it("refinement defaults to Sonnet", () => {
    assert.equal(resolveModelFor("refinement"), "claude-sonnet-4-5-20250929");
  });
  it("summary defaults to Haiku (cost-optimized extraction)", () => {
    assert.equal(resolveModelFor("summary"), "claude-haiku-4-5-20251001");
  });
  it("archiveReady defaults to Sonnet", () => {
    assert.equal(resolveModelFor("archiveReady"), "claude-sonnet-4-5-20250929");
  });
  it("senderLookup defaults to Sonnet (best web_search citation behavior)", () => {
    assert.equal(resolveModelFor("senderLookup"), "claude-sonnet-4-5-20250929");
  });
  it("classify defaults to Haiku", () => {
    assert.equal(resolveModelFor("classify"), "claude-haiku-4-5-20251001");
  });
  it("agentDrafter defaults to Sonnet", () => {
    assert.equal(resolveModelFor("agentDrafter"), "claude-sonnet-4-5-20250929");
  });
  it("agentChat defaults to Opus", () => {
    assert.equal(resolveModelFor("agentChat"), "claude-opus-4-20250514");
  });
});

describe("resolveModelFor — legacy tier-name translation", () => {
  it('translates "haiku" to the concrete Haiku id', () => {
    setPreference("modelConfig", { analysis: "haiku" });
    assert.equal(resolveModelFor("analysis"), "claude-haiku-4-5-20251001");
  });

  it('translates "sonnet" to the concrete Sonnet id', () => {
    setPreference("modelConfig", { summary: "sonnet" });
    assert.equal(resolveModelFor("summary"), "claude-sonnet-4-5-20250929");
  });

  it('translates "opus" to the concrete Opus id', () => {
    setPreference("modelConfig", { drafts: "opus" });
    assert.equal(resolveModelFor("drafts"), "claude-opus-4-20250514");
  });
});

describe("resolveModelFor — concrete ids pass through", () => {
  it("Anthropic concrete ids round-trip unchanged", () => {
    setPreference("modelConfig", { analysis: "claude-sonnet-4-5-20250929" });
    assert.equal(resolveModelFor("analysis"), "claude-sonnet-4-5-20250929");
  });

  it("OpenRouter ids pass through (the router handles dispatch)", () => {
    setPreference("modelConfig", { analysis: "openai/gpt-4o-mini" });
    assert.equal(resolveModelFor("analysis"), "openai/gpt-4o-mini");
  });

  it("trims whitespace before pass-through", () => {
    setPreference("modelConfig", { analysis: "  openai/gpt-4o-mini  " });
    assert.equal(resolveModelFor("analysis"), "openai/gpt-4o-mini");
  });

  it("empty / non-string values fall through to the default", () => {
    setPreference("modelConfig", { analysis: "" });
    assert.equal(resolveModelFor("analysis"), "claude-sonnet-4-5-20250929");
    setPreference("modelConfig", { analysis: 42 });
    assert.equal(resolveModelFor("analysis"), "claude-sonnet-4-5-20250929");
  });
});

describe("resolveModelFor — refinement falls through to drafts", () => {
  it("refinement uses drafts when refinement key is unset", () => {
    setPreference("modelConfig", { drafts: "claude-haiku-4-5-20251001" });
    assert.equal(resolveModelFor("refinement"), "claude-haiku-4-5-20251001");
  });

  it("refinement uses its own key when set, ignoring drafts", () => {
    setPreference("modelConfig", {
      drafts: "claude-haiku-4-5-20251001",
      refinement: "claude-opus-4-20250514",
    });
    assert.equal(resolveModelFor("refinement"), "claude-opus-4-20250514");
  });

  it("refinement falls through to its default when both keys are unset", () => {
    setPreference("modelConfig", {});
    assert.equal(resolveModelFor("refinement"), "claude-sonnet-4-5-20250929");
  });
});

describe("resolveModelFor — classify falls through to summary", () => {
  // Preserves the prior behavior of resolveClassifyModel in learned-rules.ts:
  // the user-facing settings only expose `summary`, not `classify`, so
  // classify-the-feature should follow whatever the user set for summary.

  it("classify uses summary when classify key is unset", () => {
    setPreference("modelConfig", { summary: "claude-sonnet-4-5-20250929" });
    assert.equal(resolveModelFor("classify"), "claude-sonnet-4-5-20250929");
  });

  it("classify uses its own key when set, ignoring summary", () => {
    setPreference("modelConfig", {
      summary: "claude-sonnet-4-5-20250929",
      classify: "openai/gpt-4o-mini",
    });
    assert.equal(resolveModelFor("classify"), "openai/gpt-4o-mini");
  });

  it("legacy summary tier name still flows through to classify", () => {
    setPreference("modelConfig", { summary: "haiku" });
    assert.equal(resolveModelFor("classify"), "claude-haiku-4-5-20251001");
  });
});

describe("resolveModelFor — mixed prefs resolve independently", () => {
  it("matches the smoke-test scenario (legacy summary tier + raw OpenRouter analysis)", () => {
    setPreference("modelConfig", {
      summary: "haiku",
      analysis: "openai/gpt-4o-mini",
    });
    assert.equal(resolveModelFor("summary"), "claude-haiku-4-5-20251001");
    assert.equal(resolveModelFor("analysis"), "openai/gpt-4o-mini");
  });

  it("a non-modelConfig prefs payload doesn't break anything", () => {
    setPreference("modelConfig", undefined);
    setPreference("theme", "dark");
    assert.equal(resolveModelFor("analysis"), "claude-sonnet-4-5-20250929");
  });
});

describe("resolveModelFor — non-object modelConfig is tolerated", () => {
  // Preferences is open-shape, so a malformed payload from a manual edit
  // shouldn't crash the resolver — fall through to defaults.
  it("ignores a non-object modelConfig", () => {
    setPreference("modelConfig", "not an object");
    assert.equal(resolveModelFor("analysis"), "claude-sonnet-4-5-20250929");
  });

  it("ignores a null modelConfig", () => {
    setPreference("modelConfig", null);
    assert.equal(resolveModelFor("analysis"), "claude-sonnet-4-5-20250929");
  });
});
