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
//
// CRITICAL ROBUSTNESS RULE: every write here is wrapped in try/catch.
// The logger is called from `process.on("uncaughtException", ...)` and
// from `process.on("unhandledRejection", ...)` handlers — if any write
// throws, the throw re-enters those handlers, recurses, and (in a real
// production crash) writes gigabytes of EPIPE-on-EPIPE garbage to the
// log file before Node finally OOMs. See post-mortem 2026-05-08.

import { appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from "node:fs";
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
// resolved, we cache the path; if the file write throws we disable the
// file path so subsequent calls don't keep retrying.
let resolvedLogPath: string | null | undefined;
// Once stderr writes throw (broken pipe), don't try again — recursing
// into write throws was the post-mortem 2026-05-08 root cause.
let stderrBroken = false;

// Hard cap on the log file. If it exceeds this we rotate
// (sidecar.log -> sidecar.log.prev, fresh sidecar.log). Without this a
// runaway log loop in pathological cases (a write-error storm) can fill
// the disk before anyone notices.
const LOG_MAX_BYTES = 16 * 1024 * 1024; // 16 MB
let bytesWrittenSinceRotateCheck = 0;
const ROTATE_CHECK_EVERY_BYTES = 1024 * 1024; // ≥ 1 MB between size checks

function logFilePath(): string | null {
  if (resolvedLogPath !== undefined) return resolvedLogPath;
  // Mirrors db/data-dir.ts but resolved here directly to avoid an import
  // cycle (data-dir.ts uses createLogger).
  const dir =
    process.env.AOS_DATA_DIR ?? join(homedir(), "Library", "Application Support", "AOS Mail");
  try {
    mkdirSync(dir, { recursive: true });
    resolvedLogPath = join(dir, "sidecar.log");
  } catch {
    resolvedLogPath = null;
  }
  return resolvedLogPath;
}

function rotateIfHuge(path: string): void {
  bytesWrittenSinceRotateCheck = 0;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < LOG_MAX_BYTES) return;
  const prev = path + ".prev";
  try {
    try {
      unlinkSync(prev);
    } catch {
      // ignore — first rotation
    }
    renameSync(path, prev);
  } catch {
    // Couldn't rotate; nuke the file so we don't keep growing.
    try {
      unlinkSync(path);
    } catch {
      // give up
    }
  }
}

function fmt(level: Level, scope: string, message: string, ctx?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  let ctxStr = "";
  if (ctx) {
    try {
      ctxStr = " " + JSON.stringify(ctx);
    } catch {
      // circular references etc. — skip ctx rather than throw.
      ctxStr = " [unserializable ctx]";
    }
  }
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
    let line: string;
    try {
      line = fmt(level, scope, message, ctx);
    } catch {
      return;
    }

    // 1) stderr — wrapped in try/catch so EPIPE doesn't escape. Once
    //    stderr is known broken, skip the attempt entirely so we don't
    //    keep re-entering the unhandledException handler.
    if (!stderrBroken) {
      try {
        process.stderr.write(line);
      } catch {
        stderrBroken = true;
      }
    }

    // 2) File — wrapped, with a size cap so a runaway write loop can't
    //    fill the disk.
    const path = logFilePath();
    if (path) {
      try {
        bytesWrittenSinceRotateCheck += line.length;
        if (bytesWrittenSinceRotateCheck >= ROTATE_CHECK_EVERY_BYTES) {
          rotateIfHuge(path);
        }
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
