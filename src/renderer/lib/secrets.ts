// Renderer-side secrets surface.
//
// The Rust shell owns the OS Keychain (see src-tauri/src/keychain.rs).
// The renderer is the only context allowed to invoke Tauri commands
// directly, so it acts as the read/write authority for all keychain-
// backed values. This module wraps the four `keychain_*` invokes with
// typed helpers, plus a one-shot migration that lifts plaintext keys
// out of the legacy preferences.json into the Keychain.
//
// Lifecycle:
//   1. App boot: `migrateLegacySecrets()` runs once. Reads each known
//      secret name from `settings.get`; if a plaintext value is there,
//      copy it into the keychain and clear the field via `settings.set`
//      with `undefined`. Idempotent — second boot is a no-op.
//   2. Boot continues: `bootstrapSidecarSecrets()` reads every secret
//      out of the keychain and pushes them to the sidecar via
//      `secrets.bootstrap`. From then on the sidecar serves those
//      values from memory without ever touching disk.
//   3. User action: SettingsPanel writes via `setSecret(...)` which
//      first stores in the keychain, then forwards the new value to
//      the sidecar via `secrets.set`.
//
// Outside a Tauri runtime (unit tests, the legacy Electron path) every
// function falls back to a no-op or stub return so callers can stay
// uniform — the migration won't run in those environments either.

import bridge from "./bridge";

/**
 * The set of secret names we manage. Mirrors `SecretName` in the
 * sidecar's `lib/secrets.ts`. IMAP per-account passwords use a
 * `imapPassword:<accountId>` suffix and are NOT included here — they
 * are added/removed alongside the account in the IMAP wizard.
 */
export type SecretName =
  | "anthropicApiKey"
  | "openRouterApiKey"
  | "googleClientId"
  | "googleClientSecret";

/** All renderer-managed top-level secret names. Used by bootstrap + migration. */
const TOP_LEVEL_SECRETS: readonly SecretName[] = [
  "anthropicApiKey",
  "openRouterApiKey",
  "googleClientId",
  "googleClientSecret",
];

async function invoke<T>(
  cmd: "keychain_set" | "keychain_get" | "keychain_delete",
  args: Record<string, unknown>,
): Promise<T | null> {
  if (!bridge.isTauri) return null;
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return (await tauriInvoke(cmd, args)) as T;
}

/**
 * Read a secret out of the OS keychain. Returns null when the entry
 * doesn't exist (or when running outside Tauri). A genuine error reading
 * the keychain (locked, missing entitlement) propagates so the UI can
 * surface it.
 */
export async function getSecret(name: string): Promise<string | null> {
  if (!name) throw new Error("getSecret: name is required");
  const value = await invoke<string | null>("keychain_get", { account: name });
  return value ?? null;
}

/**
 * Persist a secret to the OS keychain AND notify the running sidecar so
 * the change takes effect without a restart. Two writes; if the second
 * fails the keychain is still authoritative — the next process boot
 * will re-bootstrap from it.
 *
 * Empty string is treated as a delete (matches `keychain_set` semantics
 * in the Rust side, and matches how Settings UIs usually represent
 * "clear").
 */
export async function setSecret(name: string, value: string): Promise<void> {
  if (!name) throw new Error("setSecret: name is required");
  if (!bridge.isTauri) return;
  if (!value) {
    await deleteSecret(name);
    return;
  }
  await invoke<void>("keychain_set", { account: name, value });
  // Forward to the sidecar so any in-flight LLM/Gmail/IMAP work picks up
  // the new key. Best-effort: an offline sidecar is rare here (we just
  // wrote to the OS keychain); failures surface in the next bootstrap.
  try {
    await bridge.call("secrets.set", { name, value });
  } catch {
    /* sidecar will catch up at next bootstrap */
  }
}

/**
 * Remove a secret from the OS keychain AND clear it in the running
 * sidecar. Idempotent on both sides — deleting a missing entry succeeds
 * quietly, matching the renderer's "Clear key" UX.
 */
export async function deleteSecret(name: string): Promise<void> {
  if (!name) throw new Error("deleteSecret: name is required");
  if (!bridge.isTauri) return;
  await invoke<void>("keychain_delete", { account: name });
  try {
    await bridge.call("secrets.delete", { name });
  } catch {
    /* sidecar will catch up at next bootstrap */
  }
}

/**
 * One-time migration on app boot. Lifts plaintext secrets out of
 * preferences.json into the OS Keychain, then clears the plaintext
 * fields. Safe to call on every boot — it's a no-op when there's
 * nothing to migrate.
 *
 * Returns the names that were migrated this run, primarily for logging.
 *
 * Failure mode: if the keychain write fails, we DO NOT clear the
 * preferences. The user re-enters the key on next attempt rather than
 * silently losing it.
 */
