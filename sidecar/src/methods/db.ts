// DB-related sidecar methods.
//
// `db.info` is the smoke test: returns the DB path, table count, and a few
// row counts so the renderer (and the dev console) can confirm the SQLite
// pipeline is wired correctly. As DB-using IPC namespaces get lifted, they
// register their own methods — this file stays small.

import { registerMethod } from "../rpc.js";
import { getDbInfo } from "../db/index.js";

export function registerDbMethods(): void {
  registerMethod("db.info", () => getDbInfo());
}
