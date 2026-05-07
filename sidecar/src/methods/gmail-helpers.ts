// Shared helpers between gmail.ts and accounts.ts so each can keep its
// own surface tidy without duplicating the upsert-account logic.

import { getDb } from "../db/index.js";

interface AccountRow {
  id: string;
}

export function upsertAccountAfterAuth(
  accountId: string,
  email: string,
  displayName: string | null,
): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM accounts WHERE id = ?")
    .get(accountId) as AccountRow | undefined;
  if (existing) {
    db.prepare("UPDATE accounts SET email = ?, display_name = ? WHERE id = ?").run(
      email,
      displayName,
      accountId,
    );
    return;
  }
  const count = (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  db.prepare(
    "INSERT INTO accounts (id, email, display_name, is_primary, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(accountId, email, displayName, count === 0 ? 1 : 0, Date.now());
}
