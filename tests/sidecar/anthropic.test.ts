// anthropic.* RPC smoke tests — focused on the boot-triage gate semantics.
//
// `anthropic.hasAnyLlmProvider` is the gate the boot triage uses to decide
// whether to fire analyzeBatch. Bug it covers: pre-rebuild, the gate was
// `anthropic.hasApiKey` which only knew about the Anthropic key — users
// who only configured an OpenRouter key got an empty Priority tab forever.
// The new gate accepts EITHER provider; this test pins that contract.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";

interface AnyProviderResult {
  configured: boolean;
  anthropic: boolean;
  openrouter: boolean;
}

interface SimpleApiKeyResult {
  ok: true;
}

describe("anthropic.hasAnyLlmProvider — empty config", () => {
  let h: Harness;
  before(async () => {
    // Fresh data dir, no env keys (the harness clears those by default
    // for the fresh tmp NODE_ENV=test process).
    h = await spawnSidecar({
      env: {
        ANTHROPIC_API_KEY: "",
        OPENROUTER_API_KEY: "",
      },
    });
  });
  after(async () => {
    await h.close();
  });

  it("returns configured: false on a fresh data dir with no env keys", async () => {
    const result = await h.call<AnyProviderResult>("anthropic.hasAnyLlmProvider", {});
    assert.equal(result.configured, false);
    assert.equal(result.anthropic, false);
    assert.equal(result.openrouter, false);
  });
});

describe("anthropic.hasAnyLlmProvider — accepts OpenRouter alone", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar({
      env: {
        ANTHROPIC_API_KEY: "",
        OPENROUTER_API_KEY: "",
      },
    });
  });
  after(async () => {
    await h.close();
  });

  it("returns configured: true when only the OpenRouter key is set in prefs", async () => {
    // Pre-condition: nothing configured.
    let result = await h.call<AnyProviderResult>("anthropic.hasAnyLlmProvider", {});
    assert.equal(result.configured, false);

    // Set OpenRouter key only.
    await h.call<SimpleApiKeyResult>("openrouter.setApiKey", { apiKey: "sk-or-test-only" });

    result = await h.call<AnyProviderResult>("anthropic.hasAnyLlmProvider", {});
    assert.equal(result.configured, true, "OpenRouter alone should flip the gate");
    assert.equal(result.anthropic, false);
    assert.equal(result.openrouter, true);

    // anthropic.hasApiKey (the narrower, Anthropic-only gate) should
    // still return false. This is the audit guarantee: surfaces that
    // explicitly need Anthropic don't see OpenRouter as a substitute.
    const narrow = await h.call<{ configured: boolean }>("anthropic.hasApiKey", {});
    assert.equal(narrow.configured, false);
  });
});

describe("anthropic.hasAnyLlmProvider — accepts Anthropic alone", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar({
      env: {
        ANTHROPIC_API_KEY: "",
        OPENROUTER_API_KEY: "",
      },
    });
  });
  after(async () => {
    await h.close();
  });

  it("returns configured: true when only the Anthropic key is set in prefs", async () => {
    await h.call<SimpleApiKeyResult>("anthropic.setApiKey", { apiKey: "sk-ant-test-only" });

    const result = await h.call<AnyProviderResult>("anthropic.hasAnyLlmProvider", {});
    assert.equal(result.configured, true);
    assert.equal(result.anthropic, true);
    assert.equal(result.openrouter, false);
  });
});

describe("anthropic.hasAnyLlmProvider — env-var path", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar({
      env: {
        ANTHROPIC_API_KEY: "sk-ant-from-env",
        OPENROUTER_API_KEY: "",
      },
    });
  });
  after(async () => {
    await h.close();
  });

  it("env-set ANTHROPIC_API_KEY flips the gate without any prefs writes", async () => {
    const result = await h.call<AnyProviderResult>("anthropic.hasAnyLlmProvider", {});
    assert.equal(result.configured, true);
    assert.equal(result.anthropic, true);
    assert.equal(result.openrouter, false);
  });
});
