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

export interface LoadMoreResultLite {
  accountId: string;
  fetched: number;
  newRows: number;
  newEmails: DashboardEmailRow[];
  hasMore: boolean;
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

// ── usage / agent activity ──────────────────────────────────────────────
//
// llm_calls row as returned by the sidecar. Mirrors the SQLite row shape
// (snake_case columns, integer success flag) so the renderer can render
// without a mapping pass. New columns added to the table should be added
// here too.

export interface UsageStatsAggregate {
  totalCostCents: number;
  totalCalls: number;
}

export interface UsageStatsBreakdown {
  today: UsageStatsAggregate;
  thisWeek: UsageStatsAggregate;
  thisMonth: UsageStatsAggregate;
  byModel: Array<{ model: string; costCents: number; calls: number }>;
  byCaller: Array<{ caller: string; costCents: number; calls: number }>;
}

export interface UsageWindowStats {
  totalCostCents: number;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  topCaller: string | null;
  topCallerCalls: number;
}

export interface LlmCallRow {
  id: string;
  created_at: string;
  model: string;
  caller: string;
  email_id: string | null;
  account_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cost_cents: number;
  duration_ms: number;
  success: number;
  error_message: string | null;
}

export interface LlmCallRowWithSubject extends LlmCallRow {
  email_subject: string | null;
}

// ── calendar ────────────────────────────────────────────────────────────
//
// Calendar V1 surfaces Google Calendar metadata + events to the renderer.
// Visibility is a renderer-wide preference (per accountId+calendarId);
// events come from a 60s in-memory cache keyed by (accountId, calendarId,
// timeMin, timeMax).

export interface CalendarRow {
  accountId: string;
  calendarId: string;
  calendarName: string;
  calendarColor: string;
  primary: boolean;
  visible: boolean;
}

export interface CalendarEventAttendee {
  email: string;
  displayName: string | null;
  responseStatus: string;
  self: boolean;
  organizer: boolean;
}

export interface CalendarEventRow {
  id: string;
  accountId: string;
  calendarId: string;
  calendarName: string;
  calendarColor: string;
  summary: string;
  description: string | null;
  location: string | null;
  /** ISO timestamp for timed events; YYYY-MM-DD for all-day. */
  start: string;
  end: string;
  isAllDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  htmlLink: string | null;
  hangoutLink: string | null;
  attendees: CalendarEventAttendee[] | null;
  selfResponseStatus: "needsAction" | "declined" | "tentative" | "accepted" | null;
  isOrganizer: boolean;
}

export type CalendarRsvpResponse = "accepted" | "declined" | "tentative";

// ── sender / extensions ─────────────────────────────────────────────────
//
// SenderProfileLegacy mirrors the historic `sender_profiles` SQLite row
// shape. SenderProfile is the new shape returned by the extensions
// framework — includes role/sources/isAutomated.

export interface SenderProfileLegacy {
  email: string;
  name: string | null;
  summary: string;
  linkedinUrl: string | null;
  company: string | null;
  title: string | null;
  lookupAt: number;
}

export interface SenderProfile {
  email: string;
  name: string | null;
  role: string | null;
  company: string | null;
  summary: string;
  linkedinUrl: string | null;
  sources: Array<{ title: string; url: string }>;
  cachedAt: number;
  isAutomated: boolean;
}

// ── awaiting reply ──────────────────────────────────────────────────────
//
// Nudge V1 surfaces threads where the user's last message is older than
// thresholdDays. The renderer maps these directly into a "Awaiting Reply"
// inbox view; clicking the per-row Draft a Nudge button calls draftNudge
// to compose a short follow-up via the regular draft-generator.

export interface AwaitingReplyThreadRow {
  threadId: string;
  accountId: string;
  /** ISO timestamp of the most recent SENT message in the thread. */
  lastSentAt: string;
  subject: string;
  /** Bare email addresses extracted from the To header. */
  recipientEmails: string[];
  daysSince: number;
}

export interface ExtensionManifestSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  panels: Array<{
    id: string;
    scope: "sender" | "email";
    title: string;
  }>;
}

// ── learned rules ────────────────────────────────────────────────────────
//
// One promoted rule that the analyzer pipeline now treats as
// auto-decision. Built from N user overrides at the same scope; surfaced
// in Settings → Agent Tools → Learned Rules.

export type LearnedRuleAction = "archived" | "trashed" | "replied" | "snoozed";

