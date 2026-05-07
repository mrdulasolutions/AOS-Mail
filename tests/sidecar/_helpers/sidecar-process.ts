// Sidecar test harness.
//
// Spawns sidecar/dist/index.cjs in a child process with a fresh tmp
// AOS_MAIL_DATA_DIR, and exposes a typed `call` / `events` / `close`
// surface for tests. Speaks NDJSON-over-stdio JSON-RPC, the same wire
// format the Tauri shell uses in production.
//
// Boundaries:
//   - Build is invoked once per Node process (idempotent; falls through
//     to a noop if dist/index.cjs already exists and is fresher than
//     src/index.ts).
//   - Each `spawnSidecar()` returns its own data dir, so tests can
//     run in parallel safely.
//   - `call()` matches request/response by a monotonic id counter.
//   - `events()` is an async iterator that yields notifications matching
//     a channel name (or "*" for everything), gated by a back-pressure
//     queue.
//   - On RPC error responses, `call()` throws an Error with `error.message`.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SIDECAR_DIR = join(REPO_ROOT, "sidecar");
const SIDECAR_DIST = join(SIDECAR_DIR, "dist", "index.cjs");
const SIDECAR_SRC = join(SIDECAR_DIR, "src", "index.ts");

let buildEnsured = false;

/**
 * Build the sidecar bundle if needed. Idempotent across calls within one
 * Node process; the first caller does the work, subsequent callers fall
 * through immediately.
 */
function ensureBuild(): void {
  if (buildEnsured) return;
  // Skip rebuild if dist exists and is at least as new as the source
  // entry point (common case: CI script already ran `npm run build`).
  let needsBuild = !existsSync(SIDECAR_DIST);
  if (!needsBuild) {
    try {
      const distMtime = statSync(SIDECAR_DIST).mtimeMs;
      const srcMtime = statSync(SIDECAR_SRC).mtimeMs;
      needsBuild = srcMtime > distMtime;
    } catch {
      needsBuild = true;
    }
  }
  if (needsBuild) {
    const result = spawnSync("npm", ["run", "build"], {
      cwd: SIDECAR_DIR,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`sidecar build failed (exit ${result.status})`);
    }
  }
  buildEnsured = true;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface Harness {
  /** Send a JSON-RPC request and resolve with the result (or throw on error). */
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /**
   * Async iterator over notifications. Pass a channel name to filter,
   * or omit / "*" to receive all notifications.
   */
  events(channel?: string): AsyncIterable<{ method: string; params: unknown }>;
  /** Kill the sidecar process and remove the tmp data dir. */
  close(): Promise<void>;
  /** The data dir for this harness — useful for direct DB access in tests. */
  dataDir: string;
  /** The DB path under dataDir. */
  dbPath: string;
}

export async function spawnSidecar(opts: { env?: Record<string, string> } = {}): Promise<Harness> {
  ensureBuild();

  const dataDir = mkdtempSync(join(tmpdir(), "aos-sidecar-test-"));

  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [SIDECAR_DIST],
    {
      env: {
        ...process.env,
        AOS_MAIL_DATA_DIR: dataDir,
        // Suppress logger console writes — they go to stderr but can be
        // distracting in test output. The logger's pretty path checks
        // NODE_ENV and a few flags; setting NODE_ENV=test is sufficient.
        NODE_ENV: "test",
        ...(opts.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const pending = new Map<number, PendingCall>();
  let nextId = 1;
  let closed = false;

  // Notification subscribers: each tap is a function that gets called with
  // every notification. The events() iterator registers a tap, drains via
  // an internal queue.
  const taps = new Set<(n: { method: string; params: unknown }) => void>();

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: RpcResponse | RpcNotification;
    try {
      parsed = JSON.parse(trimmed) as RpcResponse | RpcNotification;
    } catch {
      // Unparseable line — treat as stray output. The sidecar's own log
      // lines go to stderr, so this should be rare.
      return;
    }
    if ("id" in parsed && parsed.id !== null && parsed.id !== undefined) {
      const id = typeof parsed.id === "number" ? parsed.id : Number(parsed.id);
      const p = pending.get(id);
      if (!p) return; // stale or duplicate
      pending.delete(id);
      const r = parsed as RpcResponse;
      if (r.error) {
        p.reject(new Error(r.error.message));
      } else {
        p.resolve(r.result);
      }
    } else if ("method" in parsed) {
      // Notification.
      const n = parsed as RpcNotification;
      for (const tap of taps) {
        try {
          tap({ method: n.method, params: n.params ?? null });
        } catch {
          // Tap throwing shouldn't poison the event loop.
        }
      }
    }
  });

  // Drain stderr into the void; we pipe so the child doesn't block, but
  // tests don't need to assert on log lines.
  child.stderr.on("data", () => {});

  child.on("exit", () => {
    closed = true;
    // Reject any in-flight calls so awaiters don't hang forever.
    for (const [id, p] of pending) {
      p.reject(new Error(`sidecar exited before responding to call id=${id}`));
    }
    pending.clear();
  });

  function call<T>(method: string, params?: unknown): Promise<T> {
    if (closed) return Promise.reject(new Error("sidecar is closed"));
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      child.stdin.write(payload, (err) => {
        if (err) {
          pending.delete(id);
          reject(err);
        }
      });
    });
  }

  function events(channel = "*"): AsyncIterable<{ method: string; params: unknown }> {
    // Bounded-queue async iterator — pushes and pulls coordinate via a
    // single `next` resolver. Subscribers see every notification in
    // order; cleanup runs on `return()` (called when consumer breaks
    // out of for-await).
    const queue: Array<{ method: string; params: unknown }> = [];
    let resolveNext: ((v: { method: string; params: unknown } | null) => void) | null = null;
    let stopped = false;

    const tap = (n: { method: string; params: unknown }): void => {
      if (stopped) return;
      if (channel !== "*" && n.method !== channel) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(n);
      } else {
        queue.push(n);
      }
    };
    taps.add(tap);

    const iterator: AsyncIterator<{ method: string; params: unknown }> = {
      next: () => {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (stopped) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          resolveNext = (v) => {
            if (v === null) resolve({ value: undefined, done: true });
            else resolve({ value: v, done: false });
          };
        });
      },
      return: () => {
        stopped = true;
        taps.delete(tap);
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r(null);
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };

    return { [Symbol.asyncIterator]: () => iterator };
  }

  async function close(): Promise<void> {
    if (closed) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      return;
    }
    closed = true;
    // Notify any pending iterators.
    for (const tap of taps) {
      try {
        tap({ method: "__close__", params: null });
      } catch {
        /* noop */
      }
    }
    return new Promise<void>((resolve) => {
      const done = (): void => {
        try {
          rmSync(dataDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        resolve();
      };
      child.once("exit", done);
      try {
        child.stdin.end();
      } catch {
        /* noop */
      }
      child.kill("SIGTERM");
      // Hard kill if it doesn't exit quickly.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 2000).unref();
    });
  }

  // Wait for the sidecar to be ready (one round-trip ping). If this hangs
  // longer than 10s the build is broken; fail loudly rather than letting
  // the first real test time out.
  const ready = call("ping");
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("sidecar ping timed out after 10s")), 10000).unref(),
  );
  await Promise.race([ready, timeout]);

  return {
    call,
    events,
    close,
    dataDir,
    dbPath: join(dataDir, "data", "aos-mail.db"),
  };
}
