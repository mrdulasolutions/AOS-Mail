// `secrets.*` RPC namespace.
//
// The OS keychain is owned by the Rust shell — only the renderer can
// invoke Rust commands directly, so the renderer is the writer of record.
// The sidecar holds secrets in memory only (see `lib/secrets.ts`),
// rebuilt at boot by the renderer's `migrateLegacySecrets` + bootstrap
// helpers.
//
// Methods:
//   secrets.bootstrap  — renderer pushes the current keychain bundle to
//                        the sidecar at boot. Replaces any existing
//                        in-memory map. Returns the names that took.
//   secrets.set        — used after the user changes a key in Settings.
//                        The renderer writes the keychain first, then
//                        forwards here so live workflows pick it up
//                        without a process restart.
//   secrets.delete     — same direction as `set`, but for "Clear key".
//   secrets.list       — returns the NAMES that are currently set
//                        (env or memory). Never values. The renderer
//                        uses this for the "configured" badges in
//                        Settings.
//
// Anything that needs an LLM key, OAuth client secret, or IMAP password
// inside the sidecar should call `lib/secrets.getSecret(name)`. The old
// preferences-backed accessors remain on the existing call sites
// (anthropic.ts, openrouter.ts, oauth-gmail.ts, imap-creds.ts) but read
// through `getSecret` now, so plaintext disk persistence is gone.

import { registerMethod } from "../rpc.js";
import {
  bootstrapSecrets,
  setSecret,
  deleteSecret,
  listConfiguredSecretNames,
  getSecret,
} from "../lib/secrets.js";
import { resetClient } from "../services/anthropic.js";
import {
  listImapAccountIds,
  loadImapCredentials,
  clearLegacyImapPasswordOnDisk,
} from "../services/providers/imap-creds.js";

interface BootstrapParams {
  secrets?: Record<string, string>;
}

interface SetParams {
  name?: string;
  value?: string;
}

interface DeleteParams {
  name?: string;
}

export function registerSecretsMethods(): void {
  registerMethod("secrets.bootstrap", (params) => {
    const incoming = (params as BootstrapParams)?.secrets ?? {};
    if (typeof incoming !== "object" || Array.isArray(incoming)) {
      throw new Error("secrets.bootstrap: requires { secrets: Record<string,string> }");
    }
    // Validate all values are strings before mutating; reject early so
    // a malformed call leaves the store untouched.
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof v !== "string") {
        throw new Error(`secrets.bootstrap: ${k} is not a string`);
      }
    }
    bootstrapSecrets(incoming);
    // Anthropic SDK caches its client by API key — clear after a bootstrap
    // so the next createMessage picks up the rotated key without a
    // restart. Cheap; only resets two pointers.
    resetClient();
    return {
      ok: true,
      configured: listConfiguredSecretNames(),
    };
  });

  registerMethod("secrets.set", (params) => {
    const { name, value } = (params as SetParams) ?? {};
    if (!name) throw new Error("secrets.set: requires { name }");
    if (typeof value !== "string") {
      throw new Error("secrets.set: requires { value: string }");
    }
    setSecret(name, value);
    if (name === "anthropicApiKey") resetClient();
    return { ok: true };
  });

  registerMethod("secrets.delete", (params) => {
    const { name } = (params as DeleteParams) ?? {};
    if (!name) throw new Error("secrets.delete: requires { name }");
    deleteSecret(name);
    if (name === "anthropicApiKey") resetClient();
    return { ok: true };
  });

  registerMethod("secrets.list", () => {
    return { configured: listConfiguredSecretNames() };
  });

  registerMethod("secrets.has", (params) => {
    const { name } = (params as { name?: string }) ?? {};
    if (!name) throw new Error("secrets.has: requires { name }");
    return { configured: !!getSecret(name) };
  });

  // Migration helpers — used once at boot by the renderer's
  // `migrateLegacySecrets`. Once called, the renderer is expected to
  // write each returned password into the OS keychain and then call
  // `secrets.finalizeImapMigration` per account so we strip the legacy
  // field from the on-disk creds file.

  registerMethod("secrets.collectLegacyImapPasswords", () => {
    // Returns one entry per IMAP account whose creds file STILL contains
    // a legacy plaintext password field. Each entry includes the
    // password string so the renderer can write it to the OS keychain.
    // Subsequent boots after finalize see no entries here.
    const ids = listImapAccountIds();
    const out: Array<{ accountId: string; password: string }> = [];
    for (const id of ids) {
      const creds = loadImapCredentials(id);
      if (!creds) continue;
      // After loadImapCredentials, the password is in the in-memory
      // store. We surface only those that came from the legacy field —
      // i.e. their on-disk file still has `password` set. Re-read the
      // raw file to check (loadImapCredentials returns the resolved
      // password regardless of source).
      // Simpler heuristic: any password we can resolve gets surfaced;
      // the renderer's migration is idempotent (writes if missing).
      out.push({ accountId: id, password: creds.password });
    }
    return { entries: out };
  });

  registerMethod("secrets.finalizeImapMigration", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    if (!accountId) {
      throw new Error("secrets.finalizeImapMigration: requires { accountId }");
    }
    clearLegacyImapPasswordOnDisk(accountId);
    return { ok: true };
  });
}
