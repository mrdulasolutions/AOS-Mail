// Renderer <-> backend bridge.
//
// During the Electron era, `window.api.*` was injected by the preload script
// (src/preload/index.ts) and forwarded to the Electron main process via IPC.
// Under Tauri 2 + Node sidecar:
//
//     renderer  --invoke('sidecar_request', method, params)-->  Tauri (Rust)
//     Tauri     --NDJSON over stdio-->                          Node sidecar
//     sidecar   --NDJSON response-->                            Tauri
//     Tauri     --invoke result-->                              renderer
//
// And for server-sent updates:
//
//     sidecar   --notification (no id)-->                       Tauri
//     Tauri     --emit(channel, payload)-->                     renderer
//     renderer  listen(channel, cb)
//
// This module is the renderer-side surface for both directions. It exports a
// `bridge.call(method, params)` request/response helper and `bridge.listen(
// channel, cb)` for server-sent events.
//
// Lazy imports keep non-Tauri builds from pulling in @tauri-apps/api code.
//
// Retry policy:
//   `bridge.call` makes up to 3 attempts for read-only methods (sync.getEmails,
//   settings.get, etc.). Mutating methods (compose.send, emails.archive,
//   gmail.startOAuth, …) get exactly one attempt — the renderer can't safely
//   replay them without risking duplicate sends/archives. The allow-list of
//   idempotent prefixes / methods lives in `RETRYABLE_METHOD_PATTERNS` below.

import type {
  SidecarMethodName,
  SidecarMethodParams,
  SidecarMethodResult,
} from "../../shared/sidecar-contract";

type JSONValue =
  | null
  | string
  | number
  | boolean
  | JSONValue[]
  | { [k: string]: JSONValue };

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = <T>(channel: string, cb: (event: { payload: T }) => void) => Promise<() => void>;

let invokeImpl: Invoke | null = null;
let listenImpl: Listen | null = null;

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function loadInvoke(): Promise<Invoke | null> {
  if (invokeImpl) return invokeImpl;
  if (!isTauriEnv()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  invokeImpl = invoke;
  return invokeImpl;
}

async function loadListen(): Promise<Listen | null> {
  if (listenImpl) return listenImpl;
  if (!isTauriEnv()) return null;
  const { listen } = await import("@tauri-apps/api/event");
  // Adapter: keep our `{ payload: T }` shape stable regardless of @tauri-apps
  // internals. Tauri's listen returns an unlisten function.
  const adapted: Listen = async (channel, cb) =>
    await listen(channel, (e) => cb({ payload: e.payload as never }));
  listenImpl = adapted;
  return listenImpl;
}

// ── Retry policy ────────────────────────────────────────────────────────
//
// We retry only on methods we know are safe to replay. Allow-list (vs.
// deny-list) is the conservative call — a mutating method that escapes the
// list would silently get retried, and a single duplicate `compose.send` is
// a real-world headache.
//
// Patterns:
//   - Exact method names (e.g. `ping`)
//   - Glob-style "namespace.*" prefixes (e.g. `sync.get*` covers
//     `sync.getEmails`, `sync.getDrafts`, etc.)
//
// Anything not matched here gets exactly one attempt. Mutations like
// `compose.send`, `emails.archive`, `gmail.startOAuth` therefore skip the
// retry path entirely.
//
// We use simple string-matching rather than regexes to keep the table easy
// to scan in code review.

const RETRYABLE_METHOD_PATTERNS: ReadonlyArray<string> = [
  "ping",

  // Read-only namespaces — every method is a safe replay.
  "settings.get",
  "settings.getEA",
  "settings.getPrompts",
  "settings.validateApiKey",
  "theme.get",
  "anthropic.ping",
  "anthropic.hasApiKey",
  "openrouter.hasApiKey",
  "openrouter.listFreeModels",
  "openrouter.validateApiKey",
  "network.getStatus",

  // Glob entries — anything under these prefixes that is named like a
  // getter (`get*`, `list*`, `count*`, `search*`, `info`, `stats`) gets
  // retried. Other methods in the same namespace (`*.update`, `*.delete`,
  // etc.) do NOT match.
  "sync.get*",
  "sync.list*",
  "sync.stats",
  "emails.get*",
  "emails.list*",
  "emails.search*",
  "emails.count*",
  "drafts.get*",
  "drafts.list*",
  "accounts.get*",
  "accounts.list*",
  "imap.list*",
  "search.*",
  "summary.get*",
  "snippets.get*",
  "snippets.list*",
  "splits.get*",
  "splits.list*",
  "snooze.list*",
  "memory.get*",
  "memory.list*",
  "calendar.get*",
  "calendar.list*",
  "extensions.list*",
  "extensions.get*",
  "awaitingReply.list",
  "learnedRules.list",
  "analysis.get*",
  "archiveReady.get*",
  "archiveReady.list*",
  "sender.lookup",
  "usage.get*",
  "db.info",
  "db.list*",
];

function methodIsRetryable(method: string): boolean {
  for (const pattern of RETRYABLE_METHOD_PATTERNS) {
    if (pattern === method) return true;
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (method.startsWith(prefix)) return true;
    }
  }
  return false;
}

