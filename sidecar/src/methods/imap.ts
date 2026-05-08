// `imap` IPC namespace — V1 surface to add an IMAP account.
//
// Flow:
//   1. renderer calls imap.presets()                → list of preset servers
//   2. renderer calls imap.testConnection({...})    → sidecar connects, reports back
//   3. renderer calls imap.addAccount({...})        → persists creds + accounts row
//   4. renderer can then call imap.listFolders(id)
//   5. imap.disconnect(id) removes the account
//
// Sync (downloading messages, IDLE for push, sending via SMTP) is layered on
// top in subsequent work. The renderer's "Add IMAP account" wizard step
// only needs the four methods above to land a working account.

import { registerMethod, emit } from "../rpc.js";
import {
  IMAP_PRESETS,
  presetForEmail,
  type ImapPreset,
} from "../services/providers/imap-presets.js";
import {
  testImapConnection,
  persistImapCredentials,
  dropImapCredentials,
} from "../services/providers/imap.js";
import { listImapFolders } from "../services/providers/imap-folders.js";
import { getDb } from "../db/index.js";

interface AddAccountInput {
  email: string;
  password: string;
  displayName?: string;
  imapHost: string;
  imapPort: number;
  imapUsername?: string;
  smtpHost: string;
  smtpPort: number;
  tls?: boolean;
}

function upsertImapAccountRow(input: AddAccountInput): void {
  const db = getDb();
  const accountId = input.email;
  const existing = db.prepare("SELECT id FROM accounts WHERE id = ?").get(accountId) as
    | { id: string }
    | undefined;
  const tls = input.tls ?? true;
  if (existing) {
    db.prepare(
      `UPDATE accounts
       SET email = ?, display_name = ?,
           provider = 'imap',
           imap_host = ?, imap_port = ?, imap_username = ?,
           smtp_host = ?, smtp_port = ?, tls_enabled = ?
       WHERE id = ?`,
    ).run(
      input.email,
      input.displayName ?? null,
      input.imapHost,
      input.imapPort,
      input.imapUsername || input.email,
      input.smtpHost,
      input.smtpPort,
      tls ? 1 : 0,
      accountId,
    );
    return;
  }
  const count = (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  db.prepare(
    `INSERT INTO accounts (
        id, email, display_name, is_primary, added_at,
        provider, imap_host, imap_port, imap_username,
        smtp_host, smtp_port, tls_enabled
      ) VALUES (?, ?, ?, ?, ?, 'imap', ?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    input.email,
    input.displayName ?? null,
    count === 0 ? 1 : 0,
    Date.now(),
    input.imapHost,
    input.imapPort,
    input.imapUsername || input.email,
    input.smtpHost,
    input.smtpPort,
    tls ? 1 : 0,
  );
}

export function registerImapMethods(): void {
  registerMethod("imap.presets", () => ({
    presets: IMAP_PRESETS as ImapPreset[],
  }));

  registerMethod("imap.suggestForEmail", (params) => {
    const { email } = (params as { email?: string }) ?? {};
    if (!email) throw new Error("imap.suggestForEmail: requires { email }");
    return { preset: presetForEmail(email) };
  });

  registerMethod("imap.testConnection", async (params) => {
    const input = params as AddAccountInput & { tls?: boolean };
    if (!input?.email || !input.password || !input.imapHost) {
      throw new Error("imap.testConnection: requires { email, password, imapHost, ... }");
    }
    return testImapConnection({
      email: input.email,
      imapHost: input.imapHost,
      imapPort: input.imapPort ?? 993,
      imapUsername: input.imapUsername,
      smtpHost: input.smtpHost ?? input.imapHost,
      smtpPort: input.smtpPort ?? 587,
      password: input.password,
      tls: input.tls ?? true,
    });
  });

  registerMethod("imap.addAccount", async (params) => {
    const input = params as AddAccountInput;
    if (!input?.email || !input.password) {
      throw new Error("imap.addAccount: requires { email, password, imapHost, ... }");
    }
    const tls = input.tls ?? true;

    // Verify before persisting so we don't write a half-broken account.
    const test = await testImapConnection({
      email: input.email,
      imapHost: input.imapHost,
      imapPort: input.imapPort ?? 993,
      imapUsername: input.imapUsername,
      smtpHost: input.smtpHost ?? input.imapHost,
      smtpPort: input.smtpPort ?? 587,
      password: input.password,
      tls,
    });
    if (!test.ok) {
      throw new Error(test.error ?? "IMAP connection failed");
    }

    const accountId = input.email;
    persistImapCredentials(accountId, {
      email: input.email,
      imap: {
        host: input.imapHost,
        port: input.imapPort ?? 993,
        tls,
        username: input.imapUsername || input.email,
      },
      smtp: {
        host: input.smtpHost ?? input.imapHost,
        port: input.smtpPort ?? 587,
        tls,
        username: input.imapUsername || input.email,
      },
      password: input.password,
    });
    upsertImapAccountRow(input);

    emit("auth:imap-connected", {
      accountId,
      email: input.email,
      displayName: input.displayName ?? null,
    });

    return {
      accountId,
      email: input.email,
      displayName: input.displayName ?? null,
      capabilities: test.capabilities ?? [],
    };
  });

  registerMethod("imap.listFolders", async (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("imap.listFolders: requires { accountId }");
    return { folders: await listImapFolders(accountId) };
  });

  registerMethod("imap.disconnect", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) throw new Error("imap.disconnect: requires { accountId }");
    dropImapCredentials(accountId);
    getDb().prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    return { ok: true };
  });
}
