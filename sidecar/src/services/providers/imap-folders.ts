// IMAP folder discovery — list mailboxes for the left rail.
//
// imapflow's `client.list()` returns `{ name, path, delimiter, specialUse,
// flags, ... }`. Standard "special-use" mailboxes carry an attribute like
// `\Inbox`, `\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`, `\All`.
// User-created folders have no specialUse.
//
// We skip mailboxes flagged `\Noselect` — those are container-only nodes
// that don't hold messages (e.g. the "[Gmail]" parent on Gmail-via-IMAP).
// Selecting them throws a server error, so they have no place in the rail.
//
// `isSystem` flips on for any mailbox that has a specialUse attribute or
// whose path matches the well-known names "INBOX" / "Sent" / etc. The UI
// uses this to render a fixed icon and to keep these at the top of the
// list above user folders.

import { openImapClient } from "./imap.js";

export interface ImapFolderEntry {
  name: string;
  path: string;
  specialUse: string | null;
  isSystem: boolean;
}

const SYSTEM_PATH_NAMES = new Set([
  "INBOX",
  "Sent",
  "Sent Items",
  "Sent Messages",
  "Drafts",
  "Trash",
  "Deleted",
  "Deleted Items",
  "Junk",
  "Spam",
  "Archive",
  "All Mail",
]);

function hasNoSelectFlag(flags: Set<string> | string[] | undefined): boolean {
  if (!flags) return false;
  // imapflow exposes a Set of attributes like "\Noselect", "\HasNoChildren".
  // Different versions hand back a Set or an Array; normalise here.
  const iter = flags instanceof Set ? flags : new Set(flags);
  return iter.has("\\Noselect") || iter.has("\\NoSelect");
}

export async function listImapFolders(accountId: string): Promise<ImapFolderEntry[]> {
  const client = await openImapClient(accountId);
  try {
    const list = await client.list();
    const out: ImapFolderEntry[] = [];
    for (const box of list) {
      if (hasNoSelectFlag(box.flags as Set<string> | string[] | undefined)) continue;
      const specialUse = (box.specialUse ?? null) as string | null;
      const isSystem = !!specialUse || SYSTEM_PATH_NAMES.has(box.path);
      out.push({
        name: box.name,
        path: box.path,
        specialUse,
        isSystem,
      });
    }
    return out;
  } finally {
    await client.logout();
  }
}
