// Lightweight key-value preferences store for the sidecar.
//
// During the Electron era, mail-app used `electron-store` (an encrypted JSON
// file at <userData>/aos-mail-config.json) for *runtime* preferences plus
// the entire Config object. The sidecar doesn't have electron-store; we
// also don't want to copy its encryption-key approach (the key was
// hardcoded so it didn't actually protect anything).
//
// For Phase 1B we store renderer-side preferences (theme, density, etc.)
// in a plain JSON file at <dataDir>/preferences.json. Atomic writes via
// rename(2). Read on first access, cached in memory thereafter.
//
// As more of settings.ipc.ts gets lifted, this is where its persistence
// will live unless a value clearly belongs in SQLite (e.g. per-account
// state). Anything sensitive (OAuth tokens, API keys) should NOT live
// here — those go in OS Keychain via tauri-plugin-store / keytar later.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getDataDir } from "../db/data-dir.js";
import { createLogger } from "./logger.js";

const log = createLogger("prefs");

// Preferences is an open-shape JSON map: callers (anthropic.ts, settings
// methods, theme methods, ...) read/write whichever keys they own. Known
// keys are documented inline so engineers can grep here for the contract.
//   - theme: "light" | "dark" | "system"
//   - anthropicApiKey: string (V1 plaintext on disk; will move to Keychain)
//   - inboxDensity, undoSendDelay, keyboardBindings, signatures, ...
//   - ea: { enabled, name, email }
//   - prompts: { analysis, draft, ... }
export type Preferences = Record<string, unknown>;

let cache: Preferences | null = null;

function prefsPath(): string {
  return join(getDataDir(), "preferences.json");
}

function loadFromDisk(): Preferences {
  const path = prefsPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Preferences;
  } catch (err) {
    log.warn("preferences.json unreadable, starting fresh", { err: String(err) });
    return {};
  }
}

export function getPreferences(): Preferences {
  if (cache === null) cache = loadFromDisk();
  return { ...cache };
}

export function setPreference(key: string, value: unknown): Preferences {
  if (cache === null) cache = loadFromDisk();
  if (value === undefined) {
    const next = { ...cache };
    delete next[key];
    cache = next;
  } else {
    cache = { ...cache, [key]: value };
  }
  // Atomic write: rename(2) into place so a crash mid-write can't leave a
  // partial file at the canonical path.
  const path = prefsPath();
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, path);
  return { ...cache };
}

/** Apply a partial update — equivalent to looping setPreference per key. */
export function patchPreferences(patch: Record<string, unknown>): Preferences {
  if (cache === null) cache = loadFromDisk();
  const next: Preferences = { ...cache };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  cache = next;
  const path = prefsPath();
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, path);
  return { ...cache };
}
