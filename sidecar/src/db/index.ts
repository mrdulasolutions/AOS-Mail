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

export function initDatabase(): DatabaseInstance {
  if (db) return db;

  const dbPath = getDbPath();
  log.info("opening database", { path: dbPath });
  db = new Database(dbPath);

  // WAL allows the (legacy) Electron process to coexist as a reader during
  // the transition. Single writer at a time still applies — only run one
  // shell at once when both code paths still exist.
  db.pragma("journal_mode = WAL");

  db.exec(SCHEMA);
  initFTS5(db);

  return db;
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
