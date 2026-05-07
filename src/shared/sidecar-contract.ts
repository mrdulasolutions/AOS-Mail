// Single source of truth for the sidecar's RPC surface.
//
// Every entry here pins one method to its `{ params, result }` contract.
// The renderer's bridge.call<K> uses it to type the return value at the
// callsite; the sidecar's registerMethod<K> uses it to constrain the
// handler signature. A method that exists in this map is enforced on
// both ends; anything that's missing falls back to the loose `unknown`
// default and triggers no compile error.
//
// Strategy: this file should grow alongside sidecar/src/methods/*.ts —
// every new RPC method should add an entry. We did NOT pre-populate
// every method during the migration because most are still in flux;
// instead we populate the ones whose shape has been the source of
// production bugs in this rebuild (sync, settings, emails, compose,
// gmail, anthropic, accounts, theme).
//
// Anything not listed here is allowed via the `[K: string]: ...` index
// fallback so call sites that haven't been ported yet keep working.

// ── Imported types ──────────────────────────────────────────────────────
//
// We import shared types from src/shared/types.ts (no runtime — pure
// type-only re-export from the sidecar's perspective). The Email shape,
// LocalDraft, EAConfig, etc. all already have canonical definitions.

import type { LocalDraft, EAConfig } from "./types";

// Sidecar shapes that don't have an existing public type. Define them
// here (also type-only) so renderer + sidecar share the exact contract.

export interface SidecarPing {
  ok: true;
  pid: number;
  node: string;
  ts: string;
}

export interface DashboardEmailRow {
  id: string;
  threadId: string;
  accountId: string;
  subject: string;
  from: string;
  to: string;
  cc: string | null;
  bcc: string | null;
  date: string;
  snippet: string | null;
  body: string | null;
  labelIds: string | null;
  isUnread: boolean;
  messageId: string | null;
  inReplyTo: string | null;
  analysis?: {
    needsReply: boolean;
    reason: string;
    priority?: "high" | "medium" | "low" | "skip";
    analyzedAt: number;
  };
  draft?: {
    body: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    gmailDraftId?: string;
    status: "pending" | "created" | "edited";
    createdAt: number;
    composeMode?: "reply" | "reply-all" | "forward";
    agentTaskId?: string;
  };
}

export interface SyncResultLite {
  accountId: string;
  fetched: number;
  newRows: number;
  newEmails: DashboardEmailRow[];
  errors: string[];
}

export interface SidecarAccountInfo {
  accountId: string;
  email: string;
  isConnected: boolean;
  provider: string;
}

export interface ComposeSendInput {
  accountId: string;
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  recipientNames?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    path?: string;
    content?: string;
    mimeType: string;
  }>;
}

export interface ComposeSendResult {
  id: string;
  threadId: string;
  messageId: string;
  accepted: string[];
  rejected: string[];
}

// ── The contract ────────────────────────────────────────────────────────

/**
 * Map of `<method-name>` → `{ params, result }`. Add an entry whenever a
 * new RPC method ships in sidecar/src/methods/*.ts.
 */
export interface SidecarMethods {
  // ── ping / diagnostics ────────────────────────────────────────────────
  "ping": { params: void; result: SidecarPing };

  // ── settings ──────────────────────────────────────────────────────────
  "settings.get": { params: void; result: Record<string, unknown> };
  "settings.set": { params: Record<string, unknown>; result: { ok: true } };
  "settings.validateApiKey": {
    params: { apiKey: string };
    result: { ok: true };
  };
  "settings.getEA": { params: void; result: EAConfig };
  "settings.setEA": {
    params: Partial<EAConfig>;
    result: { ok: true; ea: EAConfig };
  };
  "settings.getPrompts": {
    params: void;
    result: Partial<Record<
      | "analysisPrompt"
      | "draftPrompt"
      | "archiveReadyPrompt"
      | "stylePrompt"
      | "agentDrafterPrompt"
      | "calendaringPrompt",
      string
    >>;
  };
  "settings.setPrompts": { params: Record<string, string>; result: { ok: true } };

  // ── theme ─────────────────────────────────────────────────────────────
  "theme.get": { params: void; result: { preference: "light" | "dark" | "system" } };
  "theme.set": {
    params: { theme: "light" | "dark" | "system" };
    result: { preference: "light" | "dark" | "system" };
  };

