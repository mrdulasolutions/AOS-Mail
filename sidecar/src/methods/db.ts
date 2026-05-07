// DB-related sidecar methods.
//
// `db.info`         — smoke test: DB path, table count, row counts.
// `db.listAccounts` — diagnostic: full accounts table (proves SELECTs
//                     of real rows work, not just COUNT metadata).
//
// As DB-using IPC namespaces get lifted, they'll register their own
// methods alongside these. This file stays small — domain methods belong
// in their own namespace files (see network.ts as the pattern).

import { registerMethod } from "../rpc.js";
import { getDb, getDbInfo } from "../db/index.js";

interface AccountRow {
  id: string;
  email: string;
  display_name: string | null;
  is_primary: number;
  added_at: number;
}

export function registerDbMethods(): void {
  registerMethod("db.info", () => getDbInfo());

  registerMethod("db.listAccounts", () => {
    const rows = getDb()
      .prepare("SELECT id, email, display_name, is_primary, added_at FROM accounts ORDER BY added_at")
      .all() as AccountRow[];
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      isPrimary: r.is_primary === 1,
      addedAt: r.added_at,
    }));
  });
}
