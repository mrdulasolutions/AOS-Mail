// Generic atomic JSON file store.
//
// Used for sidecar state that's not big enough or relational enough to live
// in SQLite — preferences, snippets, splits, etc. Each store is one file
// at <dataDir>/<name>.json with atomic-rename(2) writes so a crash mid-
// write can't leave a corrupt file at the canonical path.
//
// Pattern: openStore<Shape>(name, defaults) returns { read, write }.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getDataDir } from "../db/data-dir.js";
import { createLogger } from "./logger.js";

const log = createLogger("json-store");

export interface JsonStore<T> {
  read(): T;
  write(value: T): void;
  patch(updater: (current: T) => T): T;
}

export function openStore<T>(name: string, defaults: T): JsonStore<T> {
  const path = join(getDataDir(), `${name}.json`);
  let cache: T | null = null;

  function load(): T {
    if (!existsSync(path)) return structuredClone(defaults);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as T;
      if (parsed === null || typeof parsed !== "object") return structuredClone(defaults);
      return parsed;
    } catch (err) {
      log.warn(`${name}.json unreadable, falling back to defaults`, { err: String(err) });
      return structuredClone(defaults);
    }
  }

  function save(value: T): void {
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  }

  return {
    read(): T {
      if (cache === null) cache = load();
      return structuredClone(cache);
    },
    write(value: T): void {
      cache = value;
      save(value);
    },
    patch(updater: (current: T) => T): T {
      if (cache === null) cache = load();
      const next = updater(structuredClone(cache));
      cache = next;
      save(next);
      return structuredClone(next);
    },
  };
}
