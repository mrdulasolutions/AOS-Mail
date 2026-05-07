// `sync` IPC namespace — V1 surface that the renderer's existing
// initializeSync() flow expects.
//
// Methods covered here:
//   sync.init              — list accounts with isConnected flags
//   sync.now(accountId)    — pull recent messages now, return summary
//   sync.start(accountId)  — accepted but no-op for V1 (no background loop)
//   sync.stop(accountId)   — accepted but no-op for V1
//   sync.status(accountId) — current sync state
//   sync.getEmails         — read emails (inbox)
//   sync.getSentEmails     — read emails (sent)
//   sync.setInterval       — accepted but no-op for V1
//   sync.prefetchBodies    — no-op for V1; bodies fetched on demand
//
// V1 deliberately omits the background sync loop — sync.now is the
// entry point. The renderer can poll this, or sync.now can be wired to
// a setInterval in a follow-up.

import { registerMethod, emit } from "../rpc.js";
import { getDb } from "../db/index.js";
import { syncAccountNow, getEmailsForAccount } from "../services/sync.js";
import {
  listImapAccountIds,
} from "../services/providers/imap-creds.js";
import { listAccountIdsWithTokens } from "../services/oauth-gmail.js";

interface AccountInfoRow {
  id: string;
  email: string;
  provider: string;
}

function listAccountsWithProvider(): AccountInfoRow[] {
  return getDb()
    .prepare("SELECT id, email, COALESCE(provider, 'gmail') as provider FROM accounts ORDER BY added_at ASC")
    .all() as AccountInfoRow[];
}

function isConnected(provider: string, accountId: string): boolean {
  if (provider === "gmail") {
    return listAccountIdsWithTokens().includes(accountId);
  }
  if (provider === "imap") {
    return listImapAccountIds().includes(accountId);
  }
  return false;
}

export function registerSyncMethods(): void {
  registerMethod("sync.init", () => {
    const rows = listAccountsWithProvider();
    return rows.map((r) => ({
      accountId: r.id,
      email: r.email,
      isConnected: isConnected(r.provider, r.id),
      provider: r.provider,
    }));
  });

  registerMethod("sync.now", async (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("sync.now: requires { accountId }");
    emit("sync:status-change", { accountId, status: "syncing" });
    try {
      const result = await syncAccountNow(accountId);
      emit("sync:status-change", { accountId, status: "idle" });
      if (result.newEmails.length > 0) {
        // Match the renderer's contract: { accountId, emails }
        emit("sync:new-emails", {
          accountId,
          emails: result.newEmails,
        });
      }
      return result;
    } catch (err) {
      emit("sync:status-change", { accountId, status: "error" });
      throw err;
    }
  });

  registerMethod("sync.start", () => ({ ok: true, note: "background sync not implemented in V1" }));
  registerMethod("sync.stop", () => ({ ok: true }));
  registerMethod("sync.setInterval", () => ({ ok: true, note: "background sync not implemented in V1" }));

  registerMethod("sync.status", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("sync.status: requires { accountId }");
    return { accountId, status: "idle" };
  });

  registerMethod("sync.getEmails", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("sync.getEmails: requires { accountId }");
    return getEmailsForAccount(accountId, { sent: false });
  });

  registerMethod("sync.getSentEmails", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("sync.getSentEmails: requires { accountId }");
    return getEmailsForAccount(accountId, { sent: true });
  });

  // Renderer batches a body-prefetch after first inbox load. V1 stores
  // empty bodies (fetched lazily on thread open), so this is a no-op
  // that returns success so the renderer doesn't surface an error.
  registerMethod("sync.prefetchBodies", () => ({ ok: true, fetched: 0 }));
}
