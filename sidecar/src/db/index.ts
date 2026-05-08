// SQLite opener for the sidecar.
//
// Lifted from src/main/db/index.ts but slimmed down to just opening the DB
// and applying the schema. Query functions get ported on demand as IPC
// namespaces are lifted into sidecar/src/methods/.
//
// We intentionally skip the Electron-era `runMigrations()` here. The
// production DB on disk has already had every Electron migration applied
// during the user's history with mail-app/exo; the sidecar joins that DB
// in its current shape. The SCHEMA constant uses CREATE TABLE IF NOT EXISTS
// so it's safe against an already-populated DB.

import Database from "better-sqlite3";
import { getDbPath } from "./data-dir.js";
import { SCHEMA, FTS5_SCHEMA, FTS5_TRIGGERS } from "./schema.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("db");

type DatabaseInstance = Database.Database;

let db: DatabaseInstance | null = null;

// Errors we expect to swallow during the ad-hoc ADD COLUMN migration loop.
// Anything outside this whitelist is a real failure (disk full, malformed
// SQL, type mismatch, etc.) and MUST be surfaced — the previous behavior of
// silently logging-and-continuing left the schema in a half-migrated state.
//
// Patterns:
//   - duplicate column name: idempotent ALTER on a re-run after the column
//     was already added.
//   - "no such table": the parent table doesn't exist yet (e.g. running
//     against a fresh DB before CREATE TABLE has run for archive_ready).
//     The CREATE TABLE IF NOT EXISTS in SCHEMA covers this on the same
//     init pass, but defensive against ordering surprises.
const EXPECTED_MIGRATION_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /duplicate column name/i,
  /no such table/i,
];

function isExpectedMigrationError(msg: string): boolean {
  return EXPECTED_MIGRATION_ERROR_PATTERNS.some((p) => p.test(msg));
}

