// Gmail OAuth flow — sidecar implementation.
//
// Mirrors the Electron version's pattern from src/main/services/gmail-client.ts:
//   1. Build the OAuth consent URL with offline access + Gmail/Calendar scopes
//   2. Start a one-shot local HTTP server on port 3847
//   3. Return the URL to the renderer; the renderer opens it in the system
//      browser via Tauri's plugin-shell
//   4. Google redirects the browser to http://localhost:3847/oauth2callback?code=...
//   5. Our local server captures the code, exchanges it for tokens, fetches
//      the user's profile, persists tokens, and resolves
//
// Tokens are stored as JSON files (one per account) at <dataDir>/tokens-<id>.json
// in this V1 — production should escalate to OS Keychain. The Electron path
// also stored them as plaintext JSON, so this matches existing risk.

import { createServer, type Server } from "node:http";
import { writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { google, type Auth } from "googleapis";
import { getDataDir } from "../db/data-dir.js";
import { getPreferences, setPreference } from "../lib/preferences.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("oauth-gmail");

const REDIRECT_URI = "http://localhost:3847/oauth2callback";
const REDIRECT_PORT = 3847;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GmailTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null;
  id_token?: string | null;
}

export interface AuthAccount {
  accountId: string;
  email: string;
  displayName: string | null;
  tokens: GmailTokens;
}

// ── Credentials & token persistence (preferences.json + per-account files) ──

interface PrefsWithGoogle {
  googleClientId?: string;
  googleClientSecret?: string;
}

export function getCredentials(): GoogleCredentials | null {
  const p = getPreferences() as PrefsWithGoogle;
  if (!p.googleClientId || !p.googleClientSecret) return null;
  return { clientId: p.googleClientId, clientSecret: p.googleClientSecret };
}

export function setCredentials(creds: GoogleCredentials): void {
  setPreference("googleClientId", creds.clientId);
  setPreference("googleClientSecret", creds.clientSecret);
}

function tokensPath(accountId: string): string {
  return join(getDataDir(), `tokens-${accountId}.json`);
}

export function saveTokens(accountId: string, tokens: GmailTokens): void {
  writeFileSync(tokensPath(accountId), JSON.stringify(tokens, null, 2));
}

export function loadTokens(accountId: string): GmailTokens | null {
  const p = tokensPath(accountId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as GmailTokens;
  } catch {
    return null;
  }
}

export function deleteTokens(accountId: string): void {
  const p = tokensPath(accountId);
  if (existsSync(p)) unlinkSync(p);
}

export function listAccountIdsWithTokens(): string[] {
  try {
    return readdirSync(getDataDir())
      .map((name) => /^tokens-(.+)\.json$/.exec(name)?.[1])
      .filter((id): id is string => !!id);
  } catch {
    return [];
  }
}

// ── OAuth client factory ──

export function createOAuthClient(): Auth.OAuth2Client {
  const creds = getCredentials();
  if (!creds) {
    throw new Error(
      "Google OAuth credentials not configured — call gmail.saveCredentials first",
    );
  }
  return new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);
}

// ── In-flight OAuth state ──

interface PendingOAuth {
  server: Server;
  client: Auth.OAuth2Client;
  promise: Promise<AuthAccount>;
  resolve: (account: AuthAccount) => void;
  reject: (err: Error) => void;
  url: string;
}

let pending: PendingOAuth | null = null;

/**
 * Build the OAuth URL, start the loopback HTTP server, and return both.
 * The renderer is responsible for opening `url` in the system browser.
 * Resolves when the user finishes the consent flow (code exchanged + tokens
 * saved + account row written).
 *
 * Concurrent calls are rejected — only one OAuth flow may be in-flight per
 * sidecar process.
 */
export function startOAuth(): { url: string; promise: Promise<AuthAccount> } {
  if (pending) {
    return { url: pending.url, promise: pending.promise };
  }

  const client = createOAuthClient();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  let resolveFn!: (a: AuthAccount) => void;
  let rejectFn!: (e: Error) => void;
  const promise = new Promise<AuthAccount>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      if (reqUrl.pathname !== "/oauth2callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");
      if (error) throw new Error(`OAuth error: ${error}`);
      if (!code) throw new Error("OAuth callback missing code");

      const { tokens } = await client.getToken(code);
      client.setCredentials(tokens);

      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const profile = await oauth2.userinfo.get();
      const email = profile.data.email;
      if (!email) throw new Error("OAuth: profile missing email");

      const accountId = email; // use email as account id; matches existing scheme
      saveTokens(accountId, tokens as GmailTokens);

      const account: AuthAccount = {
        accountId,
        email,
        displayName: profile.data.name ?? null,
        tokens: tokens as GmailTokens,
      };
      resolveFn(account);

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`
        <!doctype html><html><head><title>AOS Mail — Connected</title>
        <style>body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;
        margin:80px auto;max-width:480px;text-align:center;color:#222}
        h1{font-size:24px}p{color:#666}</style></head>
        <body><h1>Connected to AOS Mail</h1>
        <p>You can close this tab and return to the app.</p></body></html>
      `);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("OAuth callback failed", { err: msg });
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`Authorization failed: ${msg}`);
      rejectFn(err instanceof Error ? err : new Error(msg));
    } finally {
      // One-shot server.
      server.close();
      pending = null;
    }
  });

  server.listen(REDIRECT_PORT, "127.0.0.1");
  server.on("error", (err) => {
    log.error("OAuth loopback server error", { err: String(err) });
    rejectFn(err);
    pending = null;
  });

  pending = {
    server,
    client,
    promise,
    resolve: resolveFn,
    reject: rejectFn,
    url,
  };
  return { url, promise };
}

/** Cancel an in-flight OAuth flow (e.g. user closed the browser tab). */
export function cancelOAuth(): void {
  if (!pending) return;
  try {
    pending.server.close();
  } catch {
    // ignore
  }
  pending.reject(new Error("OAuth cancelled by user"));
  pending = null;
}

/** Build an OAuth2 client that has tokens for `accountId` already set. */
export function authedClientForAccount(accountId: string): Auth.OAuth2Client {
  const tokens = loadTokens(accountId);
  if (!tokens) throw new Error(`No tokens for account ${accountId}`);
  const client = createOAuthClient();
  // Cast tokens to the SDK's Credentials shape — our GmailTokens permits
  // `string | null | undefined` for some fields (matches what the SDK
  // actually returns at runtime), but the type accepts only `string |
  // undefined`. The runtime values are compatible.
  client.setCredentials(tokens as unknown as Auth.Credentials);
  // Save refreshed tokens whenever the client gets a new access_token.
  client.on("tokens", (refreshed) => {
    const merged = { ...tokens, ...refreshed } as GmailTokens;
    saveTokens(accountId, merged);
  });
  return client;
}
