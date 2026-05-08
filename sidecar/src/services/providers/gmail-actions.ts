// Gmail-API verb implementations — parallel of imap-actions.ts.
//
// Each function takes the canonical email id (`gmail:<accountId>:<gmailId>`)
// and dispatches to messages.modify / messages.trash on Google's side.
// The renderer's `emails.archive` etc. land here when the dispatcher in
// methods/emails.ts sees the `gmail:` prefix.

import { google } from "googleapis";
import { authedClientForAccount } from "../oauth-gmail.js";
import { parseGmailEmailId } from "./gmail-fetch.js";

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

export async function archiveMessageGmail(emailId: string): Promise<void> {
  const { accountId, gmailId } = unpack(emailId);
  await gmailClient(accountId).users.messages.modify({
    userId: "me",
    id: gmailId,
    requestBody: { removeLabelIds: ["INBOX"] },
  });
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
}

export async function trashMessageGmail(emailId: string): Promise<void> {
  const { accountId, gmailId } = unpack(emailId);
  // messages.trash (not modify+TRASH) is what triggers Gmail's 30-day
  // auto-purge. Adding the TRASH label via modify only flags it.
  await gmailClient(accountId).users.messages.trash({
    userId: "me",
    id: gmailId,
  });
}

export async function setReadGmail(emailId: string, read: boolean): Promise<void> {
  const { accountId, gmailId } = unpack(emailId);
  await gmailClient(accountId).users.messages.modify({
    userId: "me",
    id: gmailId,
    requestBody: read ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] },
  });
}

export async function setStarredGmail(emailId: string, starred: boolean): Promise<void> {
  const { accountId, gmailId } = unpack(emailId);
  await gmailClient(accountId).users.messages.modify({
    userId: "me",
    id: gmailId,
    requestBody: starred ? { addLabelIds: ["STARRED"] } : { removeLabelIds: ["STARRED"] },
  });
}