export function initDatabase(): DatabaseInstance {
  if (db) return db;

  const dbPath = getDbPath();
  log.info("opening database", { path: dbPath });
  db = new Database(dbPath);

  // WAL allows the (legacy) Electron process to coexist as a reader during
  // the transition. Single writer at a time still applies — only run one
  // shell at once when both code paths still exist.
  db.pragma("journal_mode = WAL");

  // Foreign-key enforcement is OFF by default in SQLite (a backwards-compat
  // hangover) so FK declarations like `analyses.email_id REFERENCES
  // emails(id)` are advisory until this pragma is set. With it ON, any
  // ON DELETE CASCADE clause on dependent tables will fire automatically
  // when the parent row is removed — essential for keeping `analyses` and
  // `drafts` in sync after IMAP archive's `DELETE FROM emails`.
  db.pragma("foreign_keys = ON");

  db.exec(SCHEMA);
  initFTS5(db);

  // llm_calls is created lazily by anthropic-service in the Electron path.
  // Mirror that here so a fresh sidecar-only install still has the table
  // for usage queries.
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_calls (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL,
      caller TEXT NOT NULL,
      email_id TEXT,
      account_id TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_create_tokens INTEGER DEFAULT 0,
      cost_cents REAL NOT NULL,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created_at ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_caller ON llm_calls(caller);
  `);

  // Provider columns on accounts. Older mail-app DBs only had the Gmail
  // shape; AOS Mail supports gmail + imap (and Microsoft Graph later).
  // ALTER TABLE ADD COLUMN is idempotent in SQLite via try/catch — once a
  // column exists the second invocation throws "duplicate column name"
  // which we swallow. Any OTHER error (disk full, type mismatch, syntax
  // error in the DDL itself) is surfaced — the previous behavior of
  // logging-and-continuing left a half-migrated schema in production.
  for (const ddl of [
    "ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'gmail'",
    "ALTER TABLE accounts ADD COLUMN imap_host TEXT",
    "ALTER TABLE accounts ADD COLUMN imap_port INTEGER",
    "ALTER TABLE accounts ADD COLUMN imap_username TEXT",
    "ALTER TABLE accounts ADD COLUMN smtp_host TEXT",
    "ALTER TABLE accounts ADD COLUMN smtp_port INTEGER",
    "ALTER TABLE accounts ADD COLUMN tls_enabled INTEGER NOT NULL DEFAULT 1",
    // load-more pagination cursor for the inbox window. Gmail stores its
    // nextPageToken so the next "Load more" click resumes mid-list; IMAP
    // doesn't need a cursor (it derives from the current min UID in DB).
    "ALTER TABLE sync_state ADD COLUMN load_more_token TEXT",
    // archive_ready.dismissed — defensive ALTER for any DB created before
    // the column landed in the canonical schema. CREATE TABLE IF NOT
    // EXISTS won't add columns to an existing table, so the migration
    // covers in-place upgrades.
    "ALTER TABLE archive_ready ADD COLUMN dismissed INTEGER DEFAULT 0",
  ]) {
    try {
      db.exec(ddl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isExpectedMigrationError(msg)) continue;
      // Unexpected error — log loudly AND throw so a genuinely failed
      // migration isn't lost. A half-migrated DB silently returns
      // `undefined` for missing columns at row-mapper time, which is
      // worse than a clean startup failure.
      log.error("schema migration step failed", { ddl, err: msg });
      throw new Error(`Schema migration failed for "${ddl}": ${msg}`);
    }
  }

  // Add ON DELETE CASCADE to analyses(email_id) and drafts(email_id) so
  // when an email is deleted (e.g. IMAP archive's `DELETE FROM emails`),
  // the dependent rows go with it. SQLite has no `ALTER TABLE … ALTER
  // CONSTRAINT`, so we rebuild the table only when the existing FK lacks
  // a cascade clause. Idempotent: a second run sees the cascade is
  // already in place and bails before touching the table.
  ensureCascadeOnEmailIdFK(db, "analyses");
  ensureCascadeOnEmailIdFK(db, "drafts");

  return db;
}

/**
 * Idempotently add `ON DELETE CASCADE` to the email_id FK on a dependent
 * table. SQLite doesn't support modifying a constraint in place, so this
 * detects the missing cascade and rebuilds the table preserving all rows.
 *
 * Cheap on the common path: if the constraint already cascades (or the
 * table doesn't exist), this is a single PRAGMA call.
 */
function ensureCascadeOnEmailIdFK(d: DatabaseInstance, tableName: string): void {
  // Bail if the table doesn't exist (shouldn't happen post-SCHEMA exec, but
  // defensive).
  const exists = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  if (!exists) return;

  // foreign_key_list returns one row per FK with `on_delete` (NO ACTION
  // / RESTRICT / SET NULL / SET DEFAULT / CASCADE). We only care about
  // the one that targets emails(id).
  const fks = d.pragma(`foreign_key_list("${tableName}")`) as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }>;
  const emailFk = fks.find((f) => f.table === "emails" && f.from === "email_id");
  if (!emailFk) {
    // No FK to emails — nothing to upgrade. Either the table is
    // schemaless (FK was never declared) or we're looking at the wrong
    // table; either way no-op.
    return;
  }
  if (emailFk.on_delete === "CASCADE") {
    // Already has cascade — done.
    return;
  }

  log.info("rebuilding table to add ON DELETE CASCADE to email_id FK", { table: tableName });

  // SQLite recommends the 12-step ALTER procedure
  // (https://www.sqlite.org/lang_altertable.html); the short-form via
  // CREATE+INSERT+DROP+RENAME inside a transaction is the standard
  // workaround for "can't ALTER CONSTRAINT". Foreign keys must be
  // disabled during the rename so the temp table's FK doesn't fire on
  // the intermediate DROP.
  //
  // Caller already enabled foreign_keys = ON; we toggle it within this
  // function and restore at the end. Wrapping in `transaction(() => …)`
  // ensures atomicity — a failure halfway through rolls back fully.
  d.pragma("foreign_keys = OFF");
  try {
    const rebuild = d.transaction(() => {
      if (tableName === "analyses") {
        d.exec(`
          CREATE TABLE analyses__new (
            email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
            needs_reply INTEGER NOT NULL,
            reason TEXT NOT NULL,
            priority TEXT,
            analyzed_at INTEGER NOT NULL
          );
          INSERT INTO analyses__new (email_id, needs_reply, reason, priority, analyzed_at)
            SELECT email_id, needs_reply, reason, priority, analyzed_at FROM analyses;
          DROP TABLE analyses;
          ALTER TABLE analyses__new RENAME TO analyses;
          CREATE INDEX IF NOT EXISTS idx_analyses_needs_reply ON analyses(needs_reply);
        `);
      } else if (tableName === "drafts") {
        d.exec(`
          CREATE TABLE drafts__new (
            email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
            draft_body TEXT NOT NULL,
            gmail_draft_id TEXT,
            status TEXT DEFAULT 'pending',
            created_at INTEGER NOT NULL,
            agent_task_id TEXT,
            cc TEXT,
            bcc TEXT,
            compose_mode TEXT,
            to_recipients TEXT
          );
          INSERT INTO drafts__new (email_id, draft_body, gmail_draft_id, status, created_at,
                                    agent_task_id, cc, bcc, compose_mode, to_recipients)
            SELECT email_id, draft_body, gmail_draft_id, status, created_at,
                   agent_task_id, cc, bcc, compose_mode, to_recipients FROM drafts;
          DROP TABLE drafts;
          ALTER TABLE drafts__new RENAME TO drafts;
          CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
        `);
      }
    });
    rebuild();
  } finally {
    d.pragma("foreign_keys = ON");
  }
}

function initFTS5(d: DatabaseInstance): void {
  try {
    const ftsExists = d
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='emails_fts'")
      .get();

    if (!ftsExists) {
      d.exec(FTS5_SCHEMA);
      d.exec(FTS5_TRIGGERS);
      log.info("FTS5 emails_fts initialized");
    }
  } catch (err) {
    log.error("FTS5 init failed", { err: String(err) });
  }
}

export function getDb(): DatabaseInstance {
  return initDatabase();
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch (e) {
      log.warn("close failed", { err: String(e) });
    }
    db = null;
  }
}

export interface DbInfo {
  path: string;
  walEnabled: boolean;
  tableCount: number;
  emailCount: number;
  threadCount: number;
  accountCount: number;
}

/**
 * Cheap diagnostic the renderer / Tauri shell can hit to confirm the DB
 * pipeline is alive.
 */
export function getDbInfo(): DbInfo {
  const d = getDb();
  const tableCount = (
    d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as {
      n: number;
    }
  ).n;
  const safeCount = (sql: string): number => {
    try {
      return (d.prepare(sql).get() as { n: number }).n;
    } catch {
      return 0;
    }
  };
  return {
    path: getDbPath(),
    walEnabled: (d.pragma("journal_mode", { simple: true }) as string) === "wal",
    tableCount,
    emailCount: safeCount("SELECT COUNT(*) AS n FROM emails"),
    threadCount: safeCount("SELECT COUNT(DISTINCT thread_id) AS n FROM emails"),
    accountCount: safeCount("SELECT COUNT(*) AS n FROM accounts"),
  };
}
