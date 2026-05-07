// `gmail` IPC namespace — auth-side methods only for now.
//
// V1 surface:
//   gmail.saveCredentials   — store Google OAuth client_id + client_secret
//   gmail.hasCredentials    — has the user pasted credentials yet?
//   gmail.startOAuth        — kick off the OAuth flow; returns URL to open
//                             plus emits auth:gmail-connected when complete
//   gmail.cancelOAuth       — abort an in-flight flow
//   gmail.checkAuth         — for each token file we have, return account
//                             metadata (id, email, display_name)
//   gmail.disconnect        — delete tokens + drop the account row
//
// Everything that calls Gmail API methods (fetch, send, label, etc.) belongs
// to the wider gmail-client lift and arrives in subsequent commits — those
// build on `authedClientForAccount(accountId)`.

import { emit, registerMethod } from "../rpc.js";
import {
  startOAuth,
  cancelOAuth,
  setCredentials,
  getCredentials,
  loadTokens,
  deleteTokens,
  listAccountIdsWithTokens,
  authedClientForAccount,
} from "../services/oauth-gmail.js";
import { getDb } from "../db/index.js";
import { google } from "googleapis";
import { upsertAccountAfterAuth } from "./gmail-helpers.js";
import {
  createDraftGmail,
  updateDraftGmail,
} from "../services/providers/gmail-send.js";
import type { SendInput } from "../services/providers/smtp-send.js";

export function registerGmailMethods(): void {
  registerMethod("gmail.saveCredentials", (params) => {
    const { clientId, clientSecret } =
      (params as { clientId?: string; clientSecret?: string }) ?? {};
    if (!clientId || !clientSecret) {
      throw new Error("gmail.saveCredentials: requires { clientId, clientSecret }");
    }
    setCredentials({ clientId, clientSecret });
    return { ok: true };
  });

  registerMethod("gmail.hasCredentials", () => ({
    configured: !!getCredentials(),
  }));

  registerMethod("gmail.startOAuth", async () => {
    const { url, promise } = startOAuth();
    // Don't await — return the URL immediately so the renderer can open it.
    // Wire the eventual completion to a notification.
    promise.then(
      (account) => {
        upsertAccountAfterAuth(account.accountId, account.email, account.displayName);
        emit("auth:gmail-connected", {
          accountId: account.accountId,
          email: account.email,
          displayName: account.displayName,
        });
      },
      (err) => {
        emit("auth:gmail-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return { url };
  });

  registerMethod("gmail.cancelOAuth", () => {
    cancelOAuth();
    return { ok: true };
  });

  // For each token file present, check the token validates and return the
  // associated account info. Useful at app startup so the renderer knows
  // which accounts are connected.
  registerMethod("gmail.checkAuth", async () => {
    const ids = listAccountIdsWithTokens();
    const accounts: Array<{ accountId: string; email: string; valid: boolean }> = [];
    for (const id of ids) {
      const tokens = loadTokens(id);
      if (!tokens) continue;
      try {
        const client = authedClientForAccount(id);
        const oauth2 = google.oauth2({ version: "v2", auth: client });
        const profile = await oauth2.userinfo.get();
        accounts.push({
          accountId: id,
          email: profile.data.email ?? id,
          valid: true,
        });
        if (profile.data.email) {
          upsertAccountAfterAuth(id, profile.data.email, profile.data.name ?? null);
        }
      } catch {
        accounts.push({ accountId: id, email: id, valid: false });
      }
    }
    return { accounts };
  });

  registerMethod("gmail.disconnect", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("gmail.disconnect: requires { accountId }");
    deleteTokens(accountId);
    getDb().prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    return { ok: true };
  });

  // Create or update a server-side Gmail draft. The renderer's compose
  // panel calls this when the user wants their draft synced to Gmail
  // (vs. the local-only path through compose.saveLocalDraft). If a
  // gmailDraftId is passed we update in place; otherwise we create.
  registerMethod("gmail.createDraft", async (params) => {
    const p = (params ?? {}) as SendInput & { gmailDraftId?: string };
    if (!p.accountId) throw new Error("gmail.createDraft: requires { accountId }");

    // Resolve from-address from the account row when the renderer doesn't
    // pass it (most calls don't).
    const account = getDb()
      .prepare("SELECT email FROM accounts WHERE id = ?")
      .get(p.accountId) as { email?: string } | undefined;
    if (!account?.email) {
      throw new Error(`gmail.createDraft: account ${p.accountId} not found`);
    }
    const enriched: SendInput = { ...p, from: p.from ?? account.email };

    if (p.gmailDraftId) {
      const result = await updateDraftGmail(p.gmailDraftId, enriched);
      return result;
    }
    const result = await createDraftGmail(enriched);
    return result;
  });
}
