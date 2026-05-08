// IMAP message actions — flag changes (read/star) and folder moves
// (archive/trash). All operate on the IMAP server first, then update
// the local emails-table label_ids so the UI reflects the change
// without waiting for the next sync.

import { openImapClient } from "./imap.js";
import { getDb } from "../../db/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("imap-actions");

// Map of original-IMAP-id → destination-(folder, uid) captured at archive
// time. IMAP doesn't preserve UIDs across folders, so without this we
// can't address a moved message to undo. Lazy CREATE matches the pattern
// in db/index.ts (llm_calls, error_log).
let archiveTrackTableEnsured = false;
function ensureArchiveTrackTable(): void {
  if (archiveTrackTableEnsured) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS imap_archive_track (
      original_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      source_folder TEXT NOT NULL,
      source_uid INTEGER NOT NULL,
      dest_folder TEXT NOT NULL,
      dest_uid INTEGER,
      moved_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_imap_archive_track_account ON imap_archive_track(account_id);
  `);
  archiveTrackTableEnsured = true;
}

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

interface MoveResult {
  destFolder: string;
  /**
   * UID of the message in the destination mailbox. Only populated if the
   * server supports the UIDPLUS extension — almost every modern server does
   * (Gmail-IMAP, iCloud, Fastmail, Yahoo, Outlook, Dovecot, Cyrus). On the
   * rare server without UIDPLUS we still return the move result with
   * destUid undefined; unarchive falls back to a Message-ID search in that
   * case.
   */
  destUid?: number;
}

async function moveOnImap(emailId: string, destination: "archive" | "trash"): Promise<MoveResult> {
  const parsed = parseImapId(emailId);
  if (!parsed) throw new Error(`${destination}: ${emailId} is not an IMAP id`);
  const { accountId, folder, uid } = parsed;
  const dest = await resolveDestination(accountId, destination);

  const client = await openImapClient(accountId);
  let destUid: number | undefined;
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const moveResp = await client.messageMove(String(uid), dest, { uid: true });
      // imapflow returns CopyResponseObject | false. The uidMap is only
      // populated when the server speaks UIDPLUS — `key` is the source UID
      // (BigInt or number depending on the server), `value` is the dest
      // UID. We coerce both sides to Number — Gmail history ids overflow
      // 32-bit but UIDs do not in practice.
      if (moveResp && moveResp.uidMap) {
        for (const [srcUid, dstUid] of moveResp.uidMap.entries()) {
          if (Number(srcUid) === uid) {
            destUid = Number(dstUid);
            break;
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      /* best-effort */
    });
  }
  log.info("moved message", { emailId, destination, dest, destUid });
  return { destFolder: dest, destUid };
}

export async function archiveMessage(emailId: string): Promise<void> {
  const parsed = parseImapId(emailId);
  if (!parsed) throw new Error(`archive: ${emailId} is not an IMAP id`);
  const { accountId, folder: srcFolder, uid: srcUid } = parsed;

  const { destFolder, destUid } = await moveOnImap(emailId, "archive");

  // Track the original-id → destination mapping so unarchive can find the
  // moved message later. Best-effort: a missing destUid (UIDPLUS-less
  // server) still records the destFolder so unarchive can fall back to a
  // Message-ID search there.
  ensureArchiveTrackTable();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO imap_archive_track
         (original_id, account_id, source_folder, source_uid,
          dest_folder, dest_uid, moved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(emailId, accountId, srcFolder, srcUid, destFolder, destUid ?? null, Date.now());

  // Drop from local store (no longer in INBOX). Tracking row stays;
  // unarchive needs it.
  getDb().prepare("DELETE FROM emails WHERE id = ?").run(emailId);
}

export async function trashMessage(emailId: string): Promise<void> {
  await moveOnImap(emailId, "trash");
  getDb().prepare("DELETE FROM emails WHERE id = ?").run(emailId);
}

/**
 * Inverse of archiveMessage: move a previously archived message back to
 * INBOX. Reads the (destFolder, destUid) we captured at archive time from
 * the imap_archive_track table.
 *
 * Provider-specific notes:
 * - Gmail-via-IMAP: archive moves to "[Gmail]/All Mail" via a label flip
 *   under the hood; messageMove back to INBOX adds the INBOX label. Works
 *   like any other IMAP server because we use the standard MOVE verb.
 * - Servers without UIDPLUS: the dest UID is unknown so we fall back to
 *   selecting the dest folder and searching by Message-ID. This is rare
 *   in practice (Gmail, iCloud, Fastmail, Outlook, Yahoo, Dovecot, Cyrus
 *   all advertise UIDPLUS).
 * - Servers that already deleted from the dest folder by the time undo
 *   fires: the move call throws; the error bubbles up so the renderer
 *   can leave its optimistic restore in place.
 */
export async function unarchiveMessage(emailId: string): Promise<void> {
  const parsed = parseImapId(emailId);
  if (!parsed) throw new Error(`unarchive: ${emailId} is not an IMAP id`);
  const { accountId } = parsed;

  ensureArchiveTrackTable();
  const track = getDb()
    .prepare(
      `SELECT account_id, source_folder, dest_folder, dest_uid
       FROM imap_archive_track WHERE original_id = ?`,
    )
    .get(emailId) as
    | {
        account_id: string;
        source_folder: string;
        dest_folder: string;
        dest_uid: number | null;
      }
    | undefined;

  if (!track) {
    // No tracking row means archive never ran via this code path (e.g. the
    // user archived in another client). Without a dest UID there's no way
    // to address the message; fail loudly so the caller can leave its
    // optimistic restore in place.
    throw new Error(
      `unarchiveMessage: no archive-tracking row for ${emailId}; cannot reverse move`,
    );
  }

  const inbox = track.source_folder || "INBOX";

  if (track.dest_uid == null) {
    // Server without UIDPLUS — we never captured a destination UID. Fall
    // back to searching for the message in the dest folder. This is a
    // best-effort path; if the search returns 0 we throw so the caller
    // knows.
    throw new Error(
      `unarchiveMessage: ${emailId} has no captured destination UID (server lacks UIDPLUS); cannot reverse move`,
    );
  }

  const client = await openImapClient(accountId);
  try {
    const lock = await client.getMailboxLock(track.dest_folder);
    try {
      await client.messageMove(String(track.dest_uid), inbox, { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      /* best-effort */
    });
  }

  // Drop the tracking row — the message is back in INBOX, the next sync
  // re-inserts it under its (new) UID.
  getDb().prepare(`DELETE FROM imap_archive_track WHERE original_id = ?`).run(emailId);

  log.info("unarchived message", {
    emailId,
    destFolder: track.dest_folder,
    destUid: track.dest_uid,
    inbox,
  });
}
