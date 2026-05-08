// Generic Settings RPC.
//
// `settings.get`              — return the full preferences blob the renderer
//                               treats as the Config object. Missing fields
//                               are absent rather than defaulted; the renderer
//                               already has DEFAULT_* values for everything.
// `settings.set(partial)`     — apply a partial Config update. anthropicApiKey
//                               is special-cased to also clear the in-process
//                               Anthropic client cache. Everything else is a
//                               plain preferences.json patch.
// `settings.validateApiKey`   — quick handshake against api.anthropic.com so
//                               we surface 401s before persisting a bad key.
// `settings.getEA`/`setEA`    — convenience accessors for the executive-
//                               assistant subobject (the SettingsPanel reads
//                               and writes it as its own React Query).
// `settings.getPrompts`/`setPrompts` — same shape, for the editable prompt
//                               strings.
//
// What this is NOT: it's not yet a typed mirror of the Zod ConfigSchema. The
// renderer trusts whatever shape comes back and overlays defaults. Once the
// shim and SettingsPanel are stable we can tighten the boundary.

import { registerMethod } from "../rpc.js";
import { getPreferences, patchPreferences, setPreference } from "../lib/preferences.js";
import { setApiKey, resetClient, validateApiKey } from "../services/anthropic.js";
import { getSecret, setSecret } from "../lib/secrets.js";

/**
 * Keys that the renderer occasionally bundles into a `settings.set`
 * call but which are owned by the keychain-backed secrets store, NOT
 * preferences.json. We special-case them: forward to the secrets store
 * and skip the preferences write so they never land on disk in
 * cleartext.
 */
const SECRET_KEYS = new Set<string>([
  "anthropicApiKey",
  "openRouterApiKey",
  "googleClientId",
  "googleClientSecret",
]);

interface EAConfig {
  enabled: boolean;
  name: string;
  email: string;
}

interface PromptsBlob {
  analysisPrompt?: string;
  draftPrompt?: string;
  archiveReadyPrompt?: string;
  stylePrompt?: string;
  agentDrafterPrompt?: string;
  calendaringPrompt?: string;
}

const PROMPT_KEYS: (keyof PromptsBlob)[] = [
  "analysisPrompt",
  "draftPrompt",
  "archiveReadyPrompt",
  "stylePrompt",
  "agentDrafterPrompt",
  "calendaringPrompt",
];

export function registerSettingsMethods(): void {
  // ─── Generic config ────────────────────────────────────────────────────

  registerMethod("settings.get", () => {
    // Compose the renderer-visible config object: prefs blob + a
    // dedicated `hasAnthropicApiKey` flag so the Settings UI can render
    // its "configured" badge without exposing the secret. Secret values
    // themselves are NEVER returned here — they live in the OS keychain
    // and are read by the renderer via the keychain commands directly
    // when it needs to display a masked-input "edit existing key"
    // experience.
    const prefs = getPreferences();
    return {
      ...prefs,
      hasAnthropicApiKey: !!getSecret("anthropicApiKey"),
      hasOpenRouterApiKey: !!getSecret("openRouterApiKey"),
      hasGoogleCredentials: !!getSecret("googleClientId") && !!getSecret("googleClientSecret"),
    };
  });

  registerMethod("settings.set", (params) => {
    const patch = (params ?? {}) as Record<string, unknown>;

    // anthropicApiKey is the only field that requires side effects beyond
    // forwarding to the secrets store: setApiKey() also clears the
    // Anthropic client cache so the next createMessage() picks up the new
    // key without a restart.
    if ("anthropicApiKey" in patch) {
      const v = patch.anthropicApiKey;
      if (typeof v === "string" && v.trim()) {
        setApiKey(v.trim());
      } else {
        // Empty string / undefined → clear it.
        setApiKey("");
        resetClient();
      }
      delete patch.anthropicApiKey;
    }

    // Other secret fields: forward to the in-memory secrets store and
    // strip from the patch so patchPreferences never persists them to
    // disk. Renderers should ideally write keychain → call secrets.set
    // directly, but this back-compat path covers any legacy callers.
    for (const key of SECRET_KEYS) {
      if (key in patch) {
        const v = patch[key];
        if (typeof v === "string") {
          setSecret(key, v.trim());
        }
        delete patch[key];
      }
    }

    if (Object.keys(patch).length > 0) {
      patchPreferences(patch);
    }
    return { ok: true };
  });

  registerMethod("settings.validateApiKey", async (params) => {
    const key = (params as { apiKey?: string })?.apiKey;
    if (typeof key !== "string" || !key.trim()) {
      throw new Error("settings.validateApiKey: requires { apiKey: string }");
    }
    await validateApiKey(key);
    return { ok: true };
  });

  // ─── EA subobject ──────────────────────────────────────────────────────

  registerMethod("settings.getEA", () => {
    const stored = (getPreferences() as { ea?: Partial<EAConfig> }).ea;
    return {
      enabled: !!stored?.enabled,
      name: stored?.name ?? "",
      email: stored?.email ?? "",
    } satisfies EAConfig;
  });

  registerMethod("settings.setEA", (params) => {
    const incoming = params as Partial<EAConfig> | undefined;
    if (!incoming || typeof incoming !== "object") {
      throw new Error("settings.setEA: requires EAConfig object");
    }
    const next: EAConfig = {
      enabled: !!incoming.enabled,
      name: typeof incoming.name === "string" ? incoming.name : "",
      email: typeof incoming.email === "string" ? incoming.email : "",
    };
    setPreference("ea", next);
    return { ok: true, ea: next };
  });

  // ─── Prompts subobject ─────────────────────────────────────────────────

  registerMethod("settings.getPrompts", () => {
    const prefs = getPreferences();
    const out: PromptsBlob = {};
    for (const k of PROMPT_KEYS) {
      const v = (prefs as Record<string, unknown>)[k];
      if (typeof v === "string") out[k] = v;
    }
    return out;
  });

  registerMethod("settings.setPrompts", (params) => {
    const incoming = (params ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of PROMPT_KEYS) {
      if (k in incoming) {
        const v = incoming[k];
        // Allow empty string to "reset" — the renderer falls back to
        // DEFAULT_* when a prompt is missing. Anything other than a string
        // is a programmer error.
        if (typeof v !== "string") {
          throw new Error(`settings.setPrompts: ${k} must be a string`);
        }
        patch[k] = v;
      }
    }
    if (Object.keys(patch).length > 0) patchPreferences(patch);
    return { ok: true };
  });
}
