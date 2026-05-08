// Anthropic-related sidecar methods.
//
// `anthropic.ping`              — verify the API key + network reach.
// `anthropic.setApiKey`         — store the key in preferences.json. Renderer
//                                 settings UI calls this when the user pastes
//                                 a new key.
// `anthropic.hasApiKey`         — has the Anthropic key specifically been
//                                 configured (env or prefs)? Use this only
//                                 for surfaces that genuinely need Anthropic
//                                 (e.g. "Anthropic Authentication" card in
//                                 Agent Tools).
// `anthropic.hasAnyLlmProvider` — has ANY usable LLM provider been configured
//                                 (Anthropic OR OpenRouter)? Use this for
//                                 boot triage / feature gates where any LLM
//                                 will do — OpenRouter-only users should not
//                                 be silently locked out of analysis.
//
// Future AI-using namespaces (analysis, drafts, archiveReady, style,
// memory.classify, agent) consume the underlying anthropic.ts service
// directly — they don't all need to be exposed as sidecar RPC methods.

import { registerMethod } from "../rpc.js";
import { ping, setApiKey, resetClient } from "../services/anthropic.js";
import { getPreferences } from "../lib/preferences.js";
import { getOpenRouterApiKey } from "../services/providers/openrouter.js";

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
    const fromPrefs = !!(getPreferences() as { anthropicApiKey?: string }).anthropicApiKey?.trim();
    return {
      configured: fromEnv || fromPrefs,
      source: fromEnv ? "env" : fromPrefs ? "prefs" : null,
    };
  });

  // Boot-triage gate. Returns `configured: true` if EITHER an Anthropic key
  // OR an OpenRouter key is set (env or prefs). This is the right gate for
  // any feature that goes through the LLM router in services/anthropic.ts —
  // the router transparently routes claude-* ids to Anthropic and everything
  // else to OpenRouter, so a configured OpenRouter key is enough for the
  // analyzer / drafter / archive-ready / etc. The narrower
  // `anthropic.hasApiKey` should be reserved for surfaces that specifically
  // need the Anthropic provider (e.g. its own Settings auth card).
  registerMethod("anthropic.hasAnyLlmProvider", () => {
    const anthropicEnv = !!process.env.ANTHROPIC_API_KEY?.trim();
    const anthropicPrefs = !!(
      getPreferences() as { anthropicApiKey?: string }
    ).anthropicApiKey?.trim();
    const anthropicConfigured = anthropicEnv || anthropicPrefs;
    const openRouterConfigured = !!getOpenRouterApiKey();
    return {
      configured: anthropicConfigured || openRouterConfigured,
      anthropic: anthropicConfigured,
      openrouter: openRouterConfigured,
    };
  });
}
