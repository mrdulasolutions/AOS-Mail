// Typed surface for `window.api.*` — the renderer's idiomatic call site
// for every sidecar RPC.
//
// Why this file exists: prior to this, `window.api` was `any`. Every call
// site cast manually (`(await window.api.X.Y(...)) as IpcResponse<Z>`) and
// shape mismatches were strictly runtime bugs. Replacing `any` with this
// `WindowApi` interface gives compile-time enforcement on:
//   - method existence per namespace
//   - parameter shapes (positional, matching the shim's hand-rolled forwarders)
//   - return shapes — `Promise<IpcResponse<T>>` with `T` derived from
//     `SidecarMethodResult<K>` wherever the method is in the contract.
//
// Two layers of definition:
//
//   1. ContractWindowApi (auto-generated). For every namespace.method
//      pair in `SidecarMethods`, the contract provides params + result;
//      this file's mapped type would translate that into a
//      `(params) => Promise<IpcResponse<result>>` shape — but the shim's
//      hand-rolled forwarders take POSITIONAL args, not the contract's
//      object form. So we don't auto-generate the function shape; we
//      auto-generate the RESULT type and use that in the explicit method
//      signatures below. This keeps args ergonomic at every call site
//      while still binding the result shape to the single source of truth.
//
//   2. LocalWindowApiExtras (hand-written). Methods that are NOT in the
//      contract (event subscriptions like onXyz / removeAllListeners,
//      Tauri-direct surfaces like defaultMailApp / find / updates,
//      methods awaiting contract entries). Hand-typed explicitly.
//
// `WindowApi` itself is the namespace-keyed interface that the shim
// satisfies. Renderer call sites bind through `window.api: WindowApi`.

import type { CalendarRow, SidecarMethodName, SidecarMethodResult } from "./sidecar-contract";
import type {
  AnalysisResult,
  DashboardEmail,
  DraftMemory,
  InboxSplit,
  IpcResponse as SharedIpcResponse,
  LocalDraft,
  Memory,
  MemoryScope,
  OutboxStats,
  ReplyInfo,
  ScheduledMessage,
  ScheduledMessageStats,
  Snippet,
} from "./types";

// IpcResponse is the wrapper shape every shim forwarder returns. Distinct
// from raw bridge.call's return: the shim catches errors, surfaces them
// as `{ success: false, error }`, so callers never see thrown rejections.
//
// Re-exports the canonical shape from `src/shared/types.ts` (which adds
// an optional `cancelled` flag for OAuth flows). Default `T = unknown`
// makes the bare `IpcResponse` usable the way every existing call site
// expects.
export type IpcResponse<T = unknown> = SharedIpcResponse<T>;

// Helper: pull the result type out of the contract for a given key.
// Used in the explicit signatures below to keep return shapes bound to
// `SidecarMethods`. Aliased for readability.
type R<K extends SidecarMethodName> = SidecarMethodResult<K>;

// ─────────────────────────────────────────────────────────────────────────
// Diagnostics — boot-triage helpers; mostly RPC pings.
// ─────────────────────────────────────────────────────────────────────────

export interface DiagnosticsApi {
  ping: () => Promise<IpcResponse<R<"ping">>>;
  shellPing: () => Promise<IpcResponse<string>>;
  dbInfo: () => Promise<IpcResponse<unknown>>;
  dbListAccounts: () => Promise<IpcResponse<unknown>>;
  anthropicPing: () => Promise<IpcResponse<R<"anthropic.ping">>>;
  anthropicHasApiKey: () => Promise<IpcResponse<R<"anthropic.hasApiKey">>>;
  hasAnyLlmProvider: () => Promise<IpcResponse<R<"anthropic.hasAnyLlmProvider">>>;
  anthropicSetApiKey: (apiKey: string) => Promise<IpcResponse<R<"anthropic.setApiKey">>>;
}

// ─────────────────────────────────────────────────────────────────────────
// OpenRouter — alternate LLM provider.
// ─────────────────────────────────────────────────────────────────────────

