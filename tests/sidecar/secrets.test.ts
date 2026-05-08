// `secrets.*` RPC tests — covers the in-memory secret store the sidecar
// uses post-p2-keychain. The OS Keychain is owned by the renderer
// (Tauri commands in src-tauri/src/keychain.rs); the sidecar's role is
// to hold a process-local mirror, populated at boot via
// `secrets.bootstrap` and updated via `secrets.set` / `secrets.delete`.
//
// Audit guarantees pinned here:
//   1. Secret values never appear in `settings.get` — only boolean
//      presence flags. This is the security delta for issue 12.
//   2. `secrets.bootstrap` replaces the in-memory map (no merge-only).
//   3. `anthropic.hasApiKey` and `anthropic.hasAnyLlmProvider` reflect
//      the bootstrapped state without a process restart.
//   4. The legacy IMAP creds migration path is idempotent: collect →
//      finalize → second collect returns nothing left to do.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";

interface BootstrapResult {
  ok: true;
  configured: string[];
}

interface OkResult {
  ok: true;
}

interface HasResult {
  configured: boolean;
  source?: string | null;
}

interface AnyProviderResult {
  configured: boolean;
  anthropic: boolean;
  openrouter: boolean;
}

describe("secrets.bootstrap — populates the in-memory store", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar({
      env: { ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" },
    });
  });
  after(async () => {
    await h.close();
  });

  it("starts empty on a fresh data dir", async () => {
    const result = await h.call<{ configured: string[] }>("secrets.list", {});
    assert.deepEqual(result.configured, []);
  });

  it("populates anthropic + openrouter via bootstrap and they're visible to consumers", async () => {
    const bootstrap = await h.call<BootstrapResult>("secrets.bootstrap", {
      secrets: {
        anthropicApiKey: "sk-ant-bootstrap",
        openRouterApiKey: "sk-or-bootstrap",
      },
    });
    assert.equal(bootstrap.ok, true);
    assert.deepEqual([...bootstrap.configured].sort(), ["anthropicApiKey", "openRouterApiKey"]);

    // anthropic.hasApiKey reflects the bootstrapped value without a restart.
    const has = await h.call<HasResult>("anthropic.hasApiKey", {});
    assert.equal(has.configured, true);
    assert.equal(has.source, "keychain");

    // hasAnyLlmProvider sees both providers configured.
    const any = await h.call<AnyProviderResult>("anthropic.hasAnyLlmProvider", {});
    assert.equal(any.configured, true);
    assert.equal(any.anthropic, true);
    assert.equal(any.openrouter, true);
  });

  it("a second bootstrap REPLACES the map — keys not in the bundle disappear", async () => {
    // Only re-bootstrap the openrouter key; anthropic should drop out.
    await h.call<BootstrapResult>("secrets.bootstrap", {
      secrets: { openRouterApiKey: "sk-or-only" },
    });
    const result = await h.call<{ configured: string[] }>("secrets.list", {});
    assert.deepEqual(result.configured, ["openRouterApiKey"]);

    const has = await h.call<HasResult>("anthropic.hasApiKey", {});
    assert.equal(has.configured, false);
  });

  it("rejects bootstrap params with non-string values", async () => {
    await assert.rejects(
      // 123 is intentionally not a string
      () => h.call("secrets.bootstrap", { secrets: { anthropicApiKey: 123 } }),
      /not a string/,
    );
  });
});

