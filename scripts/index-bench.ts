// Index bench for the (account_id, thread_id) composites added to the
// emails and snoozed_emails tables. Measures the hot query
//   SELECT … FROM emails WHERE thread_id = ? AND account_id = ?
// 1000× before vs. after the composite index, on a 10k-email / 3-account
// sandbox database. Reports per-query latency and total wall time so we
// can prove the new index is worth its disk cost.
//
// Usage:
//   npx tsx scripts/index-bench.ts
//
// Output: two-table comparison (no composite vs. composite) plus a
// speed-up multiplier. Self-contained — opens a temp DB under
// AOS_MAIL_DATA_DIR / fallbacks to a tmpdir, never touches the real
// production DB.

// Resolve better-sqlite3 from the sidecar workspace explicitly. The repo
// root has its own (stale) prebuilt binary that mismatches the active
// Node ABI; the sidecar workspace's binary is the one rebuilt against
// the runtime Node version (same trick the test seed helper uses).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

const __scriptDir = dirname(fileURLToPath(import.meta.url));
const __sidecarRequire = createRequire(resolve(__scriptDir, "..", "sidecar", "package.json"));
const Database = __sidecarRequire("better-sqlite3") as typeof import("better-sqlite3");
type DatabaseInstance = ReturnType<typeof Database>;

// ─── Config ──────────────────────────────────────────────────────────────────

const ACCOUNTS = 3;
const EMAILS = 10_000;
const ITERATIONS = 1_000;
// Distinct threads. Average ~10 emails/thread, comparable to a real mailbox
// where most senders form short conversations.
const THREADS_PER_ACCOUNT = Math.floor(EMAILS / ACCOUNTS / 10);

// ─── DB seeding ──────────────────────────────────────────────────────────────

interface Probe {
  threadId: string;
  accountId: string;
}

function seedDb(dbPath: string): { db: DatabaseInstance; probes: Probe[] } {
  // eslint-disable-next-line new-cap
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // Mirror the production emails table shape that the hot queries see.
  // We don't need every column — just enough to keep the row layout
  // realistic and the WHERE clause representative.
  db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      account_id TEXT DEFAULT 'default',
      thread_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      body TEXT NOT NULL,
      date TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      label_ids TEXT
    );
  `);

  const insert = db.prepare(`
    INSERT INTO emails (id, account_id, thread_id, subject, from_address,
                        to_address, body, date, fetched_at, label_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Same thread_id namespace across accounts — mirrors how IMAP UIDs and
  // some Gmail thread reuse can collide for unrelated accounts. This is
  // the case where the standalone idx_emails_thread index is forced to
  // post-filter many wrong-account rows out of the hits, which is the
  // exact pattern the post-mortem flagged.
  const probes: Probe[] = [];
  const insertMany = db.transaction(() => {
    for (let i = 0; i < EMAILS; i++) {
      const accountIdx = i % ACCOUNTS;
      const accountId = `acct-${accountIdx}`;
      const threadIdx = Math.floor(Math.random() * THREADS_PER_ACCOUNT);
      const threadId = `thread-${threadIdx}`;
      insert.run(
        `email-${i}`,
        accountId,
        threadId,
        `Subject ${i}`,
        `sender${i % 100}@example.com`,
        `recipient${accountIdx}@example.com`,
        // 200-byte body — realistic enough that the row isn't a degenerate
        // tiny thing the query planner can shortcut.
        "x".repeat(200),
        new Date(Date.now() - i * 1000).toISOString(),
        Date.now(),
        '["INBOX"]',
      );
      // Capture a probe roughly every 10 inserts so the lookup hits
      // varied threadIds across all 3 accounts.
      if (i % 10 === 0) probes.push({ threadId, accountId });
    }
  });
  insertMany();

  return { db, probes };
}

// ─── Bench ───────────────────────────────────────────────────────────────────

interface BenchResult {
  label: string;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  rowsReturned: number;
}

function benchHotQuery(db: DatabaseInstance, probes: Probe[], label: string): BenchResult {
  const stmt = db.prepare(`
    SELECT id, thread_id, account_id, subject, from_address, to_address,
           body, date, label_ids
    FROM emails
    WHERE thread_id = ? AND account_id = ?
  `);

  const samples: number[] = [];
  let rowsReturned = 0;
  // Warm-up — page cache + prepared-stmt cache. Skipped from the timed run.
  for (let i = 0; i < 50; i++) {
    const probe = probes[i % probes.length]!;
    stmt.all(probe.threadId, probe.accountId);
  }

  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const probe = probes[i % probes.length]!;
    const t0 = performance.now();
    const rows = stmt.all(probe.threadId, probe.accountId) as unknown[];
    const t1 = performance.now();
    samples.push(t1 - t0);
    rowsReturned += rows.length;
  }
  const totalMs = performance.now() - start;

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;

  return {
    label,
    totalMs,
    avgMs: totalMs / ITERATIONS,
    p50Ms: p50,
    p95Ms: p95,
    rowsReturned,
  };
}

