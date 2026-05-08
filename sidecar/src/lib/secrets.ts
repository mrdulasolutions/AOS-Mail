// In-memory secrets store for the sidecar.
//
// Background — issue 12 of the May 2026 post-mortem (P2 security):
// up to this point the sidecar wrote API keys, the Google OAuth
// client_secret, and IMAP passwords to plaintext fields inside
// preferences.json. Anyone with disk access could read them. The fix
// moves persistence to the OS Keychain via the Rust shell's
// `keychain_*` commands; this module is the sidecar half of the
// migration.
//
// Architecture decision (taken in p2-keychain task):
//   - The Rust shell owns the OS keychain (via the `keyring` crate).
//   - The renderer is the only caller that can `invoke()` Rust commands
//     directly, so it reads/writes the keychain on behalf of the user.
//   - The sidecar holds secrets ONLY in memory. At app boot the renderer
//     reads each secret from the keychain and pushes the bundle to the
//     sidecar via `secrets.bootstrap`. From then on, the sidecar's
//     `getSecret(name)` returns the in-memory value (or env-var fallback)
//     without ever touching the disk.
//   - When the user changes a key in Settings, the renderer writes the
//     keychain first, then forwards the new value to the sidecar via
//     `setSecret(name, value)` (typically through the existing
//     `anthropic.setApiKey`/etc. RPCs, which now delegate here).
//
// Env vars still take precedence: ANTHROPIC_API_KEY / OPENROUTER_API_KEY
// override anything stored. That preserves the existing dev/CI ergonomics
// — a developer with the env var set never has to round-trip through the
// keychain UI.
//
// The map is process-local — there is no persistence, no JSON file, and
// no fallback to preferences.json. Restart-safety is provided by the
// renderer re-bootstrapping at boot.

import { createLogger } from "./logger.js";

const log = createLogger("secrets");

/**
 * The set of secret keys we accept. Adding a new one is intentionally a
 * code change rather than an open-shape map — every secret should have a
 * documented owner, an env-var override (if applicable), and an entry
 * in the renderer's migration helper.
 */
export type SecretName =
  | "anthropicApiKey"
  | "openRouterApiKey"
  | "googleClientId"
  | "googleClientSecret"
  | `imapPassword:${string}`;

/**
 * Env-var fallbacks — checked before the in-memory map. Only a subset of
 * secrets has an env mapping today; the rest fall straight through to
 * the in-memory store (never the disk).
 */
const ENV_VAR_BY_NAME: Partial<Record<string, string>> = {
  anthropicApiKey: "ANTHROPIC_API_KEY",
  openRouterApiKey: "OPENROUTER_API_KEY",
};

const memory = new Map<string, string>();

/**
 * Read a secret. Resolution order:
 *   1. Process env (when an env-var mapping exists for this name)
 *   2. In-memory map (populated at boot via `secrets.bootstrap`)
 *
 * Returns `null` when nothing is configured. Trims whitespace defensively
 * so an accidental trailing newline (a common copy-paste issue with
 * keychain UIs) doesn't produce a "looks set but auth fails" trap.
 */
export function getSecret(name: string): string | null {
  const envName = ENV_VAR_BY_NAME[name];
  if (envName) {
    const fromEnv = process.env[envName]?.trim();
    if (fromEnv) return fromEnv;
  }
  const fromMem = memory.get(name);
  return fromMem?.trim() || null;
}

/**
 * Set or clear a secret in the in-memory map. Empty string deletes the
 * entry — matching the semantics of the renderer's "clear" buttons in
 * Settings, and avoiding "configured but blank" states downstream.
 *
 * This is only the sidecar half. Persistence lives in the OS keychain via
 * the renderer; callers that mutate from the renderer side should write
 * the keychain BEFORE forwarding to the sidecar so a process restart
 * recovers the new value.
 */
export function setSecret(name: string, value: string): void {
  if (!value) {
    memory.delete(name);
    return;
  }
  memory.set(name, value);
}

/**
 * Delete a secret from the in-memory map. Convenience over
 * setSecret(name, ""), and matches the renderer's `keychain_delete`
 * semantics. No-ops when the entry isn't present.
 */
export function deleteSecret(name: string): void {
  memory.delete(name);
}

/**
 * Wipe and repopulate the in-memory store. Called by the
 * `secrets.bootstrap` RPC at app boot, after the renderer has read all
 * secrets out of the keychain.
 *
 * We replace rather than merge so a stale entry from a previous boot
 * (e.g. user deleted a key in another window) is dropped automatically.
 */
export function bootstrapSecrets(values: Record<string, string>): void {
  memory.clear();
  let count = 0;
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== "string" || !v) continue;
    memory.set(k, v);
    count++;
  }
  log.debug("secrets bootstrapped", { count });
}

/**
 * Test/debug helper: list which secret names are present in memory.
 * Returns names ONLY — never values. Used by the diagnostic "is the
 * keychain working?" surface in Settings. NOT exposed as an RPC method.
 */
export function listConfiguredSecretNames(): string[] {
  return [...memory.keys()];
}
