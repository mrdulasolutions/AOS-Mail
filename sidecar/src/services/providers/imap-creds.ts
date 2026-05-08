// IMAP/SMTP credentials store.
//
// What's persisted on disk and what isn't:
//   - Server config (host, port, TLS, username, email) — written to a
//     plain JSON file at <dataDir>/imap-creds-<accountId>.json so the
//     account row can hydrate without bootstrapping from the renderer
//     before sync can run.
//   - Password — kept ONLY in the in-memory secrets store
//     (lib/secrets.ts), itself populated at boot from the OS Keychain
//     via the renderer. The password never lands in a regular file on
//     disk.
//
// The split keeps the existing "drop a creds file, sidecar boots and
// connects" workflow working for the metadata layer while the sensitive
// piece is escalated to the OS keychain. The legacy file format
// (password inline) is migrated transparently — see `loadImapCredentials`.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { getDataDir } from "../../db/data-dir.js";
import { getSecret, setSecret, deleteSecret } from "../../lib/secrets.js";

export interface ImapCredentials {
  email: string;
  imap: { host: string; port: number; tls: boolean; username: string };
  smtp: { host: string; port: number; tls: boolean; username: string };
  password: string;
}

/**
 * Stored shape on disk — the password field is intentionally omitted.
 * If a legacy file from the pre-keychain era still has `password` set,
 * `loadImapCredentials` migrates it: lifts the value into the in-memory
 * secrets store and rewrites the file without the field. The renderer
 * is also responsible for stashing it in the keychain on first boot
 * (see migrateLegacySecrets in src/renderer/lib/secrets.ts).
 */
type ImapCredentialsOnDisk = Omit<ImapCredentials, "password"> & {
  /** Present only on legacy files; load-time migration removes it. */
  password?: string;
};

function path(accountId: string): string {
  return join(getDataDir(), `imap-creds-${accountId}.json`);
}

function passwordSecretName(accountId: string): string {
  return `imapPassword:${accountId}`;
}

export function saveImapCredentials(accountId: string, creds: ImapCredentials): void {
  // Server config goes to disk; password goes to the secrets store only.
  const onDisk: ImapCredentialsOnDisk = {
    email: creds.email,
    imap: creds.imap,
    smtp: creds.smtp,
  };
  writeFileSync(path(accountId), JSON.stringify(onDisk, null, 2));
  setSecret(passwordSecretName(accountId), creds.password);
}

export function loadImapCredentials(accountId: string): ImapCredentials | null {
  const p = path(accountId);
  if (!existsSync(p)) return null;
  let parsed: ImapCredentialsOnDisk;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8")) as ImapCredentialsOnDisk;
  } catch {
    return null;
  }

  // Resolve the password. Prefer the in-memory secrets store (populated
  // either by saveImapCredentials or by the renderer's boot bootstrap);
  // fall back to a legacy password embedded in the JSON file. When we
  // resolve via legacy, populate the in-memory store so subsequent
  // lookups don't have to re-read the file. The disk file is left
  // unchanged here — the renderer's `migrateLegacySecrets` strips legacy
  // passwords once it has copied them into the OS keychain.
  let password = getSecret(passwordSecretName(accountId));
  if (!password && typeof parsed.password === "string" && parsed.password) {
    setSecret(passwordSecretName(accountId), parsed.password);
    password = parsed.password;
  }
  if (!password) return null;

  return {
    email: parsed.email,
    imap: parsed.imap,
    smtp: parsed.smtp,
    password,
  };
}

/**
 * Strip the legacy `password` field from the on-disk creds file once it
 * has been migrated to the OS Keychain. Called by the sidecar's
 * `secrets.finalizeImapMigration` RPC after the renderer confirms the
 * password is in the keychain. No-op if the file already lacks the
 * field, or if there's no file for this account.
 */
export function clearLegacyImapPasswordOnDisk(accountId: string): void {
  const p = path(accountId);
  if (!existsSync(p)) return;
  let parsed: ImapCredentialsOnDisk;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8")) as ImapCredentialsOnDisk;
  } catch {
    return;
  }
  if (typeof parsed.password !== "string" || !parsed.password) return;
  const cleaned: ImapCredentialsOnDisk = {
    email: parsed.email,
    imap: parsed.imap,
    smtp: parsed.smtp,
  };
  writeFileSync(p, JSON.stringify(cleaned, null, 2));
}

export function deleteImapCredentials(accountId: string): void {
  const p = path(accountId);
  if (existsSync(p)) unlinkSync(p);
  deleteSecret(passwordSecretName(accountId));
}

export function listImapAccountIds(): string[] {
  try {
    return readdirSync(getDataDir())
      .map((name) => /^imap-creds-(.+)\.json$/.exec(name)?.[1])
      .filter((id): id is string => !!id);
  } catch {
    return [];
  }
}