export interface LearnedRuleRow {
  id: string;
  accountId: string;
  scope: "person" | "domain" | "category" | "global";
  scopeValue: string | null;
  action: LearnedRuleAction;
  count: number;
  enabled: boolean;
  description: string;
  createdAt: number;
  updatedAt: number;
}

// ── The contract ────────────────────────────────────────────────────────

/**
 * Map of `<method-name>` → `{ params, result }`. Add an entry whenever a
 * new RPC method ships in sidecar/src/methods/*.ts.
 */
export interface SidecarMethods {
  // ── ping / diagnostics ────────────────────────────────────────────────
  ping: { params: void; result: SidecarPing };
  "diagnostics.reportError": {
    params: {
      message?: string;
      stack?: string;
      componentStack?: string;
      source?: string;
    };
    result: { ok: true };
  };
  "diagnostics.recentErrors": {
    params: { limit?: number } | void;
    result: Array<{
      id: number;
      createdAt: string;
      source: string;
      message: string;
      stack: string;
      componentStack: string;
    }>;
  };

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
    result: Partial<
      Record<
        | "analysisPrompt"
        | "draftPrompt"
        | "archiveReadyPrompt"
        | "stylePrompt"
        | "agentDrafterPrompt"
        | "calendaringPrompt",
        string
      >
    >;
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

  // ── openrouter ────────────────────────────────────────────────────────
  // Lets users configure a separate OpenRouter API key, which unlocks the
  // free-tier model catalogue exposed by listFreeModels. The renderer
  // never calls chat-completions directly through these methods — calls go
  // through the LLM router in services/anthropic.ts (createMessage).
  "openrouter.setApiKey": { params: { apiKey: string }; result: { ok: true } };
  "openrouter.clearApiKey": { params: void; result: { ok: true } };
  "openrouter.hasApiKey": {
    params: void;
    result: { configured: boolean; source: "env" | "prefs" | null };
  };
  "openrouter.validateApiKey": {
    params: { apiKey: string };
    result: { ok: true };
  };
  "openrouter.listFreeModels": {
    params: void;
    result: Array<{ id: string; name: string; contextLength: number }>;
  };