export interface OpenRouterApi {
  setApiKey: (apiKey: string) => Promise<IpcResponse<R<"openrouter.setApiKey">>>;
  clearApiKey: () => Promise<IpcResponse<R<"openrouter.clearApiKey">>>;
  hasApiKey: () => Promise<IpcResponse<R<"openrouter.hasApiKey">>>;
  validateApiKey: (apiKey: string) => Promise<IpcResponse<R<"openrouter.validateApiKey">>>;
  listFreeModels: () => Promise<IpcResponse<R<"openrouter.listFreeModels">>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Theme — preference persistence + OS color signal merge.
// ─────────────────────────────────────────────────────────────────────────

export type ThemePreference = "light" | "dark" | "system";
export type ThemeChange = { preference: ThemePreference; resolved: "light" | "dark" };

export interface ThemeApi {
  get: () => Promise<IpcResponse<ThemeChange>>;
  set: (theme: ThemePreference) => Promise<IpcResponse<{ resolved: "light" | "dark" }>>;
  onChange: (callback: (data: ThemeChange) => void) => void;
  removeAllListeners: () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Snippets — canned-response store.
// ─────────────────────────────────────────────────────────────────────────

export interface SnippetsApi {
  getAll: () => Promise<IpcResponse<Snippet[]>>;
  save: (snippets: Snippet[]) => Promise<IpcResponse<null>>;
  create: (snippet: Partial<Snippet>) => Promise<IpcResponse<Snippet>>;
  update: (id: string, updates: Partial<Snippet>) => Promise<IpcResponse<Snippet>>;
  delete: (id: string) => Promise<IpcResponse<null>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Accounts — multi-account management.
// ─────────────────────────────────────────────────────────────────────────

export interface AccountRecord {
  id: string;
  email: string;
  displayName?: string;
  isPrimary: boolean;
  addedAt: number;
  /** "gmail" | "imap" — surfaced as a small badge in Settings → Accounts */
  provider?: string;
}

export interface AccountAddedPayload {
  accountId: string;
  email: string;
  displayName?: string | null;
  isConnected: boolean;
  provider?: string;
}

export interface AccountsApi {
  list: () => Promise<IpcResponse<AccountRecord[]>>;
  add: (accountId?: string) => Promise<IpcResponse<AccountAddedPayload>>;
  remove: (accountId: string) => Promise<IpcResponse<null>>;
  setPrimary: (accountId: string) => Promise<IpcResponse<null>>;
  cancelAdd: () => Promise<IpcResponse<null>>;
  onAddProgress: (callback: (data: { phase: string }) => void) => () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Drafts — Claude-powered reply drafting.
// ─────────────────────────────────────────────────────────────────────────

/** Renderer-shape of a generated draft body. The sidecar's drafts.* surface
 *  returns the body string plus a sometimes-attached agentTaskId for
 *  conversation-mirror lookups. */
export interface DraftBody {
  body: string;
  agentTaskId?: string;
}

export interface RerunAllAgentsResult {
  clearedCount?: number;
  total?: number;
  succeeded?: number;
  failed?: number;
  errors?: Array<{ emailId: string; error: string }>;
}

export interface DraftsApi {
  save: (
    emailId: string,
    body: string,
    composeMode?: string,
    to?: string[],
    cc?: string[],
    bcc?: string[],
  ) => Promise<IpcResponse<DraftBody>>;
  refine: (
    emailId: string,
    currentDraft: string,
    critique: string,
  ) => Promise<IpcResponse<DraftBody>>;
  rerunAgent: (emailId: string) => Promise<IpcResponse<DraftBody>>;
  rerunAllAgents: () => Promise<IpcResponse<RerunAllAgentsResult>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Analysis — Claude-powered triage.
// ─────────────────────────────────────────────────────────────────────────

export interface AnalysisApi {
  analyze: (emailId: string) => Promise<IpcResponse<AnalysisResult>>;
  analyzeBatch: (emailIds: string[]) => Promise<
    IpcResponse<{
      results: Array<{ emailId: string; result?: AnalysisResult; error?: string }>;
    }>
  >;
  overridePriority: (
    emailId: string,
    newNeedsReply: boolean,
    newPriority: string | null,
    reason?: string,
  ) => Promise<IpcResponse<unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Archive Ready — Claude-powered thread completion detector.
// ─────────────────────────────────────────────────────────────────────────

export interface ArchiveReadyApi {
  analyze: (threadId: string, accountId: string) => Promise<IpcResponse<unknown>>;
  analyzeBatch: (threadIds: string[], accountId: string) => Promise<IpcResponse<unknown>>;
  list: (accountId?: string, limit?: number) => Promise<IpcResponse<unknown>>;
  override: (
    threadId: string,
    accountId: string,
    isReady: boolean,
    reason?: string,
  ) => Promise<IpcResponse<unknown>>;
  dismiss: (threadId: string, accountId: string) => Promise<IpcResponse<R<"archiveReady.dismiss">>>;
  // Event subscription / cleanup pair (auto-stub fall-through, exposed
  // explicitly so call sites bind without `as any`).
  onResult: <T = unknown>(callback: (data: T) => void) => () => void;
  removeAllListeners: () => void;
  // Auto-stub today — the renderer queries archive-ready threads on
  // account-switch. Sidecar lift will replace this with `archiveReady.list`.
  // TODO: align with archiveReady.list once that returns a row shape we
  // can substitute here.
  getThreads: (
    accountId: string,
  ) => Promise<IpcResponse<Array<{ threadId: string; reason: string }>>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Awaiting Reply — threads where the user spoke last.
// ─────────────────────────────────────────────────────────────────────────

export interface AwaitingReplyApi {
  list: (
    accountId: string,
    opts?: { thresholdDays?: number },
  ) => Promise<IpcResponse<R<"awaitingReply.list">>>;
  draftNudge: (
    threadId: string,
    accountId: string,
  ) => Promise<IpcResponse<R<"awaitingReply.draftNudge">>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Emails — inbox management verbs.
// ─────────────────────────────────────────────────────────────────────────

export interface EmailsSearchRemoteResult {
  emails: DashboardEmail[];
  nextPageToken?: string;
  totalEstimate?: number;
}

export interface EmailsApi {
  archive: (emailId: string, accountId: string) => Promise<IpcResponse<R<"emails.archive">>>;
  unarchive: (emailId: string, accountId: string) => Promise<IpcResponse<R<"emails.unarchive">>>;
  batchArchive: (
    emailIds: string[],
    accountId: string,
  ) => Promise<IpcResponse<R<"emails.batchArchive">>>;
  archiveThread: (
    threadId: string,
    accountId: string,
  ) => Promise<IpcResponse<R<"emails.archiveThread">>>;
  trash: (emailId: string, accountId: string) => Promise<IpcResponse<R<"emails.trash">>>;
  batchTrash: (
    emailIds: string[],
    accountId: string,
  ) => Promise<IpcResponse<R<"emails.batchTrash">>>;
  setStarred: (
    emailId: string,
    accountId: string,
    starred: boolean,
  ) => Promise<IpcResponse<R<"emails.setStarred">>>;
  setRead: (
    emailId: string,
    accountId: string,
    read: boolean,
  ) => Promise<IpcResponse<R<"emails.setRead">>>;
  getThread: (threadId: string, accountId: string) => Promise<IpcResponse<DashboardEmail[]>>;
  searchRemote: (
    query: string,
    accountId: string,
    maxResults?: number,
    pageToken?: string,
  ) => Promise<IpcResponse<EmailsSearchRemoteResult>>;
  // Auto-stub today — the local FTS search alongside the remote one.
  // Sidecar lift will route this to `search.query` with a richer return.
  // TODO: align with sidecar contract once `emails.search` exists.
  search: (
    query: string,
    accountId: string,
    maxResults?: number,
  ) => Promise<IpcResponse<DashboardEmail[]>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Compose — message send + local-draft store.
// ─────────────────────────────────────────────────────────────────────────

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
    size?: number;
  }>;
}

/** Result of a successful compose.send call. `queued: true` means the send
 *  was deferred (undo window). `id`/`threadId` are the Gmail server IDs. */
export interface ComposeSendResult {
  id: string;
  threadId: string;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  queued?: boolean;
}

export interface ComposeApi {
  send: (options: ComposeSendInput) => Promise<IpcResponse<ComposeSendResult>>;
  listLocalDrafts: () => Promise<IpcResponse<LocalDraft[]>>;
  saveLocalDraft: (input: Record<string, unknown>) => Promise<IpcResponse<LocalDraft>>;
  updateLocalDraft: (
    id: string,
    patch: Record<string, unknown>,
  ) => Promise<IpcResponse<LocalDraft | null>>;
  deleteLocalDraft: (id: string) => Promise<IpcResponse<null>>;
  getSendAsAliases: (accountId: string) => Promise<IpcResponse<R<"compose.getSendAsAliases">>>;
  // Auto-stub today — the renderer queries Message-ID / References headers
  // for proper Gmail threading at send time. Sidecar lift will replace
  // this with a real RPC.
  // TODO: add to sidecar contract once compose-server lifts.
  getReplyInfo: (
    emailId: string,
    mode: string,
    accountId: string,
  ) => Promise<IpcResponse<ReplyInfo | null>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Sync — multi-account sync surface.
// ─────────────────────────────────────────────────────────────────────────

export interface SyncStatusEvent {
  accountId: string;
  status: "idle" | "syncing" | "error";
}

export interface SyncApi {
  init: () => Promise<IpcResponse<R<"sync.init">>>;
  now: (accountId: string) => Promise<IpcResponse<R<"sync.now">>>;
  loadMore: (accountId: string) => Promise<IpcResponse<R<"sync.loadMore">>>;
  start: (accountId: string) => Promise<IpcResponse<R<"sync.start">>>;
  stop: (accountId: string) => Promise<IpcResponse<R<"sync.stop">>>;
  setInterval: (intervalMs: number) => Promise<IpcResponse<R<"sync.setInterval">>>;
  status: (accountId: string) => Promise<IpcResponse<R<"sync.status">>>;
  getEmails: (
    accountId: string,
    opts?: { folder?: string; label?: string; limit?: number },
  ) => Promise<IpcResponse<DashboardEmail[]>>;
  getSentEmails: (accountId: string) => Promise<IpcResponse<DashboardEmail[]>>;
  prefetchBodies: (ids: string[]) => Promise<IpcResponse<R<"sync.prefetchBodies">>>;
  onNewEmails: (cb: (data: { accountId: string; emails: DashboardEmail[] }) => void) => void;
  onStatusChange: (cb: (data: SyncStatusEvent) => void) => void;
  removeAllListeners: () => void;
  // Auto-stubbed event subscriptions provided by the shim's proxy
  // fall-through — runtime always has these as noop unsubscribes, so we
  // declare them required so call sites don't need optional-chaining.
  onNewSentEmails: (cb: (data: { accountId: string; emails: DashboardEmail[] }) => void) => void;
  onEmailsRemoved: (cb: (data: { accountId: string; emailIds: string[] }) => void) => void;
  onEmailsUpdated: (
    cb: (data: {
      accountId: string;
      updates: Array<{ emailId: string; labelIds: string[] }>;
    }) => void,
  ) => void;
  onDraftsRemoved: (cb: (data: { accountId: string; emailIds: string[] }) => void) => void;
  onActionFailed: (
    cb: (data: { emailId: string; accountId: string; action: string; error: string }) => void,
  ) => void;
  onActionSucceeded: (
    cb: (data: { emailId: string; accountId: string; action: string }) => void,
  ) => void;
  // Initial / progressive full-sync progress events. Optional today —
  // only fires from the sidecar's progressive-sync worker, but the
  // proxy-based shim covers it via auto-stub fall-through.
  onSyncProgress?: (
    cb: (data: { accountId: string; fetched: number; total: number }) => void,
  ) => void;
}

// ─────────────────────────────────────────────────────────────────────────
// IMAP — full IMAP/SMTP provider surface.
// ─────────────────────────────────────────────────────────────────────────

export interface ImapPreset {
  id: string;
  label: string;
  hint: string;
  domains?: string[];
  imap: { host: string; port: number; tls: true };
  smtp: { host: string; port: number; tls: true };
  appPasswordRequired?: boolean;
  appPasswordHelp?: string;
}

export interface ImapAddInput {
  email: string;
  password: string;
  displayName?: string;
  imapHost: string;
  imapPort: number;
  imapUsername?: string;
  smtpHost: string;
  smtpPort: number;
  tls?: boolean;
}

export interface ImapApi {
  presets: () => Promise<IpcResponse<{ presets: ImapPreset[] }>>;
  suggestForEmail: (email: string) => Promise<IpcResponse<{ preset: ImapPreset | null }>>;
  testConnection: (input: ImapAddInput) => Promise<IpcResponse<{ ok: true }>>;
  addAccount: (input: ImapAddInput) => Promise<IpcResponse<{ accountId: string; email: string }>>;
  listFolders: (accountId: string) => Promise<IpcResponse<R<"imap.listFolders">>>;
  disconnect: (accountId: string) => Promise<IpcResponse<null>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Gmail — auth flow + provider operations.
// ─────────────────────────────────────────────────────────────────────────

export interface GmailAuthSuccess {
  accountId: string;
  email: string;
  displayName: string | null;
}

export interface GmailApi {
  getEmail: (emailId: string) => Promise<IpcResponse<DashboardEmail | null>>;
  // The shim routes this to `sync.getEmails` so the result is the same shape
  // (DashboardEmail[]). Kept under `gmail.*` for the renderer's bootstrap
  // path (App.tsx) which still uses the gmail namespace.
  fetchUnread: (
    maxResults?: number,
    accountId?: string,
    opts?: { folder?: string; label?: string; limit?: number },
  ) => Promise<IpcResponse<DashboardEmail[]>>;
  saveCredentials: (clientId: string, clientSecret: string) => Promise<IpcResponse<null>>;
  hasCredentials: () => Promise<IpcResponse<R<"gmail.hasCredentials">>>;
  checkAuth: () => Promise<IpcResponse<R<"gmail.checkAuth">>>;
  startOAuth: () => Promise<IpcResponse<GmailAuthSuccess>>;
  cancelOAuth: () => Promise<IpcResponse<null>>;
  createDraft: (input: Record<string, unknown>) => Promise<IpcResponse<R<"gmail.createDraft">>>;
  listLabels: (accountId: string) => Promise<IpcResponse<R<"gmail.listLabels">>>;
  disconnect: (accountId: string) => Promise<IpcResponse<R<"gmail.disconnect">>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Search — local FTS5 search.
// ─────────────────────────────────────────────────────────────────────────

// Local search hit row. The renderer's SearchBar binds a slightly richer
// shape (rank, accountId, subject, etc.); the FTS5 query returns these
// fields concretely so we declare them required to match.
export interface SearchResult {
  id: string;
  threadId: string;
  accountId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  rank: number;
}

export interface SearchApi {
  query: (
    query: string,
    options?: { accountId?: string; limit?: number; offset?: number },
  ) => Promise<IpcResponse<SearchResult[]>>;
  suggestions: (query: string, limit?: number) => Promise<IpcResponse<string[]>>;
  rebuildIndex: () => Promise<IpcResponse<null>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Contacts — autocomplete suggestions.
// ─────────────────────────────────────────────────────────────────────────

export interface ContactSuggestion {
  email: string;
  name: string;
  frequency: number;
}

export interface ContactsApi {
  suggest: (query: string, limit?: number) => Promise<IpcResponse<ContactSuggestion[]>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Sender — sender profile lookup (legacy shape).
// ─────────────────────────────────────────────────────────────────────────

export interface SenderProfile {
  email: string;
  name: string | null;
  summary: string;
  linkedinUrl: string | null;
  company: string | null;
  title: string | null;
  lookupAt: number;
}

export interface SenderApi {
  getProfile: (email: string) => Promise<IpcResponse<SenderProfile | null>>;
  lookup: (from: string, email: string) => Promise<IpcResponse<SenderProfile | null>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Snooze — local thread snoozing with auto-unsnooze events.
// ─────────────────────────────────────────────────────────────────────────

export interface SnoozedEmail {
  id: string;
  emailId: string;
  threadId: string;
  accountId: string;
  snoozeUntil: number;
  snoozedAt: number;
}

export interface SnoozeApi {
  snooze: (
    emailId: string,
    threadId: string,
    accountId: string,
    snoozeUntil: number,
  ) => Promise<IpcResponse<SnoozedEmail>>;
  unsnooze: (threadId: string, accountId: string) => Promise<IpcResponse<null>>;
  list: (accountId: string) => Promise<IpcResponse<SnoozedEmail[]> & { expired?: SnoozedEmail[] }>;
  get: (threadId: string, accountId: string) => Promise<IpcResponse<SnoozedEmail | null>>;
  onSnoozed: (cb: (data: { snoozedEmail: SnoozedEmail }) => void) => void;
  onUnsnoozed: (cb: (data: { emails: SnoozedEmail[] }) => void) => void;
  onManuallyUnsnoozed: (
    cb: (data: { threadId: string; accountId: string; snoozeUntil: number }) => void,
  ) => void;
  removeAllListeners: () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Splits — user-defined inbox splits / smart folders.
// ─────────────────────────────────────────────────────────────────────────

export interface SplitsApi {
  getAll: () => Promise<IpcResponse<InboxSplit[]>>;
  save: (splits: InboxSplit[]) => Promise<IpcResponse<null>>;
  create: (split: Partial<InboxSplit>) => Promise<IpcResponse<InboxSplit>>;
  update: (id: string, updates: Partial<InboxSplit>) => Promise<IpcResponse<InboxSplit>>;
  delete: (id: string) => Promise<IpcResponse<null>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Memory — agent persistent memory.
// ─────────────────────────────────────────────────────────────────────────

export interface LearnedPromotion {
  id: string;
  content: string;
  scope: string;
  scopeValue: string | null;
}

export interface DraftEditLearned {
  promoted: LearnedPromotion[];
  draftMemoriesCreated: number;
  draftMemoryIds: string[];
}

export interface AnalysisOverrideLearned {
  promoted: LearnedPromotion[];
  draftMemoriesCreated: number;
}

export interface MemoryApi {
  list: (accountId: string) => Promise<IpcResponse<Memory[]>>;
  getForEmail: (senderEmail: string, accountId: string) => Promise<IpcResponse<Memory[]>>;
  save: (params: {
    accountId: string;
    scope: MemoryScope;
    scopeValue?: string | null;
    content: string;
    source?: string;
    sourceEmailId?: string;
  }) => Promise<IpcResponse<Memory>>;
  update: (
    id: string,
    updates: {
      content?: string;
      enabled?: boolean;
      scope?: MemoryScope;
      scopeValue?: string | null;
    },
  ) => Promise<IpcResponse<Memory | null>>;
  delete: (id: string) => Promise<IpcResponse<null>>;
  categories: (accountId: string) => Promise<IpcResponse<string[]>>;
  classify: (params: {
    content: string;
    senderEmail: string;
    senderDomain: string;
  }) => Promise<IpcResponse<{ scope: MemoryScope; scopeValue: string | null; content: string }>>;
  onDraftEditLearned: (callback: (data: DraftEditLearned) => void) => () => void;
  onAnalysisOverrideLearned: (callback: (data: AnalysisOverrideLearned) => void) => () => void;
  draftMemories: {
    list: (accountId: string) => Promise<IpcResponse<DraftMemory[]>>;
    promote: (id: string, accountId: string) => Promise<IpcResponse<null>>;
    delete: (id: string) => Promise<IpcResponse<null>>;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Auth — token-expired / extension-auth-required event surface.
// ─────────────────────────────────────────────────────────────────────────

export interface AuthTokenExpired {
  accountId: string;
  email: string;
  source?: string;
}

export interface AuthExtensionRequired {
  extensionId: string;
  displayName: string;
  message?: string;
}

export interface AuthApi {
  onTokenExpired: (callback: (data: AuthTokenExpired) => void) => void;
  onExtensionAuthRequired: (callback: (data: AuthExtensionRequired) => void) => void;
  reauth: (accountId: string) => Promise<IpcResponse<null>>;
  cancelReauth: () => Promise<IpcResponse<null>>;
  removeAllListeners: () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Settings — generic preferences + EA / prompts subobjects.
// ─────────────────────────────────────────────────────────────────────────

export interface SettingsApi {
  // The settings blob is freeform; the renderer pins fields it expects via
  // a generic, e.g. `settings.get<{ inboxDensity?: InboxDensity }>()`.
  // Default `Record<string, unknown>` matches the contract.
  get: <T = Record<string, unknown>>() => Promise<IpcResponse<T>>;
  set: (patch: Record<string, unknown>) => Promise<IpcResponse<null>>;
  validateApiKey: (apiKey: string) => Promise<IpcResponse<null>>;
  getEA: <T = R<"settings.getEA">>() => Promise<IpcResponse<T>>;
  setEA: (ea: unknown) => Promise<IpcResponse<null>>;
  getPrompts: <T = R<"settings.getPrompts">>() => Promise<IpcResponse<T>>;
  setPrompts: (prompts: Record<string, unknown>) => Promise<IpcResponse<null>>;
  onPromptsChanged: <T = unknown>(cb: (data: T) => void) => () => void;
  removePromptsChangedListener: () => void;
  exportLogs: () => Promise<IpcResponse<null>>;
  testOpenclawConnection: () => Promise<IpcResponse<null>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Usage — Claude API cost + call history.
// ─────────────────────────────────────────────────────────────────────────

export interface UsageApi {
  getStats: () => Promise<IpcResponse<R<"usage.getStats">>>;
  getCallHistory: (limit?: number) => Promise<IpcResponse<R<"usage.getHistory">>>;
  getCallHistoryWithSubjects: (
    limit?: number,
  ) => Promise<IpcResponse<R<"usage.getHistoryWithSubjects">>>;
  getStatsToday: () => Promise<IpcResponse<R<"usage.getStatsToday">>>;
  getStatsThisMonth: () => Promise<IpcResponse<R<"usage.getStatsThisMonth">>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Find — page text search via window.find().
// ─────────────────────────────────────────────────────────────────────────

export interface FindResult {
  activeMatchOrdinal: number;
  matches: number;
}

export interface FindApi {
  find: (text: string, options?: { forward?: boolean; findNext?: boolean }) => void;
  stop: () => void;
  onResult: (callback: (result: FindResult) => void) => void;
  removeResultListener: () => void;
  onOpen: (callback: () => void) => void;
  removeOpenListener: () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Updates — auto-update via tauri-plugin-updater.
// ─────────────────────────────────────────────────────────────────────────

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; progress: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

export interface UpdatesApi {
  getStatus: () => Promise<IpcResponse<UpdateStatus>>;
  getVersion: () => Promise<IpcResponse<string>>;
  check: () => Promise<IpcResponse<UpdateStatus>>;
  download: () => Promise<IpcResponse<null>>;
  install: () => Promise<IpcResponse<null>>;
  onStatusChanged: (callback: (status: UpdateStatus) => void) => () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Network — online/offline status.
// ─────────────────────────────────────────────────────────────────────────

export interface NetworkApi {
  getStatus: () => Promise<IpcResponse<boolean>>;
  updateStatus: (online: boolean) => Promise<IpcResponse<null>>;
  onOnline: (callback: () => void) => void;
  onOffline: (callback: () => void) => void;
  removeAllListeners: () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Default Mail App — Mac default-mail-handler toggle.
// ─────────────────────────────────────────────────────────────────────────

export interface DefaultMailAppApi {
  isDefault: () => Promise<boolean>;
  setDefault: (makeDefault: boolean) => Promise<IpcResponse<boolean>>;
  onMailtoOpen: (callback: (url: string) => void) => () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Calendar — Google Calendar V1.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Result of `window.api.calendar.getCalendars`. The shim flattens the
 * sidecar's `IpcResponse<{success, calendars, accountEmails}>` into the
 * top-level shape the SettingsPanel reads directly. Failure path uses
 * the standard `error` field.
 */
export interface CalendarGetCalendarsResult {
  success: boolean;
  calendars?: CalendarRow[];
  accountEmails?: Record<string, string>;
  error?: string;
}

export interface CalendarApi {
  getCalendars: () => Promise<CalendarGetCalendarsResult>;
  setVisibility: (
    accountId: string,
    calendarId: string,
    visible: boolean,
  ) => Promise<IpcResponse<null>>;
  getEvents: (params?: {
    accountId?: string;
    calendarId?: string;
  }) => Promise<IpcResponse<unknown[]>>;
  respondToEvent: (
    accountId: string,
    calendarId: string,
    eventId: string,
    response: "accepted" | "declined" | "tentative",
  ) => Promise<IpcResponse<{ ok: true }>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Attachments — composer attachment download/picker (V2).
// ─────────────────────────────────────────────────────────────────────────

export interface AttachmentsApi {
  // V2 stubs in the shim today; auto-stub fallthrough provides real
  // implementations once Tauri dialog/fs plugins land. The signatures
  // below match the shim's hand-rolled forwarders + the renderer's
  // existing callers.
  pickFiles: () => Promise<
    IpcResponse<Array<{ filename: string; path: string; mimeType: string; size: number }> | null>
  >;
  download: (
    emailId: string,
    attachmentId: string,
    filename: string,
    accountId: string,
  ) => Promise<IpcResponse<null>>;
  preview: (
    emailId: string,
    attachmentId: string,
    accountId: string,
  ) => Promise<IpcResponse<{ data: string; mimeType: string; filename: string } | null>>;
  // Auto-stub today — used by the composer to inline forwarded attachments.
  // TODO: add to sidecar contract when forwarder lifts.
  getForForward: (
    emailId: string,
    accountId: string,
  ) => Promise<IpcResponse<Array<{ filename: string; mimeType: string; content: string }>>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Agent — Claude agent panel + drafter (V2 for the most part).
// ─────────────────────────────────────────────────────────────────────────

export interface AgentApi {
  claudeAuthStatus: () => Promise<{
    success: boolean;
    data: { cliAvailable: boolean; authenticated: boolean; email?: string };
  }>;
  claudeLogin: () => Promise<IpcResponse<null>>;
  providers: () => Promise<IpcResponse<unknown[]>>;
  authenticate: (extensionId?: string) => Promise<IpcResponse<null>>;
  onProviders: <T = unknown>(cb: (data: T) => void) => () => void;
  onEvent: <T = unknown>(cb: (data: T) => void) => () => void;
  onDraftSaved: <T = unknown>(cb: (data: T) => void) => () => void;
  onLocalDraftSaved: <T = unknown>(cb: (data: T) => void) => () => void;
  removeAllListeners: () => void;
  removeDraftSavedListeners: () => void;
  // Optional verbs the renderer calls with `?.()` because the underlying
  // service is V2. They auto-stub through the shim's proxy fallback today
  // (sidecar lift will replace them). Declared optional so call sites
  // can keep optional-chaining without "always-present" warnings.
  run?: (
    taskId: string,
    providerIds: string[],
    prompt: string,
    context?: unknown,
  ) => Promise<IpcResponse<unknown>>;
  cancel?: (taskId: string) => Promise<IpcResponse<unknown>>;
  confirm?: (toolCallId: string, approved: boolean) => Promise<IpcResponse<unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Extensions — V1 framework surface.
// ─────────────────────────────────────────────────────────────────────────

export interface ExtensionManifestSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  panels: Array<{ id: string; scope: "sender" | "email"; title: string }>;
}

/** Per-extension entry returned by extensions.getPendingAuths. */
export interface ExtensionAuthInfo {
  extensionId: string;
  displayName: string;
  needsAuth: boolean;
  authType: "extension" | "agent";
}

export interface ExtensionsApi {
  getPendingAuths: () => Promise<IpcResponse<ExtensionAuthInfo[]>>;
  list: () => Promise<IpcResponse<ExtensionManifestSummary[]>>;
  setEnabled: (extensionId: string, enabled: boolean) => Promise<IpcResponse<null>>;
  getEnrichment: (
    extensionId: string,
    params: { accountId?: string; email: string; name?: string },
  ) => Promise<IpcResponse<unknown>>;
  listInstalled: <T = unknown>() => Promise<IpcResponse<T[]>>;
  install: () => Promise<IpcResponse<null>>;
  uninstall: () => Promise<IpcResponse<null>>;
  authenticate: (extensionId?: string) => Promise<IpcResponse<null>>;
  checkProviderHealth: () => Promise<IpcResponse<unknown>>;
  enrichEmail: () => Promise<IpcResponse<null>>;
  getEnrichments: () => Promise<IpcResponse<unknown[]>>;
  getPanels: () => Promise<IpcResponse<unknown[]>>;
  getProviderSettings: () => Promise<IpcResponse<unknown>>;
  saveProviderSettings: () => Promise<IpcResponse<null>>;
  getRendererBundle: (extensionId: string) => Promise<IpcResponse<string | null>>;
  onEnrichmentReady: <T = unknown>(cb: (data: T) => void) => () => void;
  onInstalled: <T = unknown>(cb: (data: T) => void) => () => void;
  onUninstalled: <T = unknown>(cb: (data: T) => void) => () => void;
  removeEnrichmentListeners: () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Background sync / prefetch / outbox / scheduledSend / style — V1 stubs.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Shape used by every event-noop namespace (background sync, outbox,
 * scheduled send, style). Every method returns a noop unsubscribe function
 * so callers can use the `useEffect` cleanup pattern uniformly.
 *
 * Each handler is generic on its payload (default `unknown`) so the
 * caller's narrower callback infers without a cast — this matches the
 * pattern in PrefetchApi above.
 */
export interface EventNoopApi {
  onProgress: <T = unknown>(cb: (data: T) => void) => () => void;
  onSent: <T = unknown>(cb: (data: T) => void) => () => void;
  onFailed: <T = unknown>(cb: (data: T) => void) => () => void;
  onStatsChanged: <T = unknown>(cb: (data: T) => void) => () => void;
  onEmailAnalyzed: <T = unknown>(cb: (data: T) => void) => () => void;
  removeAllListeners: () => void;
}

export interface PrefetchApi {
  // Payload typed in the renderer — the sidecar's prefetch worker emits
  // a tracked-state shape that lives in store/index.ts (PrefetchProgress).
  // The generic lets call sites narrow without a cast.
  onProgress: <T = unknown>(cb: (progress: T) => void) => () => void;
  onEmailAnalyzed: <T = unknown>(cb: (email: T) => void) => () => void;
  removeAllListeners: () => void;
}

export interface OutboxApi extends EventNoopApi {
  getStats: () => Promise<IpcResponse<OutboxStats>>;
}

export interface ScheduledSendApi extends EventNoopApi {
  list: (accountId?: string) => Promise<IpcResponse<ScheduledMessage[]>>;
  stats: () => Promise<IpcResponse<ScheduledMessageStats>>;
  create: (params?: Record<string, unknown>) => Promise<IpcResponse<null>>;
  cancel: (id?: string) => Promise<IpcResponse<null>>;
}

export interface StyleApi {
  infer: () => Promise<IpcResponse<string>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Summary — Claude-powered thread summarization.
// ─────────────────────────────────────────────────────────────────────────

export interface SummaryApi {
  thread: (
    threadId: string,
    accountId: string,
    opts?: { force?: boolean },
  ) => Promise<IpcResponse<R<"summary.thread">>>;
}

// ─────────────────────────────────────────────────────────────────────────
// Learned Rules — auto-archive rules built from user overrides.
// ─────────────────────────────────────────────────────────────────────────

export interface LearnedRuleRow {
  id: string;
  accountId: string;
  scope: "person" | "domain" | "category" | "global";
  scopeValue: string | null;
  action: "archived" | "trashed" | "replied" | "snoozed";
  count: number;
  enabled: boolean;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface LearnedRulesApi {
  list: (accountId?: string) => Promise<IpcResponse<{ rules: LearnedRuleRow[] }>>;
  toggle: (ruleId: string, enabled: boolean) => Promise<IpcResponse<{ rule: LearnedRuleRow }>>;
  reset: (
    accountId?: string,
  ) => Promise<IpcResponse<{ deletedRules: number; deletedObservations: number }>>;
}

// ─────────────────────────────────────────────────────────────────────────
// LocalWindowApiExtras — anything not derivable from the contract.
// ─────────────────────────────────────────────────────────────────────────
//
// Most of these are event-only namespaces, Tauri-direct commands, or V2
// stubs. Keeping them in this side interface keeps SidecarMethods focused
// on RPC contracts.

export interface LocalWindowApiExtras {
  /** Internal debug helper installed by the shim — not part of the RPC. */
  _debugLog?: (msg: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────
// WindowApi — the type that lives on `window.api`.
// ─────────────────────────────────────────────────────────────────────────
//
// One key per namespace. The shim's `installRealNamespaces()` builds
// exactly this shape (with auto-stub fall-through for any namespace not
// listed). `satisfies WindowApi` on the shim's export gives compile-time
// enforcement that every method here is provided.

export interface WindowApi extends LocalWindowApiExtras {
  diagnostics: DiagnosticsApi;
  openrouter: OpenRouterApi;
  theme: ThemeApi;
  snippets: SnippetsApi;
  accounts: AccountsApi;
  drafts: DraftsApi;
  analysis: AnalysisApi;
  archiveReady: ArchiveReadyApi;
  awaitingReply: AwaitingReplyApi;
  emails: EmailsApi;
  compose: ComposeApi;
  sync: SyncApi;
  imap: ImapApi;
  gmail: GmailApi;
  search: SearchApi;
  contacts: ContactsApi;
  sender: SenderApi;
  snooze: SnoozeApi;
  splits: SplitsApi;
  memory: MemoryApi;
  auth: AuthApi;
  settings: SettingsApi;
  usage: UsageApi;
  find: FindApi;
  updates: UpdatesApi;
  network: NetworkApi;
  defaultMailApp: DefaultMailAppApi;
  calendar: CalendarApi;
  attachments: AttachmentsApi;
  agent: AgentApi;
  extensions: ExtensionsApi;
  backgroundSync: EventNoopApi;
  prefetch: PrefetchApi;
  outbox: OutboxApi;
  scheduledSend: ScheduledSendApi;
  style: StyleApi;
  summary: SummaryApi;
  learnedRules: LearnedRulesApi;
}
