// Gmail label discovery — list user-visible labels for the left rail.
//
// We expose Gmail's labels as the analog of IMAP folders. Filtering rules:
//   - drop `messageListVisibility === "hide"` — the user explicitly hides
//     these in Gmail web, so they shouldn't show up here either.
//   - drop the `CATEGORY_*` system labels (Promotions / Social / Updates /
//     Forums / Personal). These are auto-tabs Gmail's web UI manages and
//     they create a noisy duplicate hierarchy in the rail.
//
// The rest — INBOX / SENT / TRASH / DRAFT / STARRED / IMPORTANT / SPAM as
// system labels, plus any user labels — pass through. Color is taken from
// the label's optional `color.backgroundColor` so the rail can render the
// same swatch the user picked in Gmail.

import { google } from "googleapis";
import { authedClientForAccount } from "../oauth-gmail.js";

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
  color: string | null;
}

/** True iff this label should be hidden from the rail. */
function shouldSkip(label: {
  id?: string | null;
  type?: string | null;
  messageListVisibility?: string | null;
}): boolean {
  if (label.messageListVisibility === "hide") return true;
  if (label.type === "system" && label.id?.startsWith("CATEGORY_")) return true;
  return false;
}

export async function listGmailLabels(accountId: string): Promise<GmailLabel[]> {
  const auth = authedClientForAccount(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const response = await gmail.users.labels.list({ userId: "me" });
  const labels = response.data.labels ?? [];
  const out: GmailLabel[] = [];
  for (const label of labels) {
    if (!label.id || !label.name) continue;
    if (shouldSkip(label)) continue;
    out.push({
      id: label.id,
      name: label.name,
      type: label.type === "user" ? "user" : "system",
      color: label.color?.backgroundColor ?? null,
    });
  }
  return out;
}
