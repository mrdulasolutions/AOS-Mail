// Anthropic-related sidecar methods.
//
// `anthropic.ping`         — verify the API key + network reach.
// `anthropic.setApiKey`    — store the key in preferences.json. Renderer
//                            settings UI calls this when the user pastes
//                            a new key.
// `anthropic.hasApiKey`    — has any usable key been configured (env or
//                            prefs)?
//
// Future AI-using namespaces (analysis, drafts, archiveReady, style,
// memory.classify, agent) consume the underlying anthropic.ts service
// directly — they don't all need to be exposed as sidecar RPC methods.

import { registerMethod } from "../rpc.js";
import { ping, setApiKey, resetClient } from "../services/anthropic.js";
import { getPreferences } from "../lib/preferences.js";

export function registerAnthropicMethods(): void {
  registerMethod("anthropic.ping", async () => {
    const reply = await ping();
    return { ok: true, reply };
  });

  registerMethod("anthropic.setApiKey", (params) => {
    const key = (params as { apiKey?: string })?.apiKey?.trim();
    if (!key) throw new Error("anthropic.setApiKey: requires { apiKey }");
    setApiKey(key);
    return { ok: true };
  });

  registerMethod("anthropic.clearApiKey", () => {
    setApiKey("");
    resetClient();
    return { ok: true };
  });

  registerMethod("anthropic.hasApiKey", () => {
    const fromEnv = !!process.env.ANTHROPIC_API_KEY?.trim();
    const fromPrefs = !!(getPreferences() as { anthropicApiKey?: string })
      .anthropicApiKey?.trim();
    return { configured: fromEnv || fromPrefs, source: fromEnv ? "env" : fromPrefs ? "prefs" : null };
  });
}
