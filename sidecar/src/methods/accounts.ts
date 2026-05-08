// `accounts` IPC namespace — multi-account CRUD on the accounts table.
//
// `accounts.add` is a wrapper around the gmail OAuth flow (gmail.startOAuth
// emits auth:gmail-connected on success and writes the accounts row).
// `accounts.cancelAdd` defers to gmail.cancelOAuth for the same reason.
//
// `accounts.remove` does a full cascade across every per-account table —
// matches the Electron version's removeAccount(). Also deletes the
// per-account tokens-<id>.json file so a re-add starts fresh.

import { registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";
import { startOAuth, cancelOAuth, deleteTokens } from "../services/oauth-gmail.js";
import { upsertAccountAfterAuth } from "./gmail-helpers.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("accounts-method");

export interface AccountRecord {
  id: string;
  email: string;
  displayName?: string;
  isPrimary: boolean;
  addedAt: number;
  /** "gmail" | "imap" (and Microsoft Graph later). Drives renderer-side
   *  badging + per-row affordances (e.g. only Gmail has the OAuth re-link
   *  flow). The column was added by the schema migration in db/index.ts. */
  provider: string;
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string | null;
  is_primary: number;
  added_at: number;
  provider: string | null;
}

function listAccounts(): AccountRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT id, email, display_name, is_primary, added_at, provider FROM accounts ORDER BY added_at ASC",
    )
    .all() as AccountRow[];
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name ?? undefined,
    isPrimary: r.is_primary === 1,
    addedAt: r.added_at,
    provider: r.provider ?? "gmail",
  }));
}

function setPrimary(accountId: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("UPDATE accounts SET is_primary = 0").run();
    db.prepare("UPDATE accounts SET is_primary = 1 WHERE id = ?").run(accountId);
  });
  tx();
}

function removeAccount(accountId: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    // Delete enrichments / drafts / analyses joined via email_id first.
    db.prepare(
      "DELETE FROM extension_enrichments WHERE email_id IN (SELECT id FROM emails WHERE account_id = ?)",
    ).run(accountId);
    db.prepare(
      "DELETE FROM drafts WHERE email_id IN (SELECT id FROM emails WHERE account_id = ?)",
    ).run(accountId);
    db.prepare(
      "DELETE FROM analyses WHERE email_id IN (SELECT id FROM emails WHERE account_id = ?)",
    ).run(accountId);
    // Per-account tables.
    for (const table of [
      "archive_ready",
      "snoozed_emails",
      "scheduled_messages",
      "outbox",
      "local_drafts",
      "labels",
      "sync_state",
      "correspondent_profiles",
      "calendar_events",
      "calendar_sync_state",
      "memories",
      "agent_audit_log",
      "send_as_aliases",
      "emails",
      "accounts",
    ]) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
      } catch {
        // Some tables may not exist on older DBs; ignore.
      }
    }
    // Final accounts row delete (idempotent — covered by accounts loop above).
    db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
  });
  tx();
}

export function registerAccountsMethods(): void {
  registerMethod("accounts.list", () => listAccounts());

  registerMethod("accounts.add", async () => {
    log.info("accounts.add: enter (Gmail OAuth flow)");
    // The OAuth flow does the credential pickup + token persistence + accounts
    // row upsert. We forward the URL the renderer should open and resolve once
    // the auth completes (caller awaits the same promise).
    let urlForRenderer: string;
    let promiseForRenderer: ReturnType<typeof startOAuth>["promise"];
    try {
      const oauthHandle = startOAuth();
      urlForRenderer = oauthHandle.url;
      promiseForRenderer = oauthHandle.promise;
      log.info("accounts.add: OAuth server started, awaiting browser callback");
    } catch (err) {
      log.error("accounts.add: startOAuth threw", {
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }

    let account: Awaited<typeof promiseForRenderer>;
    try {
      account = await promiseForRenderer;
      log.info("accounts.add: OAuth completed", { email: account.email });
    } catch (err) {
      log.error("accounts.add: OAuth promise rejected", {
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    try {
      upsertAccountAfterAuth(account.accountId, account.email, account.displayName);
      log.info("accounts.add: account row written");
    } catch (err) {
      log.error("accounts.add: upsertAccountAfterAuth threw", {
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }

    log.info("accounts.add: complete");
    return {
      url: urlForRenderer,
      accountId: account.accountId,
      email: account.email,
      displayName: account.displayName,
      isConnected: true,
    };
  });

  registerMethod("accounts.cancelAdd", () => {
    cancelOAuth();
    return { ok: true };
  });

  registerMethod("accounts.remove", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("accounts.remove: requires { accountId }");
    deleteTokens(accountId);
    removeAccount(accountId);
    return { ok: true };
  });

  registerMethod("accounts.setPrimary", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("accounts.setPrimary: requires { accountId }");
    setPrimary(accountId);
    return { ok: true };
  });
}
