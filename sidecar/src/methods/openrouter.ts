// OpenRouter-related sidecar methods.
//
// `openrouter.setApiKey`      — store the user's OpenRouter key in
//                               preferences.json. Mirrors anthropic.setApiKey.
// `openrouter.hasApiKey`      — has any usable key been configured (env or
//                               prefs)?
// `openrouter.validateApiKey` — quick GET /models handshake so the Settings
//                               UI can surface a 401 before persisting a
//                               broken key.
// `openrouter.listFreeModels` — fetch the free-tier model catalogue.
//                               Renderer shows the result in the AI Models
//                               picker.
//
// These methods exist so the renderer doesn't have to know the OpenRouter
// HTTP shape — it just calls a typed RPC and gets either { ok: true } or a
// list of models. The actual chat-completions calls go through the
// LLM router in services/anthropic.ts (createMessage), not through any
// of these methods directly.

import { registerMethod } from "../rpc.js";
import {
  setOpenRouterApiKey,
  validateOpenRouterKey,
  listFreeModels,
  getOpenRouterApiKey,
} from "../services/providers/openrouter.js";

export function registerOpenRouterMethods(): void {
  registerMethod("openrouter.setApiKey", (params) => {
    const key = (params as { apiKey?: string })?.apiKey?.trim();
    if (!key) throw new Error("openrouter.setApiKey: requires { apiKey }");
    setOpenRouterApiKey(key);
    return { ok: true } as const;
  });

  registerMethod("openrouter.clearApiKey", () => {
    setOpenRouterApiKey("");
    return { ok: true } as const;
  });

  registerMethod("openrouter.hasApiKey", () => {
    const fromEnv = !!process.env.OPENROUTER_API_KEY?.trim();
    const configured = !!getOpenRouterApiKey();
    return {
      configured,
      source: fromEnv ? "env" : configured ? "prefs" : null,
    } as const;
  });

  registerMethod("openrouter.validateApiKey", async (params) => {
    const key = (params as { apiKey?: string })?.apiKey;
    if (typeof key !== "string" || !key.trim()) {
      throw new Error("openrouter.validateApiKey: requires { apiKey: string }");
    }
    await validateOpenRouterKey(key);
    return { ok: true } as const;
  });

  registerMethod("openrouter.listFreeModels", async () => {
    const models = await listFreeModels();
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength,
    }));
  });
}
