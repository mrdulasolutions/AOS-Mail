// Sidecar logger.
//
// stdout is reserved for JSON-RPC traffic — anything we write there gets
// parsed as a response/notification by the Tauri shell and confuses it.
// All sidecar logs therefore go to stderr (which Tauri captures as DEBUG
// level via tauri-plugin-shell).
//
// Format: `[<level>] <ts> [<scope>] <message> {<json-context>}`
// Keep it lightweight; pino was overkill for the sidecar's stdio usage.

type Level = "debug" | "info" | "warn" | "error";

const ENABLED: Record<Level, boolean> = {
  debug: process.env.AOS_LOG_LEVEL === "debug",
  info: true,
  warn: true,
  error: true,
};

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
    process.stderr.write(fmt(level, scope, message, ctx));
  };
  return {
    debug: (msg, ctx) => emit("debug", msg, ctx),
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
  };
}
