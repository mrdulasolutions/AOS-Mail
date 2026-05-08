// IMAP provider — connection test, account add, basic folder list.
//
// V1 goal: prove the user can pair an IMAP account with AOS Mail. Full
// sync (downloading messages, IDLE for push, sending via SMTP) lives in
// follow-up work; this file lays the connection + credentials surface
// the rest of the system will hang off of.

import { ImapFlow } from "imapflow";
import type { ImapCredentials } from "./imap-creds.js";
import {
  saveImapCredentials,
  loadImapCredentials,
  deleteImapCredentials,
} from "./imap-creds.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("imap");

export interface ImapTestResult {
  ok: boolean;
  capabilities?: string[];
  error?: string;
  /** True if IMAP rejected the credentials (vs. host unreachable etc.). */
  authFailure?: boolean;
}

export interface ImapTestInput {
  email: string;
  imapHost: string;
  imapPort: number;
  imapUsername?: string;
  smtpHost: string;
  smtpPort: number;
  password: string;
  tls: boolean;
}

function buildClient(input: ImapTestInput) {
  return new ImapFlow({
    host: input.imapHost,
    port: input.imapPort,
    secure: input.tls,
    auth: {
      user: input.imapUsername || input.email,
      pass: input.password,
    },
    logger: false,
  });
}

/**
 * Try connecting to the IMAP server with the supplied credentials. Returns
 * a structured result the renderer can render directly.
 */
export async function testImapConnection(input: ImapTestInput): Promise<ImapTestResult> {
  const client = buildClient(input);
  try {
    await client.connect();
    const caps = (client.serverInfo?.capabilities ?? []) as string[];
    await client.logout();
    return { ok: true, capabilities: caps };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const authFailure =
      /(?:auth|login|password|denied|invalid credentials)/i.test(msg) ||
      (err as { authenticationFailed?: boolean })?.authenticationFailed === true;
    log.warn("IMAP test connection failed", { authFailure, err: msg });
    return { ok: false, error: msg, authFailure };
  }
}

/**
 * Persist credentials for an account so the sync layer can re-open the
 * connection on demand. Caller is responsible for upserting the
 * accounts table row alongside this.
 */
export function persistImapCredentials(accountId: string, creds: ImapCredentials): void {
  saveImapCredentials(accountId, creds);
}

export function dropImapCredentials(accountId: string): void {
  deleteImapCredentials(accountId);
}

/**
 * Open + return an authenticated IMAP client for an existing account.
 * Caller is responsible for `client.logout()` when done. Used by future
 * sync code; included now so `imap.listFolders` works against a stored
 * account.
 */
export async function openImapClient(accountId: string): Promise<ImapFlow> {
  const creds = loadImapCredentials(accountId);
  if (!creds) throw new Error(`No IMAP credentials for ${accountId}`);
  const client = new ImapFlow({
    host: creds.imap.host,
    port: creds.imap.port,
    secure: creds.imap.tls,
    auth: { user: creds.imap.username, pass: creds.password },
    logger: false,
  });
  await client.connect();
  return client;
}

// listImapFolders moved to ./imap-folders.ts so the rail UI gets the
// richer shape (isSystem flag, NoSelect filtering). The old surface only
// returned name/path/specialUse — kept the export name there so any
// caller that imported it still resolves.
