// Settings RPC tests — covers the generic preferences passthrough plus the
// EA / prompts subobjects. The sidecar's settings.set is intentionally
// untyped: it accepts any patch and writes it through to preferences.json.
// These tests pin that behavior down so a future ConfigSchema migration
// can't silently drop fields the renderer relies on.
//
// Note (post p2-keychain): secret values (anthropicApiKey, openRouterApiKey,
// googleClientId, googleClientSecret) are no longer in preferences.json.
// They live in the in-memory secrets store, backed by the OS Keychain via
// the renderer. settings.get returns boolean `hasAnthropicApiKey` etc. so
// the UI can render its "configured" badges without the secret value
// crossing the wire.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";

interface OkResult {
  ok: true;
}

interface EAConfig {
  enabled: boolean;
  name: string;
  email: string;
}

describe("settings.get / settings.set roundtrip", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("returns only the secret-presence flags on a fresh data dir", async () => {
    const prefs = await h.call<Record<string, unknown>>("settings.get");
    assert.equal(typeof prefs, "object");
    assert.equal(prefs === null, false);
    // Fresh prefs file is empty — settings.get layers the secret-presence
    // flags on top so the renderer can render "configured" badges. None
    // of the secrets are set on a fresh data dir.
    assert.deepEqual(prefs, {
      hasAnthropicApiKey: false,
      hasOpenRouterApiKey: false,
      hasGoogleCredentials: false,
    });
  });

  it("persists a single primitive key (theme)", async () => {
    await h.call<OkResult>("settings.set", { theme: "dark" });
    const prefs = await h.call<Record<string, unknown>>("settings.get");
    assert.equal(prefs.theme, "dark");
  });

  it("persists nested objects (mcpServers, agentBrowser, ea, cliTools)", async () => {
    // The renderer ships several "blob" preferences whose internal shape
    // changes faster than the ConfigSchema. settings.set must round-trip
    // them losslessly.
    const patch = {
      mcpServers: [
        { name: "github", url: "https://github.example/mcp" },
        { name: "linear", url: "https://linear.example/mcp" },
      ],
      agentBrowser: { profile: "default", headless: true, allowDownloads: false },
      cliTools: ["gh", "kubectl"],
      extraPathDirs: ["/usr/local/bin", "/opt/homebrew/bin"],
    };
    await h.call<OkResult>("settings.set", patch);
    const prefs = await h.call<Record<string, unknown>>("settings.get");
    assert.deepEqual(prefs.mcpServers, patch.mcpServers);
    assert.deepEqual(prefs.agentBrowser, patch.agentBrowser);
    assert.deepEqual(prefs.cliTools, patch.cliTools);
    assert.deepEqual(prefs.extraPathDirs, patch.extraPathDirs);
  });

  it("merges patches without dropping existing keys", async () => {
    await h.call<OkResult>("settings.set", { unrelated: 42 });
    const prefs = await h.call<Record<string, unknown>>("settings.get");
    assert.equal(prefs.unrelated, 42);
    // Earlier writes still present.
    assert.equal(prefs.theme, "dark");
    assert.deepEqual(prefs.cliTools, ["gh", "kubectl"]);
  });

  it("anthropicApiKey is routed to secrets, not preferences", async () => {
    await h.call<OkResult>("settings.set", { anthropicApiKey: "sk-test-stored" });
    const after1 = await h.call<{
      anthropicApiKey?: string;
      hasAnthropicApiKey?: boolean;
    }>("settings.get");
    // Critical: the secret VALUE never appears in the response. Only the
    // boolean presence flag does. This is the security guarantee of the
    // p2-keychain change.
    assert.equal("anthropicApiKey" in after1, false);
    assert.equal(after1.hasAnthropicApiKey, true);

    // Empty string clears it. Flag flips back to false.
    await h.call<OkResult>("settings.set", { anthropicApiKey: "" });
    const after2 = await h.call<{
      anthropicApiKey?: string;
      hasAnthropicApiKey?: boolean;
    }>("settings.get");
    assert.equal("anthropicApiKey" in after2, false);
    assert.equal(after2.hasAnthropicApiKey, false);
  });
});

describe("settings.validateApiKey", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("rejects non-string params", async () => {
    await assert.rejects(
      () => h.call("settings.validateApiKey", {}),
      /requires \{ apiKey: string \}/,
    );
  });

  it("rejects empty string", async () => {
    await assert.rejects(
      () => h.call("settings.validateApiKey", { apiKey: "" }),
      /requires \{ apiKey: string \}/,
    );
  });

  // Network-dependent: only run when SKIP_LLM is unset. We expect a 401-like
  // error from Anthropic; we don't pin the exact message because the SDK
  // wording can change.
  if (process.env.SKIP_LLM !== "1") {
    it("rejects a bogus API key with an Anthropic auth error", async () => {
      await assert.rejects(
        () => h.call("settings.validateApiKey", { apiKey: "sk-ant-bogus-12345" }),
        (err: Error) => {
          // Should mention authentication / api-key in some form.
          assert.match(err.message, /auth|api[ -]?key|401|invalid/i);
          return true;
        },
      );
    });
  }
});

describe("settings EA + prompts CRUD", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("getEA returns disabled defaults on a fresh DB", async () => {
    const ea = await h.call<EAConfig>("settings.getEA");
    assert.deepEqual(ea, { enabled: false, name: "", email: "" });
  });

  it("setEA persists the full struct", async () => {
    const result = await h.call<{ ok: true; ea: EAConfig }>("settings.setEA", {
      enabled: true,
      name: "Pat the Assistant",
      email: "pat@assistant.example",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ea, {
      enabled: true,
      name: "Pat the Assistant",
      email: "pat@assistant.example",
    });
    const next = await h.call<EAConfig>("settings.getEA");
    assert.deepEqual(next, result.ea);
  });

  it("setEA coerces missing fields to defaults", async () => {
    const result = await h.call<{ ok: true; ea: EAConfig }>("settings.setEA", { enabled: true });
    assert.deepEqual(result.ea, { enabled: true, name: "", email: "" });
  });

  it("setEA throws on non-object params", async () => {
    await assert.rejects(() => h.call("settings.setEA", null), /requires EAConfig object/);
  });

  it("getPrompts returns {} when nothing is stored", async () => {
    const prompts = await h.call<Record<string, string>>("settings.getPrompts");
    assert.deepEqual(prompts, {});
  });

  it("setPrompts persists known keys and ignores unknown keys", async () => {
    await h.call<OkResult>("settings.setPrompts", {
      analysisPrompt: "be thorough",
      draftPrompt: "be terse",
      // Unknown key — the contract calls these out as ignored, not errored.
      bogusPrompt: "should be dropped",
    });
    const prompts = await h.call<Record<string, string>>("settings.getPrompts");
    assert.equal(prompts.analysisPrompt, "be thorough");
    assert.equal(prompts.draftPrompt, "be terse");
    assert.equal("bogusPrompt" in prompts, false);
  });

  it("setPrompts throws when a known key is non-string", async () => {
    await assert.rejects(
      () => h.call("settings.setPrompts", { analysisPrompt: 123 }),
      /must be a string/,
    );
  });

  it("setPrompts allows empty string (renderer falls back to defaults)", async () => {
    await h.call<OkResult>("settings.setPrompts", { stylePrompt: "" });
    const prompts = await h.call<Record<string, string>>("settings.getPrompts");
    assert.equal(prompts.stylePrompt, "");
  });
});
