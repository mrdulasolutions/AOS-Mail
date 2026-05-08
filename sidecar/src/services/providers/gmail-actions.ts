// Gmail-API verb implementations — parallel of imap-actions.ts.
//
// Each function takes the canonical email id (`gmail:<accountId>:<gmailId>`)
// and dispatches to messages.modify / messages.trash on Google's side. The
// renderer's `emails.archive` etc. land here when the dispatcher in
// methods/emails.ts sees the `gmail:` prefix.
//
// After the API call succeeds, we ALSO mutate the local emails.label_ids
// to reflect the change — without this the renderer's filter-by-INBOX
// reloads the row across account switches (or any sync.getEmails call)
// until the History API catches up. The IMAP path mirrors the same
// pattern (writeLabels / DELETE FROM emails).
//
// The "optimistic" framing is misleading here: we wait for the Gmail API
// to confirm the mutation before touching local state. So the local
// update is server-confirmed, not optimistic.

import { google } from "googleapis";
import { authedClientForAccount } from "../oauth-gmail.js";
import { parseGmailEmailId } from "./gmail-fetch.js";
import { getDb } from "../../db/index.js";

function gmailClient(accountId: string) {
  return google.gmail({
    version: "v1",
    auth: authedClientForAccount(accountId),
  });
}

function unpack(emailId: string): { accountId: string; gmailId: string } {
  const parsed = parseGmailEmailId(emailId);
  if (!parsed) {
    throw new Error(`Not a Gmail email id: ${emailId}`);
  }
  return parsed;
}

interface EmailLabelRow {
  label_ids: string | null;
}

/**
 * Read+rewrite the local emails.label_ids JSON for the given email,
 * applying the same add/remove ops we just sent to Gmail. Best-effort:
 * a missing local row is a no-op (the email might not be in our window
 * yet — the next History API pass will sync it correctly).
 *
 * Exported only for direct unit tests of the merge logic — production
 * callers should use the action helpers (archive/trash/setRead/etc.)
 * which call this internally after the API succeeds.
 */
export function mutateLocalLabels(
  emailId: string,
  ops: { add?: string[]; remove?: string[] },
): void {
  const row = getDb().prepare("SELECT label_ids FROM emails WHERE id = ?").get(emailId) as
    | EmailLabelRow
    | undefined;
  if (!row) return;
  let labels: string[] = [];
  if (row.label_ids) {
    try {
      const parsed: unknown = JSON.parse(row.label_ids);
      if (Array.isArray(parsed)) {
        labels = parsed.filter((l): l is string => typeof l === "string");
      }
    } catch {
      // Malformed JSON — treat as empty, the rewrite below will fix it.
    }
  }
  if (ops.remove) {
    const removeSet = new Set(ops.remove);
    labels = labels.filter((l) => !removeSet.has(l));
  }
  if (ops.add) {
    for (const l of ops.add) {
      if (!labels.includes(l)) labels.push(l);
    }
  }
  getDb()
    .prepare("UPDATE emails SET label_ids = ? WHERE id = ?")
    .run(JSON.stringify(labels), emailId);
}

export async function archiveMessageGmail(emailId: string): Promise<void> {
  const { accountId, gmailId } = unpack(emailId);
  await gmailClient(accountId).users.messages.modify({
    userId: "me",
    id: gmailId,
    requestBody: { removeLabelIds: ["INBOX"] },
  });
  mutateLocalLabels(emailId, { remove: ["INBOX"] });
}

// Mirror of archiveMessageGmail. Re-adds INBOX so the message reappears in
// the user's inbox after a smart-action archive is undone within the 5s
// window. Identical request shape, opposite label op.
export async function unarchiveMessageGmail(emailId: string): Promise<void> {
  const { accountId, gmailId } = unpack(emailId);
  await gmailClient(accountId).users.messages.modify({
    userId: "me",
    id: gmailId,
    requestBody: { addLabelIds: ["INBOX"] },
  });
  mutateLocalLabels(emailId, { add: ["INBOX"] });
}

export async function trashMessageGmail(emailId: string): Promise<void> {
  const { accountId, gmailId } = unpack(emailId);
  // messages.trash (not modify+TRASH) is what triggers Gmail's 30-day
  // auto-purge. Adding the TRASH label via modify only flags it.
  await gmailClient(accountId).users.messages.trash({
    userId: "me",
    id: gmailId,
  });
  // Trash drops INBOX and adds TRASH on Gmail's side; mirror that locally
  // so the renderer's INBOX filter stops returning this row immediately.
  mutateLocalLabels(emailId, { remove: ["INBOX"], add: ["TRASH"] });
}

export async function setReadGmail(emailId: string, read: boolean): Promise<void> {
  const { accountId, gmailId } = unpack(emailId);
  await gmailClient(accountId).users.messages.modify({
    userId: "me",
    id: gmailId,
    requestBody: read ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] },
  });
  mutateLocalLabels(emailId, read ? { remove: ["UNREAD"] } : { add: ["UNREAD"] });
}

export async function setStarredGmail(emailId: string, starred: boolean): Promise<void> {
  const { accountId, gmailId } = unpack(emailId);
  await gmailClient(accountId).users.messages.modify({
    userId: "me",
    id: gmailId,
    requestBody: starred ? { addLabelIds: ["STARRED"] } : { removeLabelIds: ["STARRED"] },
  });
  mutateLocalLabels(emailId, starred ? { add: ["STARRED"] } : { remove: ["STARRED"] });
}
