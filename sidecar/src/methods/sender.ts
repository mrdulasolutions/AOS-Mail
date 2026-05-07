// `sender` IPC namespace — sender profile / enrichment cache lookup.
//
// V1 lift handles only the sender_profiles legacy table. The extension
// enrichment cache lookup (`getEnrichmentBySender(...)`) lifts when the
// extensions namespace + enrichment-store come over. Until then, the
// "extension cache hit" branch is skipped and we fall through to the
// legacy table — which is the intended Electron behavior anyway.

import { registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";

export interface SenderProfile {
  email: string;
  name: string | null;
  summary: string;
  linkedinUrl: string | null;
  company: string | null;
  title: string | null;
  lookupAt: number;
}

function getSenderProfile(email: string): SenderProfile | null {
  const row = getDb()
    .prepare(
      `SELECT email, name, summary, linkedin_url as linkedinUrl, company, title,
              lookup_at as lookupAt
       FROM sender_profiles WHERE email = ?`,
    )
    .get(email.toLowerCase()) as SenderProfile | undefined;
  return row ?? null;
}

export function registerSenderMethods(): void {
  registerMethod("sender.getProfile", (params) => {
    const { email } = (params as { email?: string }) ?? {};
    if (!email) throw new Error("sender.getProfile: requires { email }");
    return getSenderProfile(email);
  });

  // The Electron version "lookup" also enqueued a background web-search
  // enrichment if no cache hit existed. That side effect lives in the
  // extension host (web-search extension) and lifts later. For now,
  // lookup() returns the same data as getProfile() — the renderer's
  // copy-paste UI keeps working.
  registerMethod("sender.lookup", (params) => {
    const { email } = (params as { email?: string; from?: string }) ?? {};
    if (!email) throw new Error("sender.lookup: requires { email }");
    return getSenderProfile(email);
  });
}
