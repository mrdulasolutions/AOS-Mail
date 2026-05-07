// Data directory resolution for the sidecar.
//
// The Tauri shell computes the OS-specific app data dir and passes it to the
// sidecar via the AOS_MAIL_DATA_DIR env var. We respect that when set;
// otherwise we fall back to:
//   - $AOS_MAIL_DATA_DIR if explicitly provided
//   - $XDG_DATA_HOME/AOS Mail or ~/Library/Application Support/AOS Mail on macOS
//
// Two related env vars match the Electron runtime so demo/test isolation
// keeps working through the migration:
//   - AOS_DEMO_MODE=true   → demo DB ("aos-mail-demo[-w<N>].db")
//   - AOS_TEST_MODE=true   → same as demo for DB filename selection
//   - TEST_WORKER_INDEX=N  → per-worker DB suffix for parallel Playwright

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

function defaultDataDir(): string {
  const explicit = process.env.AOS_MAIL_DATA_DIR;
  if (explicit) return explicit;

  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "AOS Mail");
  }
  if (platform() === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "AOS Mail");
  }
  // Linux / other
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, "aos-mail");
}

export function getDataDir(): string {
  const dir = defaultDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDbDir(): string {
  const dir = join(getDataDir(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDbFilename(): string {
  const isDemo = process.env.AOS_DEMO_MODE === "true";
  const isTest = process.env.AOS_TEST_MODE === "true";
  if (!isDemo && !isTest) return "aos-mail.db";
  const worker = process.env.TEST_WORKER_INDEX ? `-w${process.env.TEST_WORKER_INDEX}` : "";
  return `aos-mail-demo${worker}.db`;
}

export function getDbPath(): string {
  return join(getDbDir(), getDbFilename());
}
