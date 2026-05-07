// Direct-DB fixtures for sidecar tests.
//
// The sidecar deliberately doesn't expose a generic `db.exec` RPC, so we
// open a second connection straight at the same SQLite file and INSERT
// rows. SQLite's WAL mode lets reader+writer connections coexist, and
// the sidecar's prepared statements just see whatever we wrote on their
// next query.
//
// Each helper returns the inserted row's id so tests can chain.

// Import better-sqlite3 from the sidecar's workspace explicitly. The repo
// root has its own (stale) prebuilt binary that mismatches the active
// Node ABI; the sidecar workspace's binary is the one rebuilt against the
// runtime Node version, so we use it directly.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Harness } from "./sidecar-process.js";

const __seedDir = dirname(fileURLToPath(import.meta.url));
const __sidecarRequire = createRequire(
  resolve(__seedDir, "..", "..", "..", "sidecar", "package.json"),
);
const Database = __sidecarRequire("better-sqlite3") as typeof import("better-sqlite3");

export interface SeedAccountInput {
  id?: string;
  email: string;
  provider?: "gmail" | "imap";
  displayName?: string;
  isPrimary?: boolean;
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
  smtpHost?: string;
  smtpPort?: number;
}

export function seedAccount(harness: Harness, input: SeedAccountInput): string {
  const id = input.id ?? randomUUID();
  const db = new Database(harness.dbPath);
  try {
    db.prepare(
      `INSERT INTO accounts (
         id, email, display_name, is_primary, added_at, provider,
         imap_host, imap_port, imap_username,
         smtp_host, smtp_port, tls_enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.email,
      input.displayName ?? null,
      input.isPrimary ? 1 : 0,
      Date.now(),
      input.provider ?? "gmail",
      input.imapHost ?? null,
      input.imapPort ?? null,
      input.imapUsername ?? null,
      input.smtpHost ?? null,
      input.smtpPort ?? null,
      1,
    );
  } finally {
    db.close();
  }
  return id;
}

export interface SeedEmailInput {
  id?: string;
  accountId: string;
  threadId?: string;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string | null;
  bcc?: string | null;
  body?: string;
  bodyText?: string | null;
  snippet?: string | null;
  date?: string;
  labelIds?: string[];
  messageId?: string | null;
  inReplyTo?: string | null;
}

export function seedEmail(harness: Harness, input: SeedEmailInput): string {
  const id = input.id ?? `imap:${input.accountId}:INBOX:${Math.floor(Math.random() * 1_000_000)}`;
  const threadId = input.threadId ?? id;
  const labels = input.labelIds ?? ["INBOX"];
  const db = new Database(harness.dbPath);
  try {
    db.prepare(
      `INSERT INTO emails (
         id, account_id, thread_id, subject,
         from_address, to_address, cc_address, bcc_address,
         body, body_text, snippet,
         date, fetched_at, label_ids, attachments,
         message_id, in_reply_to
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.accountId,
      threadId,
      input.subject ?? "(no subject)",
      input.from ?? "sender@example.com",
      input.to ?? "user@example.com",
      input.cc ?? null,
      input.bcc ?? null,
      input.body ?? "",
      input.bodyText ?? null,
      input.snippet ?? null,
      input.date ?? new Date().toISOString(),
      Date.now(),
      JSON.stringify(labels),
      null,
      input.messageId ?? null,
      input.inReplyTo ?? null,
    );
  } finally {
    db.close();
  }
  return id;
}

export interface SeedAnalysisInput {
  emailId: string;
  needsReply: boolean;
  reason: string;
  priority?: "high" | "medium" | "low" | "skip";
  analyzedAt?: number;
}

export function seedAnalysis(harness: Harness, input: SeedAnalysisInput): void {
  const db = new Database(harness.dbPath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO analyses
         (email_id, needs_reply, reason, priority, analyzed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.emailId,
      input.needsReply ? 1 : 0,
      input.reason,
      input.priority ?? null,
      input.analyzedAt ?? Date.now(),
    );
  } finally {
    db.close();
  }
}

export interface SeedDraftInput {
  emailId: string;
  draftBody: string;
  status?: "pending" | "created" | "edited";
  composeMode?: "reply" | "reply-all" | "forward";
  to?: string[];
  cc?: string[];
  bcc?: string[];
}

export function seedDraft(harness: Harness, input: SeedDraftInput): void {
  const db = new Database(harness.dbPath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO drafts
         (email_id, draft_body, status, created_at, compose_mode,
          to_recipients, cc, bcc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.emailId,
      input.draftBody,
      input.status ?? "pending",
      Date.now(),
      input.composeMode ?? null,
      input.to ? JSON.stringify(input.to) : null,
      input.cc ? JSON.stringify(input.cc) : null,
      input.bcc ? JSON.stringify(input.bcc) : null,
    );
  } finally {
    db.close();
  }
}

export interface SeedThreadSummaryInput {
  threadId: string;
  accountId: string;
  latestMessageId: string;
  summaryText: string;
  actionItems?: string[];
  decisions?: string[];
  createdAt?: number;
}

export function seedThreadSummary(harness: Harness, input: SeedThreadSummaryInput): void {
  const db = new Database(harness.dbPath);
  try {
    // The sidecar lazily creates this table the first time summary.thread
    // runs ensureSchema(); we replicate the DDL here so seeding before any
    // call still works.
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_summaries (
        thread_id          TEXT NOT NULL,
        account_id         TEXT NOT NULL,
        latest_message_id  TEXT NOT NULL,
        summary_text       TEXT NOT NULL,
        action_items       TEXT NOT NULL DEFAULT '[]',
        decisions          TEXT NOT NULL DEFAULT '[]',
        created_at         INTEGER NOT NULL,
        PRIMARY KEY (thread_id, account_id)
      );
    `);
    db.prepare(
      `INSERT OR REPLACE INTO thread_summaries
         (thread_id, account_id, latest_message_id, summary_text,
          action_items, decisions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.threadId,
      input.accountId,
      input.latestMessageId,
      input.summaryText,
      JSON.stringify(input.actionItems ?? []),
      JSON.stringify(input.decisions ?? []),
      input.createdAt ?? Date.now(),
    );
  } finally {
    db.close();
  }
}
