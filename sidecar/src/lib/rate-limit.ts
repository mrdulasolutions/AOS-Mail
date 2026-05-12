// Process-wide token-bucket rate limiter for outgoing LLM calls.
//
// Anthropic's per-org rate limit (50 requests per minute on most plans)
// gets hit very fast when the renderer's boot triage fans out 50+ emails
// into the analyzer's concurrency-4 worker pool. Each 429 then triggers
// our own exponential-backoff retry chain (up to 5 attempts) which keeps
// other workers blocked AND amplifies the wall-clock window the user
// stares at "Triaging…" for.
//
// This limiter sits in front of every analyzer / drafter / summarizer
// call. We use a sliding-window counter rather than a token bucket so the
// rate budget refills smoothly instead of in bursts.
//
// Default: 30 requests / 60s, comfortably under the 50 RPM ceiling so a
// brief request-counted-as-429 spike doesn't push us over.

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_MS = 60_000;

interface SlidingWindowState {
  /** Timestamps of recent requests, oldest first. */
  requests: number[];
  /** Max requests allowed within `windowMs`. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

const buckets = new Map<string, SlidingWindowState>();

function getBucket(name: string, limit: number, windowMs: number): SlidingWindowState {
  let b = buckets.get(name);
  if (!b) {
    b = { requests: [], limit, windowMs };
    buckets.set(name, b);
  } else {
    // Allow callers to widen / narrow at runtime by re-passing different
    // values. Last call wins.
    b.limit = limit;
    b.windowMs = windowMs;
  }
  return b;
}

function pruneOld(b: SlidingWindowState, now: number): void {
  const cutoff = now - b.windowMs;
  // requests is oldest-first; drop everything with ts <= cutoff.
  let i = 0;
  while (i < b.requests.length) {
    const ts = b.requests[i];
    if (ts === undefined || ts > cutoff) break;
    i++;
  }
  if (i > 0) b.requests.splice(0, i);
}

/**
 * Block until the named bucket has capacity for one more request, then
 * record this caller's slot. Returns once the call may proceed; the
 * caller is expected to actually fire the request immediately after.
 *
 * Uses sliding-window: if N requests have happened in the last
 * `windowMs`, wait until the oldest one falls out of the window.
 *
 * Concurrency: callers race for the same bucket; promise resolution
 * order is FIFO via the polling loop's deterministic scheduling. Good
 * enough for our use — we don't need strict fairness, just "don't
 * exceed N/min".
 */
export async function rateLimit(
  name: string,
  options: { limit?: number; windowMs?: number } = {},
): Promise<void> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const b = getBucket(name, limit, windowMs);
  // Spin-poll with bounded sleep until we have headroom. The wait is
  // bounded by windowMs (worst case is the oldest request needs to age
  // out), so this can't hang forever.
  while (true) {
    const now = Date.now();
    pruneOld(b, now);
    if (b.requests.length < b.limit) {
      b.requests.push(now);
      return;
    }
    // Need to wait for the oldest entry to age out, plus a small jitter
    // so callers don't all wake at the same instant and re-collide.
    const oldest = b.requests[0]!;
    const waitMs = Math.max(50, oldest + b.windowMs - now + Math.floor(Math.random() * 100));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * Test-only / diagnostic: peek at the current usage of a bucket.
 */
export function bucketUsage(
  name: string,
): { current: number; limit: number; windowMs: number } | null {
  const b = buckets.get(name);
  if (!b) return null;
  pruneOld(b, Date.now());
  return { current: b.requests.length, limit: b.limit, windowMs: b.windowMs };
}

/**
 * Test-only: reset all buckets. Used in unit tests where each scenario
 * needs a fresh window.
 */
export function _resetBucketsForTesting(): void {
  buckets.clear();
}