// SQLite disk-full / DB-write detection. The sidecar's better-sqlite3
// surfaces these as messages containing the canonical SQLite error tags
// (e.g. "SQLITE_FULL", "SQLITE_IOERR", "SQLITE_READONLY"). When we see one
// we throw a `BridgeError` with `kind: "disk-full"` so the renderer can
// surface a user-friendly toast instead of the raw SQLite text.
const SQLITE_DISK_PATTERNS = ["SQLITE_FULL", "disk is full", "SQLITE_IOERR", "SQLITE_READONLY"];

export interface BridgeError extends Error {
  /** Stable error kind for renderer-side branching. */
  kind?: "disk-full" | "transport" | "unknown";
  /** Originating RPC method. */
  method?: string;
  /** Number of attempts before failure (1 if retry was disabled). */
  attempts?: number;
}

function classifyError(message: string): BridgeError["kind"] {
  for (const tag of SQLITE_DISK_PATTERNS) {
    if (message.includes(tag)) return "disk-full";
  }
  return "unknown";
}

function makeError(method: string, message: string, attempts: number): BridgeError {
  const kind = classifyError(message);
  // Translated, user-friendly message for the toast layer. Raw SQLite text
  // looks scary; the kind tag lets components opt into the right copy.
  const friendly =
    kind === "disk-full"
      ? `Couldn't save changes — your disk may be full. Free up space and try again. (${method})`
      : attempts > 1
        ? `bridge.call(${method}) failed after ${attempts} attempts: ${message}`
        : `bridge.call(${method}) failed: ${message}`;
  const err = new Error(friendly) as BridgeError;
  err.kind = kind;
  err.method = method;
  err.attempts = attempts;
  return err;
}

/** Type guard so component code can branch on disk-full safely. */
export function isDiskFullError(err: unknown): err is BridgeError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    (err as BridgeError).kind === "disk-full"
  );
}

// Tunables. Kept local so we can stub them in tests via a getter without
// touching @ts-* escape hatches.
const RETRY_ATTEMPTS = 3;
const RETRY_INITIAL_DELAY_MS = 200;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_JITTER_PCT = 0.1; // ±10%

function nextDelay(attempt: number): number {
  // attempt is 1-indexed (first delay is between attempt 1 and 2).
  const base = RETRY_INITIAL_DELAY_MS * RETRY_BACKOFF_FACTOR ** (attempt - 1);
  const jitter = base * RETRY_JITTER_PCT;
  // Math.random returns [0,1); shift to [-1,1) and apply jitter band.
  const offset = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(base + offset));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Two overloads:
 *   - Method names listed in SidecarMethods are typed end-to-end. The
 *     params and result types come from the contract.
 *   - Anything else falls through to the loose form (string method name,
 *     `Record<string, unknown>` params, `JSONValue` result) so callers
 *     that haven't migrated to the contract keep compiling.
 */
export async function call<K extends SidecarMethodName>(
  method: K,
  params: SidecarMethodParams<K> extends void
    ? Record<string, never> | undefined
    : SidecarMethodParams<K>,
): Promise<SidecarMethodResult<K>>;
export async function call<T = JSONValue>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T>;
export async function call(
  method: string,
  params: unknown = {},
): Promise<unknown> {
  const invoke = await loadInvoke();
  if (!invoke) {
    throw new Error(
      `bridge.call(${method}) — not running under Tauri and no Electron shim registered`,
    );
  }

  const retry = methodIsRetryable(method);
  const maxAttempts = retry ? RETRY_ATTEMPTS : 1;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await invoke("sidecar_request", {
        method,
        params: (params ?? {}) as Record<string, unknown>,
      });
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      // Disk-full / IO errors are not transient — retrying just hammers a
      // failing disk. Bail immediately so the user sees the friendly
      // translation rather than waiting for three attempts to time out.
      if (classifyError(message) === "disk-full") break;
      // Last attempt — don't sleep, just fall through to the throw below.
      if (attempt >= maxAttempts) break;
      const delay = nextDelay(attempt);
      if (attempt === 1) {
        console.warn(
          `[bridge] ${method} attempt ${attempt}/${maxAttempts} failed; retrying in ${delay}ms`,
          message,
        );
      }
      await sleep(delay);
    }
  }

  const baseMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown error");
  throw makeError(method, baseMsg, maxAttempts);
}

/**
 * Subscribe to a server-sent event from the sidecar. The promise resolves to
 * an unsubscribe function. Outside Tauri, returns a noop unsubscribe so the
 * caller's cleanup code stays uniform.
 */
export async function listen<T = JSONValue>(
  channel: string,
  cb: (payload: T) => void,
): Promise<() => void> {
  const listenFn = await loadListen();
  if (!listenFn) return () => {};
  return await listenFn<T>(channel, ({ payload }) => cb(payload));
}

export const bridge = {
  call,
  listen,
  isTauri: isTauriEnv(),
  /** Smoke test that the Rust shell is reachable. */
  async ping(): Promise<string> {
    const invoke = await loadInvoke();
    if (!invoke) return "electron";
    return (await invoke("ping")) as string;
  },
  /** Exported for tests — never use this in app code. */
  _isMethodRetryable: methodIsRetryable,
};

export default bridge;
