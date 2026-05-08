// IMAP message actions — flag changes (read/star) and folder moves
// (archive/trash). All operate on the IMAP server first, then update
// the local emails-table label_ids so the UI reflects the change
// without waiting for the next sync.

import { openImapClient } from "./imap.js";
import { getDb } from "../../db/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("imap-actions");

interface EmailRow {
  id: string;
  account_id: string;
  label_ids: string | null;
}

function parseImapId(emailId: string): { accountId: string; folder: string; uid: number } | null {
  const m = /^imap:([^:]+):([^:]+):(\d+)$/.exec(emailId);
  if (!m) return null;
  const [, accountId, folder, uidStr] = m;
  if (!accountId || !folder || !uidStr) return null;
  return { accountId, folder, uid: Number(uidStr) };
}

function readLabels(row: EmailRow): string[] {
  if (!row.label_ids) return [];
  try {
    return JSON.parse(row.label_ids) as string[];
  } catch {
    return [];
  }
}

function writeLabels(emailId: string, labels: string[]): void {
  getDb()
    .prepare("UPDATE emails SET label_ids = ? WHERE id = ?")
    .run(JSON.stringify(labels), emailId);
}

function getEmailRow(emailId: string): EmailRow | null {
  return (
    (getDb().prepare("SELECT id, account_id, label_ids FROM emails WHERE id = ?").get(emailId) as
      | EmailRow
      | undefined) ?? null
  );
}

export async function setReadFlag(emailId: string, read: boolean): Promise<void> {
  const parsed = parseImapId(emailId);
  if (!parsed) {
    throw new Error(`setReadFlag: ${emailId} is not an IMAP id`);
  }
  const { accountId, folder, uid } = parsed;
  const client = await openImapClient(accountId);
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      if (read) {
        await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      /* best-effort */
    });
  }

  // Reflect in the local DB.
  const row = getEmailRow(emailId);
  if (row) {
    const labels = readLabels(row);
    const next = labels.filter((l) => l !== "READ");
    if (read) next.push("READ");
    writeLabels(emailId, next);
  }
}

export async function setStarFlag(emailId: string, starred: boolean): Promise<void> {
  const parsed = parseImapId(emailId);
  if (!parsed) {
    throw new Error(`setStarFlag: ${emailId} is not an IMAP id`);
  }
  const { accountId, folder, uid } = parsed;
  const client = await openImapClient(accountId);
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      if (starred) {
        await client.messageFlagsAdd(String(uid), ["\\Flagged"], { uid: true });
      } else {
        await client.messageFlagsRemove(String(uid), ["\\Flagged"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      /* best-effort */
    });
  }

  const row = getEmailRow(emailId);
  if (row) {
    const labels = readLabels(row);
    const next = labels.filter((l) => l !== "STARRED");
    if (starred) next.push("STARRED");
    writeLabels(emailId, next);
  }
}

/**
 * Find the best-fit folder for archive/trash. IMAP servers vary —
 * iCloud uses "Archive", Fastmail uses "Archive", Yahoo "Archive",
 * Outlook "Archive". Trash is universally "Trash" or close. We
 * inspect the LIST result and match by special-use first, then by
 * common names.
 */
async function resolveDestination(accountId: string, kind: "archive" | "trash"): Promise<string> {
  const client = await openImapClient(accountId);
  try {
    const list = await client.list();
    const wantedSpecialUse = kind === "archive" ? "\\Archive" : "\\Trash";
    const fallbackNames =
      kind === "archive"
        ? ["Archive", "All Mail", "[Gmail]/All Mail", "Archives"]
        : ["Trash", "Deleted", "Deleted Messages", "[Gmail]/Trash"];
    const bySpecial = list.find((b) => b.specialUse === wantedSpecialUse);
    if (bySpecial) return bySpecial.path;
    for (const name of fallbackNames) {
      const m = list.find((b) => b.path === name || b.name === name);
      if (m) return m.path;
    }
    throw new Error(`No ${kind} folder found on this IMAP server`);
  } finally {
    await client.logout().catch(() => {
      /* best-effort */
    });
  }
}

async function moveOnImap(emailId: string, destination: "archive" | "trash"): Promise<void> {
  const parsed = parseImapId(emailId);
  if (!parsed) throw new Error(`${destination}: ${emailId} is not an IMAP id`);
  const { accountId, folder, uid } = parsed;
  const dest = await resolveDestination(accountId, destination);

  const client = await openImapClient(accountId);
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageMove(String(uid), dest, { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      /* best-effort */
    });
  }
  log.info("moved message", { emailId, destination, dest });
}

export async function archiveMessage(emailId: string): Promise<void> {
  await moveOnImap(emailId, "archive");
  // Drop from local store (no longer in INBOX).
  getDb().prepare("DELETE FROM emails WHERE id = ?").run(emailId);
}

export async function trashMessage(emailId: string): Promise<void> {
  await moveOnImap(emailId, "trash");
  getDb().prepare("DELETE FROM emails WHERE id = ?").run(emailId);
}

/**
 * Inverse of archiveMessage: move the message from the Archive folder back
 * to INBOX. Used by the smart-action key undo path when the 5s window has
 * already elapsed and the archive committed to the server.
 *
 * The provided emailId encodes the *original* INBOX folder/UID
 * (`imap:<acct>:<inboxFolder>:<uid>`). After archiveMessage moves the message
 * to Archive, the UID is the destination's, not the source's — IMAP doesn't
 * preserve UIDs across folders. We therefore can't address the moved row by
 * its old id; instead we resolve the Archive folder, search by its current
 * (destination) UID is impossible from the original id alone, so this method
 * accepts an id that points at the Archive copy or simply skips the move when
 * the source no longer exists. In practice the renderer's optimistic undo
 * handles the within-5s case without ever calling unarchive — this method
 * exists for parity with the contract and as a best-effort fallback.
 */
export async function unarchiveMessage(emailId: string): Promise<void> {
  // No reliable inverse for IMAP without tracking the destination UID, which
  // we don't store. Throw so the renderer can fall back to its optimistic
  // restore (it always keeps the email blob in the undo queue).
  throw new Error(
    `unarchiveMessage: IMAP unarchive requires destination UID tracking; renderer should restore optimistically (id=${emailId})`,
  );
}