  // ── anthropic ─────────────────────────────────────────────────────────
  "anthropic.ping": { params: void; result: { ok: true; reply: string } };
  "anthropic.setApiKey": { params: { apiKey: string }; result: { ok: true } };
  "anthropic.clearApiKey": { params: void; result: { ok: true } };
  "anthropic.hasApiKey": {
    params: void;
    result: { configured: boolean; source: "env" | "prefs" | null };
  };

  // ── sync ──────────────────────────────────────────────────────────────
  "sync.init": { params: void; result: SidecarAccountInfo[] };
  "sync.now": { params: { accountId: string }; result: SyncResultLite };
  "sync.start": {
    params: { accountId: string };
    result: { ok: true; intervalMs: number };
  };
  "sync.stop": { params: { accountId: string }; result: { ok: true } };
  "sync.setInterval": {
    params: { intervalMs: number };
    result: { ok: true; intervalMs: number };
  };
  "sync.status": {
    params: { accountId: string };
    result: { accountId: string; status: "idle" | "syncing" | "error" };
  };
  "sync.getEmails": { params: { accountId: string }; result: DashboardEmailRow[] };
  "sync.getSentEmails": {
    params: { accountId: string };
    result: DashboardEmailRow[];
  };
  "sync.prefetchBodies": {
    params: { ids: string[] };
    result: Array<{ id: string; body: string }>;
  };
  "sync.fetchBody": {
    params: { emailId: string };
    result: DashboardEmailRow | null;
  };

  // ── emails (verbs) ────────────────────────────────────────────────────
  "emails.archive": {
    params: { emailId: string; accountId?: string };
    result: { ok: true };
  };
  "emails.batchArchive": {
    params: { emailIds: string[]; accountId?: string };
    result: { ok: true; archived: number; errors: string[] };
  };
  "emails.archiveThread": {
    params: { threadId: string; accountId: string };
    result: { ok: true; archived: number; errors: string[] };
  };
  "emails.trash": {
    params: { emailId: string; accountId?: string };
    result: { ok: true };
  };
  "emails.batchTrash": {
    params: { emailIds: string[]; accountId?: string };
    result: { ok: true; trashed: number; errors: string[] };
  };
  "emails.setStarred": {
    params: { emailId: string; starred: boolean };
    result: { ok: true };
  };
  "emails.setRead": {
    params: { emailId: string; read: boolean };
    result: { ok: true };
  };
  "emails.getThread": {
    params: { threadId: string; accountId: string };
    result: DashboardEmailRow[];
  };

  // ── compose ───────────────────────────────────────────────────────────
  "compose.send": { params: ComposeSendInput; result: ComposeSendResult };
  "compose.listLocalDrafts": { params: void; result: LocalDraft[] };
  "compose.saveLocalDraft": {
    params: Partial<LocalDraft> & { accountId: string };
    result: LocalDraft;
  };
  "compose.updateLocalDraft": {
    params: Partial<LocalDraft> & { id: string };
    result: LocalDraft | null;
  };
  "compose.deleteLocalDraft": {
    params: { id: string };
    result: { ok: true };
  };
  "compose.getSendAsAliases": {
    params: { accountId: string };
    result: { aliases: unknown[] };
  };

  // ── gmail (provider) ──────────────────────────────────────────────────
  "gmail.saveCredentials": {
    params: { clientId: string; clientSecret: string };
    result: { ok: true };
  };
  "gmail.hasCredentials": { params: void; result: { configured: boolean } };
  "gmail.startOAuth": { params: void; result: { url: string } };
  "gmail.cancelOAuth": { params: void; result: { ok: true } };
  "gmail.checkAuth": {
    params: void;
    result: {
      accounts: Array<{ accountId: string; email: string; valid: boolean }>;
    };
  };
  "gmail.disconnect": { params: { accountId: string }; result: { ok: true } };
  "gmail.createDraft": {
    params: ComposeSendInput & { gmailDraftId?: string };
    result: { draftId: string; messageId: string; threadId: string };
  };
}

// Helpers — the renderer's bridge.call uses these to project the keyed
// type; the sidecar's registerMethod uses them to constrain handlers.

export type SidecarMethodName = keyof SidecarMethods;
export type SidecarMethodParams<K extends SidecarMethodName> =
  SidecarMethods[K]["params"];
export type SidecarMethodResult<K extends SidecarMethodName> =
  SidecarMethods[K]["result"];
