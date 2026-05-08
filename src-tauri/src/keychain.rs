// Keychain-backed secret storage.
//
// Why this lives in Rust, not in the Node sidecar:
//   - macOS's Keychain Services API is a Security-framework Objective-C
//     surface. The `keyring` crate wraps it directly — no JS native module
//     to compile, no postinstall script that breaks on `electron-rebuild`.
//   - The sidecar process currently writes secrets to plaintext JSON
//     (preferences.json). Moving them to OS-managed storage means the
//     bytes never hit a regular file on disk in cleartext.
//   - The Tauri shell is the only piece of the stack that already speaks
//     to the OS; routing secrets through it keeps the sidecar's
//     responsibilities narrow (sync, agent, DB) without adding a native
//     dependency to its dist bundle.
//
// Trust model:
//   - Service name is `com.mrdulasolutions.aosmail` (matches the Tauri
//     identifier; on macOS each Keychain item is namespaced by the
//     calling app's signing identity AND the service string we provide,
//     so collisions with other apps are impossible).
//   - Account names are short logical keys: `anthropicApiKey`,
//     `openRouterApiKey`, `googleClientSecret`, `imapPassword:<accountId>`.
//     Anything callable from JS is exposed as a Tauri command — the
//     renderer is responsible for naming, but a hostile renderer can't
//     read OUTSIDE the service prefix because the OS keychain limits us
//     by app identity.
//
// Errors collapse to `String` so the renderer's existing `invoke().catch`
// pattern surfaces them as readable text in toasts and log lines. We do
// NOT distinguish "not found" from "decryption failed" for the renderer:
// both look like None for `get`, and the migration path treats them as
// "key isn't there yet, write it".

use keyring::Entry;

/// Service identifier used for every keychain item. Matches the Tauri
/// app identifier in `tauri.conf.json` so each item is namespaced both
/// by app identity (enforced by the OS) and by this string.
const SERVICE: &str = "com.mrdulasolutions.aosmail";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account)
        .map_err(|e| format!("failed to open keychain entry for {}: {}", account, e))
}

/// Persist a secret under the given account name. Overwrites any existing
/// value for the same account. Empty strings are treated as deletes — the
/// keychain libraries surface zero-length passwords inconsistently across
/// platforms, and "store empty" is never a useful operation here.
#[tauri::command]
pub fn keychain_set(account: String, value: String) -> Result<(), String> {
    if account.trim().is_empty() {
        return Err("keychain_set: account name is required".into());
    }
    if value.is_empty() {
        // Caller wants to delete; route through the same entry.
        return keychain_delete(account);
    }
    let e = entry(&account)?;
    e.set_password(&value)
        .map_err(|err| format!("failed to write keychain entry: {}", err))
}

/// Read a secret. Returns `Ok(None)` when there is nothing stored for the
/// given account — this is the common case during the legacy-secrets
/// migration, where the renderer probes each account and writes only if
/// missing. `Err` is reserved for genuine OS-level failures (locked
/// keychain, missing entitlement, etc.).
#[tauri::command]
pub fn keychain_get(account: String) -> Result<Option<String>, String> {
    if account.trim().is_empty() {
        return Err("keychain_get: account name is required".into());
    }
    let e = entry(&account)?;
    match e.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("failed to read keychain entry: {}", err)),
    }
}

/// Remove a secret. Idempotent — deleting a missing entry succeeds quietly,
/// because the renderer's "clear API key" UI calls this regardless of
/// whether the user previously stored one.
#[tauri::command]
pub fn keychain_delete(account: String) -> Result<(), String> {
    if account.trim().is_empty() {
        return Err("keychain_delete: account name is required".into());
    }
    let e = entry(&account)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("failed to delete keychain entry: {}", err)),
    }
}