function explain(db: DatabaseInstance): string {
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN SELECT id FROM emails WHERE thread_id = ? AND account_id = ?`)
    .all("x", "y") as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(" | ");
}

/**
 * Bench the argmax correlated subquery from services/awaiting-reply.ts.
 * For each row in the outer scan, the inner subquery probes
 * (thread_id, account_id). With 10k emails this is a 10k-probe lookup
 * pattern — exactly where the composite earns its keep. Runs the full
 * query once and reports total wall time.
 */
function benchCorrelatedArgmax(db: DatabaseInstance, label: string): BenchResult {
  const sql = `
    SELECT e.thread_id, e.account_id, e.subject, e.date
    FROM emails e
    WHERE e.account_id = ?
      AND e.date = (
        SELECT MAX(e2.date) FROM emails e2
        WHERE e2.thread_id = e.thread_id AND e2.account_id = e.account_id
      )
  `;
  const stmt = db.prepare(sql);
  // Warm-up
  stmt.all(`acct-0`);

  const samples: number[] = [];
  // Run fewer iterations because each call scans the entire table.
  const ITERATIONS_ARGMAX = 30;
  let rowsReturned = 0;
  const start = performance.now();
  for (let i = 0; i < ITERATIONS_ARGMAX; i++) {
    const t0 = performance.now();
    const rows = stmt.all(`acct-${i % ACCOUNTS}`) as unknown[];
    const t1 = performance.now();
    samples.push(t1 - t0);
    rowsReturned += rows.length;
  }
  const totalMs = performance.now() - start;
  samples.sort((a, b) => a - b);
  return {
    label,
    totalMs,
    avgMs: totalMs / ITERATIONS_ARGMAX,
    p50Ms: samples[Math.floor(samples.length * 0.5)] ?? 0,
    p95Ms: samples[Math.floor(samples.length * 0.95)] ?? 0,
    rowsReturned,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function fmtMs(n: number): string {
  return n < 1 ? `${(n * 1000).toFixed(2)}µs` : `${n.toFixed(3)}ms`;
}

function reportRow(r: BenchResult): string {
  return [
    r.label.padEnd(28),
    `total=${r.totalMs.toFixed(1)}ms`.padEnd(16),
    `avg=${fmtMs(r.avgMs)}`.padEnd(16),
    `p50=${fmtMs(r.p50Ms)}`.padEnd(16),
    `p95=${fmtMs(r.p95Ms)}`.padEnd(16),
    `rows=${r.rowsReturned}`,
  ].join("  ");
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "aos-mail-bench-"));
  const dbPath = join(dir, "bench.db");

  console.log(`bench dir: ${dir}`);
  console.log(`config: ${EMAILS} emails / ${ACCOUNTS} accounts / ${ITERATIONS} iterations`);
  console.log("");

  try {
    const { db, probes } = seedDb(dbPath);

    // ── Baseline: no thread index of any kind, just the emails PK on id.
    // Force a no-index scan by leaving the table un-indexed for the
    // pre-existing-baseline measurement.
    console.log("── Baseline: no index on (thread_id, account_id) ──");
    console.log(`  EXPLAIN: ${explain(db)}`);
    const baseline = benchHotQuery(db, probes, "no index");
    console.log("  " + reportRow(baseline));
    console.log("");

    // ── Old state: standalone idx_emails_thread (the pre-composite
    // production index). Forces a thread_id seek + post-filter on
    // account_id, which is exactly what the post-mortem flagged.
    db.exec(`CREATE INDEX idx_emails_thread ON emails(thread_id);`);
    db.exec(`CREATE INDEX idx_emails_account ON emails(account_id);`);
    db.exec("ANALYZE;");
    console.log("── Pre-fix: idx_emails_thread (thread_id) + idx_emails_account ──");
    console.log(`  EXPLAIN: ${explain(db)}`);
    const preFix = benchHotQuery(db, probes, "single-col indexes");
    console.log("  " + reportRow(preFix));
    const preFixArgmax = benchCorrelatedArgmax(db, "argmax (single-col)");
    console.log("  " + reportRow(preFixArgmax));
    console.log("");

    // ── New state: drop the old standalone thread index, add the
    // composite. Mirrors exactly what the migration in db/index.ts
    // does on first launch (idx_emails_account stays, idx_emails_thread
    // goes, idx_emails_account_thread is added).
    db.exec(`DROP INDEX idx_emails_thread;`);
    db.exec(`CREATE INDEX idx_emails_account_thread ON emails(account_id, thread_id);`);
    db.exec("ANALYZE;");
    console.log("── Post-fix: idx_emails_account_thread (account_id, thread_id) ──");
    console.log(`  EXPLAIN: ${explain(db)}`);
    const postFix = benchHotQuery(db, probes, "composite");
    console.log("  " + reportRow(postFix));
    const postFixArgmax = benchCorrelatedArgmax(db, "argmax (composite)");
    console.log("  " + reportRow(postFixArgmax));
    console.log("");

    console.log("── Hot query (single-shot WHERE thread_id=? AND account_id=?) ──");
    console.log(`  avg: ${(preFix.avgMs / postFix.avgMs).toFixed(2)}× faster`);
    console.log(`  p95: ${(preFix.p95Ms / postFix.p95Ms).toFixed(2)}× faster`);
    console.log(`  total: ${(preFix.totalMs / postFix.totalMs).toFixed(2)}× faster`);
    console.log("── Argmax correlated subquery (awaiting-reply.ts pattern) ──");
    console.log(`  avg: ${(preFixArgmax.avgMs / postFixArgmax.avgMs).toFixed(2)}× faster`);
    console.log(`  p95: ${(preFixArgmax.p95Ms / postFixArgmax.p95Ms).toFixed(2)}× faster`);
    console.log("");
    console.log("Single-shot lookup gain is modest (the planner already had");
    console.log("an index to use); the real win is the correlated-subquery");
    console.log("path that fires once per outer row in awaiting-reply.ts.");
    console.log("That dominates the user-facing latency on large mailboxes.");

    db.close();
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

main();
