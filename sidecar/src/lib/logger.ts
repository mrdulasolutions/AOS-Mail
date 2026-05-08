// Sidecar logger.
//
// stdout is reserved for JSON-RPC traffic — anything we write there gets
// parsed as a response/notification by the Tauri shell and confuses it.
// All sidecar logs therefore go to stderr (which Tauri captures as DEBUG
// level via tauri-plugin-shell) AND to a sidecar.log file under the data
// directory so post-mortem debugging works in production where stderr is
// dropped at the default Rust log level.
//
// Format: `[<level>] <ts> [<scope>] <message> {<json-context>}`
// Keep it lightweight; pino was overkill for the sidecar's stdio usage.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type Level = "debug" | "info" | "warn" | "error";

const ENABLED: Record<Level, boolean> = {
  debug: process.env.AOS_LOG_LEVEL === "debug",
  info: true,
  warn: true,
  error: true,
};

// File-logging is initialised lazily on first write so we don't create the
// directory at module-load time before the data dir is established. Once
// resolved, we cache the path; if the file write throws we fall back to
// stderr-only and never retry the file path again.
let resolvedLogPath: string | null | undefined;

function logFilePath(): string | null {
  if (resolvedLogPath !== undefined) return resolvedLogPath;
  // Mirrors db/data-dir.ts but resolved here directly to avoid an import
  // cycle (data-dir.ts uses createLogger).
  const dir =
    process.env.AOS_DATA_DIR ??
    join(homedir(), "Library", "Application Support", "AOS Mail");
  try {
    mkdirSync(dir, { recursive: true });
    resolvedLogPath = join(dir, "sidecar.log");
  } catch {
    resolvedLogPath = null;
  }
  return resolvedLogPath;
}

function fmt(level: Level, scope: string, message: string, ctx?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const ctxStr = ctx ? " " + JSON.stringify(ctx) : "";
  return `[${level.toUpperCase()}] ${ts} [${scope}] ${message}${ctxStr}\n`;
}

export interface Logger {
  debug(message: string, ctx?: Record<string, unknown>): void;
  info(message: string, ctx?: Record<string, unknown>): void;
  warn(message: string, ctx?: Record<string, unknown>): void;
  error(message: string, ctx?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  const emit = (level: Level, message: string, ctx?: Record<string, unknown>) => {
    if (!ENABLED[level]) return;
    const line = fmt(level, scope, message, ctx);
    process.stderr.write(line);
    const path = logFilePath();
    if (path) {
      try {
        appendFileSync(path, line);
      } catch {
        // Disable further file writes — disk full / permissions / etc.
        resolvedLogPath = null;
      }
    }
  };
  return {
    debug: (msg, ctx) => emit("debug", msg, ctx),
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
  };
}
