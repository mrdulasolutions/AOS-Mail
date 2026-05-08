// Background-task registry — small bookkeeping helper for fire-and-forget
// promises that we still want to flush on graceful shutdown.
//
// Why this exists:
//   Several IPC verbs deliberately don't await downstream Claude calls so
//   the renderer's archive/trash latency stays low. Without a registry,
//   when the sidecar exits (stdin closes / SIGTERM) any in-flight Claude
//   call dies with the process — its `recordCall` row never flushes, the
//   learned-rules upsert never lands, etc. See post-mortem P3 #18.
//
// Contract:
//   - track(label, p) — register a promise. Errors are caught + logged;
//     never re-thrown. The promise auto-deregisters when it settles.
//   - awaitAll(timeoutMs) — wait for everything currently tracked. Returns
//     the count of tasks that finished within the timeout. Tasks that
//     resolve after the timeout still run, but we don't block on them.
//   - count() — number of currently-tracked tasks (mostly for tests).
//
// We deliberately don't surface a "cancel" — the work is small (a single
// Claude call + DB upsert) and cancellation would lose the very signal
// the caller wanted to record. Just give it ~3 s to flush on shutdown.

import { createLogger } from "./logger.js";

const log = createLogger("background-tasks");

const outstanding = new Set<Promise<unknown>>();

/**
 * Register a fire-and-forget promise so the process can flush it on
 * shutdown. Errors are logged with `label` and swallowed — track() never
 * throws. The returned promise resolves when `p` settles either way.
 */
export function track<T>(label: string, p: Promise<T>): Promise<void> {
  const wrapped = p
    .then(() => undefined)
    .catch((err) => {
      log.warn("background task failed", {
        label,
        err: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      outstanding.delete(wrapped);
    });
  outstanding.add(wrapped);
  return wrapped;
}

/**
 * Block (up to `timeoutMs`) until every currently-tracked task has settled.
 * Returns the number of tasks that finished within the timeout. New tasks
 * registered DURING the await are also waited on — useful when shutdown
 * itself triggers a final flush.
 */
export async function awaitAll(timeoutMs = 3_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let drained = 0;
  while (outstanding.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const snapshot = [...outstanding];
    const timer = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), remainingMs).unref?.(),
    );
    const racer = Promise.all(snapshot).then(() => "drained" as const);
    const winner = await Promise.race([timer, racer]);
    if (winner === "timeout") break;
    drained += snapshot.length;
  }
  return drained;
}

/** Number of tasks currently being tracked. */
export function count(): number {
  return outstanding.size;
}

/** Test-only: clear the registry without awaiting. */
export function _resetForTesting(): void {
  outstanding.clear();
}