describe("secrets.set / secrets.delete — runtime updates", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar({
      env: { ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" },
    });
  });
  after(async () => {
    await h.close();
  });

  it("set then has returns true; delete then has returns false", async () => {
    await h.call<OkResult>("secrets.set", {
      name: "anthropicApiKey",
      value: "sk-ant-runtime",
    });
    let res = await h.call<{ configured: boolean }>("secrets.has", {
      name: "anthropicApiKey",
    });
    assert.equal(res.configured, true);

    await h.call<OkResult>("secrets.delete", { name: "anthropicApiKey" });
    res = await h.call<{ configured: boolean }>("secrets.has", {
      name: "anthropicApiKey",
    });
    assert.equal(res.configured, false);
  });

  it("set with empty string is treated as a delete", async () => {
    await h.call<OkResult>("secrets.set", {
      name: "openRouterApiKey",
      value: "sk-or-temp",
    });
    let res = await h.call<{ configured: boolean }>("secrets.has", {
      name: "openRouterApiKey",
    });
    assert.equal(res.configured, true);

    await h.call<OkResult>("secrets.set", { name: "openRouterApiKey", value: "" });
    res = await h.call<{ configured: boolean }>("secrets.has", {
      name: "openRouterApiKey",
    });
    assert.equal(res.configured, false);
  });

  it("rejects missing name / value", async () => {
    await assert.rejects(() => h.call("secrets.set", { value: "x" }), /requires \{ name \}/);
    await assert.rejects(
      () => h.call("secrets.set", { name: "x" }),
      /requires \{ value: string \}/,
    );
  });
});

describe("secrets — env-var still wins over in-memory", () => {
  // ANTHROPIC_API_KEY in env should resolve before anything in the
  // bootstrap bundle. Mirrors the pre-keychain behavior so devs with the
  // env var set don't have to round-trip through the keychain UI.
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

  it("anthropic.hasApiKey sees the env key without a bootstrap call", async () => {
    const has = await h.call<HasResult>("anthropic.hasApiKey", {});
    assert.equal(has.configured, true);
    assert.equal(has.source, "env");
  });
});

describe("settings.get does not leak secret values", () => {
  // The whole point of issue 12: `settings.get` used to surface
  // `anthropicApiKey` as a string. Now it must surface only a boolean.
  let h: Harness;
  before(async () => {
    h = await spawnSidecar({
      env: { ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" },
    });
  });
  after(async () => {
    await h.close();
  });

  it("after secrets.bootstrap, settings.get returns hasAnthropicApiKey: true and no value", async () => {
    await h.call<BootstrapResult>("secrets.bootstrap", {
      secrets: { anthropicApiKey: "sk-must-not-leak" },
    });
    const prefs = await h.call<Record<string, unknown>>("settings.get", {});
    assert.equal(prefs.hasAnthropicApiKey, true);
    // Critical: the value itself is absent.
    assert.equal("anthropicApiKey" in prefs, false);
  });
});

describe("legacy IMAP password migration", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar({
      env: { ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" },
    });
    // Seed a legacy creds file in the per-test data dir. The harness
    // exposes `dataDir` precisely so tests can set up state the sidecar
    // expects to read from disk.
    const accountId = "user@imap.example";
    const filePath = join(h.dataDir, `imap-creds-${accountId}.json`);
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          email: accountId,
          imap: { host: "imap.example", port: 993, tls: true, username: accountId },
          smtp: { host: "smtp.example", port: 587, tls: true, username: accountId },
          password: "legacy-plaintext-pw",
        },
        null,
        2,
      ),
    );
  });
  after(async () => {
    await h.close();
  });

  it("collectLegacyImapPasswords surfaces the password and finalize strips it", async () => {
    const collect = await h.call<{
      entries: Array<{ accountId: string; password: string }>;
    }>("secrets.collectLegacyImapPasswords", {});
    assert.equal(collect.entries.length, 1);
    assert.equal(collect.entries[0]!.accountId, "user@imap.example");
    assert.equal(collect.entries[0]!.password, "legacy-plaintext-pw");

    // Caller (renderer) writes to keychain, then asks the sidecar to
    // strip the legacy field.
    await h.call<OkResult>("secrets.finalizeImapMigration", {
      accountId: "user@imap.example",
    });

    // Read back the file. The password field must be gone.
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(join(h.dataDir, "imap-creds-user@imap.example.json"), "utf8");
    const parsed = JSON.parse(raw) as { password?: string };
    assert.equal("password" in parsed, false);
  });

  it("finalize requires accountId", async () => {
    await assert.rejects(
      () => h.call("secrets.finalizeImapMigration", {}),
      /requires \{ accountId \}/,
    );
  });
});