export async function migrateLegacySecrets(): Promise<SecretName[]> {
  if (!bridge.isTauri) return [];

  // Pull current preferences once. The sidecar's settings.get returns
  // the merged blob — secret values, when present in the legacy file,
  // are still surfaced here. Future versions will strip them, but the
  // migration must read whatever shape exists today.
  let prefs: Record<string, unknown> = {};
  try {
    prefs = (await bridge.call<Record<string, unknown>>("settings.get", {})) ?? {};
  } catch {
    // No prefs available → nothing to migrate. Don't fail the boot.
    return [];
  }

  const migrated: SecretName[] = [];
  for (const name of TOP_LEVEL_SECRETS) {
    const stored = prefs[name];
    if (typeof stored !== "string" || !stored.trim()) continue;

    // Skip if the keychain already has a non-empty value — the user may
    // have already migrated this name, or set it directly via Settings,
    // and we don't want to clobber the canonical source. The legacy
    // pref-file value is the loser in that case; it gets stripped below.
    let existing: string | null = null;
    try {
      existing = await getSecret(name);
    } catch {
      // If the keychain read fails, bail entire migration for this name.
      continue;
    }

    if (!existing) {
      try {
        await invoke<void>("keychain_set", { account: name, value: stored });
      } catch {
        // Don't clear the pref if we couldn't write the keychain.
        continue;
      }
    }

    migrated.push(name);
  }

  // Clear the migrated fields in preferences. We do this in a single
  // settings.set call to minimize round-trips and to keep the preferences
  // file rewrite atomic from the renderer's POV. Setting a value to
  // undefined is the documented "delete this key" path in
  // patchPreferences.
  if (migrated.length > 0) {
    const clearPatch: Record<string, undefined> = {};
    for (const name of migrated) clearPatch[name] = undefined;
    try {
      await bridge.call("settings.set", clearPatch);
    } catch {
      /* best effort — keychain is now authoritative regardless */
    }
  }

  // IMAP per-account passwords: pre-keychain builds wrote the password
  // inline into <dataDir>/imap-creds-<accountId>.json. The sidecar
  // surfaces them via `secrets.collectLegacyImapPasswords`; we copy
  // each into the OS Keychain and then ask the sidecar to strip the
  // legacy field from the on-disk file. Idempotent — once a file is
  // cleaned, the sidecar returns no entries and this loop is a no-op.
  try {
    const legacy = (await bridge.call<{
      entries: Array<{ accountId: string; password: string }>;
    }>("secrets.collectLegacyImapPasswords", {})) ?? { entries: [] };
    for (const entry of legacy.entries) {
      const name = `imapPassword:${entry.accountId}`;
      const existing = await getSecret(name).catch(() => null);
      if (!existing) {
        try {
          await invoke<void>("keychain_set", {
            account: name,
            value: entry.password,
          });
        } catch {
          continue;
        }
      }
      try {
        await bridge.call("secrets.finalizeImapMigration", {
          accountId: entry.accountId,
        });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* sidecar may not have the migration RPCs (older build) — skip */
  }

  return migrated;
}

/**
 * Push the current keychain bundle to the sidecar at app boot. The
 * sidecar's `secrets.bootstrap` replaces its in-memory map with what
 * we send; it never reads from disk on its own.
 *
 * Idempotent — calling twice in a session is fine, the sidecar just
 * overwrites again.
 *
 * Includes IMAP per-account passwords by enumerating the registered
 * accounts from the sidecar's `accounts.list` and reading the
 * `imapPassword:<accountId>` entries out of the keychain.
 */
export async function bootstrapSidecarSecrets(): Promise<void> {
  if (!bridge.isTauri) return;
  const bundle: Record<string, string> = {};
  for (const name of TOP_LEVEL_SECRETS) {
    try {
      const value = await getSecret(name);
      if (value) bundle[name] = value;
    } catch {
      /* missing keys are normal — keep going */
    }
  }

  // IMAP passwords: enumerate every account, read its keychain entry.
  // Best-effort — if `accounts.list` isn't ready yet (sidecar still
  // starting), we'll re-bootstrap when the user touches a setting that
  // re-runs this path.
  try {
    const accounts =
      (await bridge.call<Array<{ id?: string; provider?: string }>>("accounts.list", {})) ?? [];
    for (const acc of accounts) {
      if (!acc?.id) continue;
      const name = `imapPassword:${acc.id}`;
      try {
        const value = await getSecret(name);
        if (value) bundle[name] = value;
      } catch {
        /* keep going; one missing IMAP password isn't fatal */
      }
    }
  } catch {
    /* accounts.list not ready — top-level secrets still get pushed */
  }

  // Always send, even if empty — the sidecar's existing in-memory state
  // could be stale (e.g. the user just migrated a key elsewhere) and
  // we want to cement a known baseline.
  await bridge.call("secrets.bootstrap", { secrets: bundle });
}

/**
 * Convenience helper: returns true if any LLM provider has a
 * keychain-backed key. Used by the boot-triage gate in App.tsx as an
 * extra signal alongside `diagnostics.hasAnyLlmProvider`.
 */
export async function hasAnyKeychainBackedLlmProvider(): Promise<boolean> {
  if (!bridge.isTauri) return false;
  const [a, b] = await Promise.all([
    getSecret("anthropicApiKey").catch(() => null),
    getSecret("openRouterApiKey").catch(() => null),
  ]);
  return !!a || !!b;
}
