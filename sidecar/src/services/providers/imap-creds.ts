// IMAP/SMTP credentials store. One JSON file per account at
// <dataDir>/imap-creds-<accountId>.json.
//
// V1 stores the password in plaintext to match the existing Gmail token
// store's risk profile (also plaintext). Production should escalate to OS
// Keychain via tauri-plugin-store / keytar.

import { join } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { getDataDir } from "../../db/data-dir.js";

export interface ImapCredentials {
  email: string;
  imap: { host: string; port: number; tls: boolean; username: string };
  smtp: { host: string; port: number; tls: boolean; username: string };
  password: string;
}

function path(accountId: string): string {
  return join(getDataDir(), `imap-creds-${accountId}.json`);
}

export function saveImapCredentials(accountId: string, creds: ImapCredentials): void {
  writeFileSync(path(accountId), JSON.stringify(creds, null, 2));
}

export function loadImapCredentials(accountId: string): ImapCredentials | null {
  const p = path(accountId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ImapCredentials;
  } catch {
    return null;
  }
}

export function deleteImapCredentials(accountId: string): void {
  const p = path(accountId);
  if (existsSync(p)) unlinkSync(p);
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
