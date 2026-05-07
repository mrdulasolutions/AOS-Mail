// `drafts` IPC namespace — V1 covers save / refine / rerunAgent.
// rerunAllAgents (batch regenerate) lifts later.
//
// All persist to the drafts table on success, return the body string the
// renderer's TipTap editor reads. The renderer's existing keyboard
// shortcut for "regenerate draft" hits rerunAgent.

import { registerMethod } from "../rpc.js";
import { generateDraft, refineDraft } from "../services/draft-generator.js";
import { getDb } from "../db/index.js";

interface EmailRow {
  id: string;
  account_id: string;
  from_address: string;
  to_address: string;
  subject: string;
  date: string;
  body: string;
}

function getEmailRow(emailId: string): EmailRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, account_id, from_address, to_address, subject, date, body
         FROM emails WHERE id = ?`,
      )
      .get(emailId) as EmailRow | undefined) ?? null
  );
}

function persistDraft(
  emailId: string,
  body: string,
  status: "pending" | "edited" | "created",
  composeMode?: string,
  to?: string[],
  cc?: string[],
  bcc?: string[],
): void {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare("SELECT email_id FROM drafts WHERE email_id = ?")
    .get(emailId) as { email_id: string } | undefined;
  const ccStr = cc ? JSON.stringify(cc) : null;
  const bccStr = bcc ? JSON.stringify(bcc) : null;
  const toStr = to ? JSON.stringify(to) : null;
  if (existing) {
    db.prepare(
      `UPDATE drafts
         SET draft_body = ?, status = ?, compose_mode = COALESCE(?, compose_mode),
             cc = COALESCE(?, cc), bcc = COALESCE(?, bcc),
             to_recipients = COALESCE(?, to_recipients)
       WHERE email_id = ?`,
    ).run(body, status, composeMode ?? null, ccStr, bccStr, toStr, emailId);
    return;
  }
  db.prepare(
    `INSERT INTO drafts (
        email_id, draft_body, gmail_draft_id, status, created_at,
        agent_task_id, cc, bcc, compose_mode, to_recipients
      ) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(emailId, body, status, now, ccStr, bccStr, composeMode ?? null, toStr);
}

function deleteDraftRow(emailId: string): void {
  getDb().prepare("DELETE FROM drafts WHERE email_id = ?").run(emailId);
}

export function registerDraftsMethods(): void {
  registerMethod("drafts.save", (params) => {
    const { emailId, body, composeMode, to, cc, bcc } =
      (params as {
        emailId?: string;
        body?: string;
        composeMode?: string;
        to?: string[];
        cc?: string[];
        bcc?: string[];
      }) ?? {};
    if (!emailId) throw new Error("drafts.save: requires { emailId }");
    if (body === undefined) {
      throw new Error("drafts.save: requires { body } (use empty string to clear)");
    }
    if (body) {
      persistDraft(emailId, body, "edited", composeMode, to, cc, bcc);
    } else {
      deleteDraftRow(emailId);
    }
    return { ok: true };
  });

  registerMethod("drafts.refine", async (params) => {
    const { emailId, currentDraft, critique } =
      (params as { emailId?: string; currentDraft?: string; critique?: string }) ?? {};
    if (!emailId || currentDraft === undefined || !critique) {
      throw new Error("drafts.refine: requires { emailId, currentDraft, critique }");
    }
    const row = getEmailRow(emailId);
    if (!row) throw new Error(`email ${emailId} not found`);
    const refined = await refineDraft({
      emailId,
      accountId: row.account_id,
      email: {
        from: row.from_address,
        to: row.to_address,
        subject: row.subject,
        date: row.date,
        body: row.body || row.subject,
      },
      currentDraft,
      critique,
    });
    persistDraft(emailId, refined, "edited");
    return { body: refined };
  });

  registerMethod("drafts.rerunAgent", async (params) => {
    const { emailId } = (params as { emailId?: string }) ?? {};
    if (!emailId) throw new Error("drafts.rerunAgent: requires { emailId }");
    const row = getEmailRow(emailId);
    if (!row) throw new Error(`email ${emailId} not found`);
    const draft = await generateDraft({
      emailId,
      accountId: row.account_id,
      email: {
        from: row.from_address,
        to: row.to_address,
        subject: row.subject,
        date: row.date,
        body: row.body || row.subject,
      },
    });
    persistDraft(emailId, draft, "pending");
    return { body: draft };
  });

  // Batch regenerate — V1 returns success but does nothing. Real impl
  // arrives with the agent / pipeline ports.
  registerMethod("drafts.rerunAllAgents", () => ({ ok: true, ran: 0 }));
}