  // ── sync ──────────────────────────────────────────────────────────────
  "sync.init": { params: void; result: SidecarAccountInfo[] };
  "sync.now": { params: { accountId: string }; result: SyncResultLite };
  "sync.loadMore": { params: { accountId: string }; result: LoadMoreResultLite };
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
  "sync.getEmails": {
    params: { accountId: string; folder?: string; label?: string; limit?: number };
    result: DashboardEmailRow[];
  };
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
  "emails.unarchive": {
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
  // Server-side mailbox search. For Gmail, this hits
  // users.messages.list with `q:` (Gmail's search query syntax —
  // `from:foo subject:bar`). For IMAP, this issues a `client.search()`
  // with subject/from/body substring matches because IMAP doesn't
  // understand Gmail's query syntax. Returned `messages` are
  // full DashboardEmailRow objects (envelope-only — body is null) so
  // the renderer can render result rows without a follow-up fetch.
  "emails.searchRemote": {
    params: {
      accountId: string;
      query: string;
      maxResults?: number;
      pageToken?: string;
    };
    result: {
      messages: DashboardEmailRow[];
      nextPageToken?: string;
      totalEstimate?: number;
    };
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
  "gmail.listLabels": {
    params: { accountId: string };
    result: {
      labels: Array<{
        id: string;
        name: string;
        type: "system" | "user";
        color: string | null;
      }>;
    };
  };

  // ── imap (provider) ───────────────────────────────────────────────────
  // Folder list for the rail. Gmail-via-IMAP returns the same shape; the
  // rail component branches on account.provider, not on the result.
  "imap.listFolders": {
    params: { accountId: string };
    result: {
      folders: Array<{
        name: string;
        path: string;
        specialUse: string | null;
        isSystem: boolean;
      }>;
    };
  };

  // ── thread summary ────────────────────────────────────────────────────
  "summary.thread": {
    params: { threadId: string; accountId: string; force?: boolean };
    result: {
      summary: string;
      actionItems: string[];
      decisions: string[];
      cached: boolean;
      createdAt?: number;
    };
  };

  // ── sender (web-search-backed profile lookup) ─────────────────────────
  // Used by the sender-profile bundled extension. The renderer's
  // useExtensionPanels hook calls extensions.getEnrichment which dispatches
  // to sender.lookup; sender.getCached is for cheap pre-render hits.
  "sender.getProfile": {
    params: { email: string };
    result: SenderProfileLegacy | null;
  };
  "sender.getCached": {
    params: { email: string };
    result: SenderProfile | null;
  };
  "sender.lookup": {
    params: { email: string; name?: string; accountId?: string };
    result: SenderProfile;
  };

  // ── extensions (V1 bundled framework) ─────────────────────────────────
  "extensions.list": {
    params: void;
    result: ExtensionManifestSummary[];
  };
  "extensions.getEnrichment": {
    params: {
      extensionId: string;
      accountId?: string;
      email: string;
      name?: string;
    };
    result: Record<string, unknown> | null;
  };

  // ── usage / agent activity ────────────────────────────────────────────
  // 30-day breakdown by caller + model (existing). Today / week / month
  // aggregates are nested. The renderer's UsageCostSection already binds
  // to this shape; the Agent Activity UI reuses it.
  "usage.getStats": { params: void; result: UsageStatsBreakdown };
  // Bare history — kept for the existing UsageCostSection. New code
  // should prefer getHistoryWithSubjects so the email subject is included.
  "usage.getHistory": {
    params: { limit?: number } | void;
    result: LlmCallRow[];
  };
  // History enriched with the joined email subject. Powers the tray and
  // the Agent Activity sub-tab. The renderer applies search / filter
  // client-side over this single fetch.
  "usage.getHistoryWithSubjects": {
    params: { limit?: number } | void;
    result: LlmCallRowWithSubject[];
  };
  // Single-window aggregates with success/failure split + top caller.
  // Used by the tray badge (today) and the Agent Activity stats card
  // (today + month). Avoids loading full history just to count.
  "usage.getStatsToday": { params: void; result: UsageWindowStats };
  "usage.getStatsThisMonth": { params: void; result: UsageWindowStats };

  // ── calendar ──────────────────────────────────────────────────────────
  // Returns a flat array — one row per calendar — with `accountId`
  // attached so the renderer can group by account. The wrapping
  // `{success, calendars, accountEmails}` shape matches what the existing
  // SettingsPanel calendar tab already reads.
  "calendar.list": {
    params: { accountId?: string } | void;
    result: {
      success: true;
      calendars: CalendarRow[];
      accountEmails: Record<string, string>;
    };
  };
  "calendar.setVisibility": {
    params: { accountId: string; calendarId: string; visible: boolean };
    result: { success: true; data: null };
  };
  // When `calendarId` is omitted, returns merged events from every
  // visible calendar for the given account (or every account if
  // `accountId` is also omitted). Sorted by start time.
  "calendar.getEvents": {
    params: { accountId?: string; calendarId?: string } | void;
    result: CalendarEventRow[];
  };
  "calendar.respondToEvent": {
    params: {
      accountId: string;
      calendarId: string;
      eventId: string;
      response: CalendarRsvpResponse;
    };
    result: { ok: true };
  };

  // ── learned rules ─────────────────────────────────────────────────────
  // The analyzer pipeline can short-circuit Claude when a rule applies
  // (e.g. user has archived 5 newsletters from acme.com → next one
  // auto-archives). Rules are user-toggleable and resettable.
  "learnedRules.list": {
    params: { accountId?: string } | void;
    result: { rules: LearnedRuleRow[] };
  };
  "learnedRules.toggle": {
    params: { ruleId: string; enabled: boolean };
    result: { rule: LearnedRuleRow };
  };
  "learnedRules.reset": {
    params: { accountId?: string } | void;
    result: { deletedRules: number; deletedObservations: number };
  };

  // ── awaiting reply ────────────────────────────────────────────────────
  // List threads where the user sent the latest message and has been
  // waiting on a reply for at least `thresholdDays` (default 3). The
  // renderer treats this as a smart inbox view; drafting a nudge composes
  // a short follow-up via the regular draft pipeline.
  "awaitingReply.list": {
    params: { accountId: string; thresholdDays?: number };
    result: AwaitingReplyThreadRow[];
  };
  "awaitingReply.draftNudge": {
    params: { threadId: string; accountId: string };
    result: { body: string };
  };
}

// Helpers — the renderer's bridge.call uses these to project the keyed
// type; the sidecar's registerMethod uses them to constrain handlers.

export type SidecarMethodName = keyof SidecarMethods;
export type SidecarMethodParams<K extends SidecarMethodName> = SidecarMethods[K]["params"];
export type SidecarMethodResult<K extends SidecarMethodName> = SidecarMethods[K]["result"];
