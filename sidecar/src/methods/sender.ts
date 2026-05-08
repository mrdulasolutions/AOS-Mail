// `sender` IPC namespace — sender profile / enrichment cache lookup.
//
// Two methods:
//   - `sender.getProfile` / `sender.getCached` — read-only cache hit, returns
//      null when the cache is empty or stale (>7 days). Same surface area as
//      the legacy Electron handler.
//   - `sender.lookup` — actual web-search-backed lookup. Forces a refresh if
//      the cache is stale. Used by the sender-profile bundled extension.
//
// The lookup itself lives in services/sender-lookup.ts so the extensions
// dispatcher (extensions.getEnrichment) can call it directly without
// re-routing through RPC.

import { registerMethod } from "../rpc.js";
import {
  lookupSender as lookupSenderService,
  getCachedSender,
  type SenderProfile,
} from "../services/sender-lookup.js";

export interface SenderProfileLegacy {
  email: string;
  name: string | null;
  summary: string;
  linkedinUrl: string | null;
  company: string | null;
  title: string | null;
  lookupAt: number;
}

/** Map the new SenderProfile shape onto the legacy {title, lookupAt} surface. */
function toLegacyShape(profile: SenderProfile): SenderProfileLegacy {
  return {
    email: profile.email,
    name: profile.name,
    summary: profile.summary,
    linkedinUrl: profile.linkedinUrl,
    company: profile.company,
    title: profile.role,
    lookupAt: profile.cachedAt,
  };
}

export function registerSenderMethods(): void {
  registerMethod("sender.getProfile", (params) => {
    const { email } = (params as { email?: string }) ?? {};
    if (!email) throw new Error("sender.getProfile: requires { email }");
    const profile = getCachedSender(email);
    return profile ? toLegacyShape(profile) : null;
  });

  // No-fetch cache lookup. Returns the new SenderProfile shape directly.
  // Used by the extension bundle to render an instant cache hit before the
  // background lookup finishes.
  registerMethod("sender.getCached", (params) => {
    const { email } = (params as { email?: string }) ?? {};
    if (!email) throw new Error("sender.getCached: requires { email }");
    return getCachedSender(email);
  });

  // Web-search-backed lookup. Returns the cached profile if fresh,
  // otherwise calls Claude with the web_search tool and caches the result.
  registerMethod("sender.lookup", async (params) => {
    const { email, name, accountId } = (params as {
      email?: string;
      name?: string;
      accountId?: string;
    }) ?? {};
    if (!email) throw new Error("sender.lookup: requires { email }");
    return await lookupSenderService({ email, name, accountId });
  });
}
