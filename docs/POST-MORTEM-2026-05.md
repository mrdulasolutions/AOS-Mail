# Post-mortem — AOS Mail rebuild (May 2026)

This document audits the sidecar/Tauri rebuild from `e20bad2` (mailparser fix, the
first usable IMAP commit) through `df8021a` (sprint-5 merge: smart-action key).
~50 sprint commits were reviewed, the final state of every high-risk seam was
read line-by-line, and 88/88 sidecar unit tests pass on this branch.

The rebuild ships a working multi-account inbox with Claude triage, draft
generation, learned rules, and an awaiting-reply nudge. The seams between
them are mostly load-bearing-and-fragile rather than load-bearing-and-broken;
a small number of integrations were never wired, and a handful of silent
fall-throughs hide real failures in production.

## Executive summary

Top issues by user-visible impact, ranked:

1. **P1 — Gmail "search older email" is silently broken.** The renderer calls
   `window.api.emails.searchRemote(...)` from three locations (`App.tsx:292`,
   `App.tsx:329`, `SearchBar.tsx:132`); neither the shim nor the sidecar
   implements it. The auto-stub returns `{ success: false }`, the UI surfaces
   "Gmail search failed" with a Retry button that does nothing.
2. **P1 — Boot-time triage skips OpenRouter-only users.** `App.tsx:1551` and
   :1607 gate `analysis.analyzeBatch` on `diagnostics.anthropicHasApiKey()`.
   Users who configured an OpenRouter free model (the marketing
   feature of `claude/openrouter`) and no Anthropic key get an inbox with
   zero priorities forever.
3. **P1 — IMAP smart-action late-undo can never restore a message.**
   `unarchiveMessage` in `imap-actions.ts:195` *always* throws
   ("requires destination UID tracking"). The renderer's optimistic restore
   covers the in-window case, but if the 5s timer commits the archive to the
   server, the user has no way back. Trash/archive are also DELETE-from-DB
   rather than label-flip, so even an in-window undo restores a stale row
   that the next sync wipes out.
4. **P1 — `archiveReady.dismiss` RPC does not exist.** `UndoActionToast.tsx:90`
   calls it after every "Archive from Archive-Ready" tab archive. The handler
   is missing from `methods/archive-ready.ts`, so the dismissed thread keeps
   showing in the Archive-Ready list forever.
5. **P1 — Gmail `historyId` watermark uses string comparison.**
   `gmail-fetch.ts:349` compares Gmail history ids with `>` (string
   compare). When the id rolls from "9999" to "10000" the new (longer) id
   appears smaller and the watermark never advances; eventually the next
   incremental sync hits the 7-day expiry and falls back to a full sync.
   Behaviour is data loss-free but quietly burns Gmail API quota.

## Issue catalog

### 1. Gmail remote search auto-stub
- **Severity:** P1 (feature broken)
- **Surface:** `src/renderer/App.tsx:291-313`, `App.tsx:328-350`,
  `src/renderer/components/SearchBar.tsx:132`, `src/renderer/lib/electron-shim.ts:601`,
  `sidecar/src/methods/emails.ts` (no `emails.searchRemote` registered).
- **Repro:** Open the inbox, hit Cmd+F or `/`, type a query that has no local
  hit. The "Gmail search failed" banner appears with a non-functional Retry.
- **Root cause:** `searchRemote` was never lifted from the Electron
  implementation. The shim's `real.emails` block omits it; the sidecar
  has no handler. The auto-stub Proxy in `electron-shim.ts:38-61` returns
  `{ success: false, error: "...not wired through Tauri yet" }`.
- **Recommended fix:** Wire `emails.searchRemote` in
  `sidecar/src/methods/emails.ts` against `gmail-fetch.listGmailMessages`
  with an optional `q:` parameter (the API already supports it — see
  `listGmailMessages` opts). Add the corresponding shim entry that forwards
  `(query, accountId, limit, pageToken)` to the new RPC.
- **Risk if unfixed:** "Search older mail" — a flagship Superhuman-style
  feature — is dead. Users see a permanent error when typing anything not in
  the local 500-row window.

### 2. Boot triage gate ignores OpenRouter
- **Severity:** P1
- **Surface:** `src/renderer/App.tsx:1006-1018`, `:1551-1561`, `:1607-1612`.
- **Repro:** Configure an OpenRouter API key in Settings → AI Models, set
  Analysis to a free OpenRouter model, restart. The "Priority" tab is
  empty.
- **Root cause:** Every triage entry-point checks
  `diagnostics.anthropicHasApiKey()` before firing
  `analysis.analyzeBatch`. The shim/sidecar `anthropic.hasApiKey` only
  reports the Anthropic key, not the OpenRouter key.
- **Recommended fix:** Add an `anthropic.canAnalyze` (or rename
  `hasApiKey` semantics) RPC that returns `true` when *either* an
  Anthropic key OR a full set of OpenRouter-routed model selections are
  configured. Better: derive from the resolved `modelConfig.analysis` —
  if it's a `claude-*` id, check Anthropic; else check OpenRouter.
- **Risk if unfixed:** OpenRouter is a feature the changelog highlights as
  "free LLM tier in one click"; in practice the triage path is dark for
  those users.

### 3. IMAP unarchive throws unconditionally
- **Severity:** P1
- **Surface:** `sidecar/src/services/providers/imap-actions.ts:195-202`,
  `methods/emails.ts:139-149` (`emails.unarchive` dispatch).
- **Repro:** On an IMAP account, archive an email via Space (smart-action),
  wait >5 s for the optimistic timer to commit, then press Cmd+Z. The undo
  toast fails silently; the message is gone.
- **Root cause:** `archiveMessage` in `imap-actions.ts:168-172` runs
  `messageMove(...)` and then `DELETE FROM emails WHERE id = ?`. The original
  IMAP id encodes the *source* UID (`imap:<acct>:<folder>:<uid>`), but IMAP
  doesn't preserve UIDs across folders, so `unarchiveMessage` has no way to
  address the moved message and just throws. The renderer's
  `commitAction` in `UndoActionToast.tsx` only restores rows on dispatch
  failure, not on a fully-succeeded server commit.
- **Recommended fix:** Track the destination UID at archive time
  (`messageMove` returns it as `uidMap`). Persist it on the email row's
  `id` (or in a sidecar table keyed by original id) so unarchive can
  address the moved message. Alternative: implement archive as a `\Seen`
  + `\Deleted` flag flip rather than a folder move so UID stays stable.
- **Risk if unfixed:** Smart-action's safety promise ("5 s undo") is broken
  on IMAP. Users lose mail with no way back.

### 4. Missing `archiveReady.dismiss` RPC
- **Severity:** P1
- **Surface:** `src/renderer/components/UndoActionToast.tsx:80-95`,
  `sidecar/src/methods/archive-ready.ts` (no `archiveReady.dismiss`
  handler).
- **Repro:** Open Archive Ready tab, archive a thread, observe the
  console: `[shim] window.api.archiveReady.dismiss hit auto-stub`. The
  thread is gone from inbox but stays in the Archive-Ready list on next
  open.
- **Root cause:** When the Archive-Ready feature lifted, the renderer
  added a follow-up RPC to mark the row dismissed in the
  `archive_ready` table. The handler was never registered in the
  sidecar. The shim falls through to the auto-stub.
- **Recommended fix:** Register `archiveReady.dismiss` in
  `methods/archive-ready.ts`:
  ```ts
  registerMethod("archiveReady.dismiss", (p) => {
    const { threadId, accountId } = (p as { threadId?: string; accountId?: string }) ?? {};
    if (!threadId || !accountId) throw new Error("archiveReady.dismiss: requires { threadId, accountId }");
    getDb().prepare(`UPDATE archive_ready SET dismissed = 1 WHERE thread_id = ? AND account_id = ?`)
      .run(threadId, accountId);
    return { ok: true };
  });
  ```
- **Risk if unfixed:** Archive-Ready tab fills with already-archived
  threads and re-promotes them on subsequent runs. Confidence in the
  feature drops fast.

### 5. Gmail `historyId` is compared as a string, not a number
- **Severity:** P1
- **Surface:** `sidecar/src/services/providers/gmail-fetch.ts:349`.
- **Repro:** Static read. The line is
  `if (respHist > latest) latest = respHist;` — both operands are
  `string`. Gmail history ids are monotonically increasing integers
  formatted as decimal strings; once `latest` rolls past a power of 10
  (e.g. "9999" → "10000"), the *longer* string compares as smaller
  ("10000" < "9999" lexicographically).
- **Root cause:** `let latest: string` was kept after the History API
  was added. Comparison should `BigInt`-ify or `Number`-ify both sides.
- **Recommended fix:**
  ```ts
  if (respHist && BigInt(respHist) > BigInt(latest || "0")) latest = respHist;
  ```
  Bigint handles the full Gmail watermark range (currently fits in 53-bit
  but not for long).
- **Risk if unfixed:** Incremental sync silently regresses to whatever
  watermark we *did* compute; new mail can be missed for up to 7 days
  (until `HISTORY_EXPIRED` triggers a full resync). On busy accounts this
  manifests as "I got 3 emails on web Gmail but the desktop app only
  shows 1".

### 6. `LEFT JOIN analyses` returns stale rows for deleted emails
- **Severity:** P2
- **Surface:** `sidecar/src/db/schema.ts:64-70`,
  `services/providers/imap-actions.ts:171,176`,
  `sync.ts:1198-1230` (the `LEFT JOIN`).
- **Repro:** Static read. IMAP archive does `DELETE FROM emails WHERE id = ?`
  but never deletes from `analyses` or `drafts`. The schema has no `ON
  DELETE CASCADE`. The next time the row's `email_id` collides (UID reuse
  is rare but possible after IMAP UIDVALIDITY change), the `LEFT JOIN`
  attaches an analysis that belonged to a different message.
- **Root cause:** `analyses.email_id` foreign key references `emails(id)`
  but better-sqlite3 does not enforce FKs by default
  (`PRAGMA foreign_keys = ON` is missing in `db/index.ts`). Even if
  enforced, no `ON DELETE CASCADE` clause exists.
- **Recommended fix:** Add `PRAGMA foreign_keys = ON` after WAL pragma in
  `db/index.ts`, and ensure archive/trash flows clean up dependent rows
  (or rewrite IMAP archive to a label flip rather than DELETE — see
  issue 3).
- **Risk if unfixed:** Analyses table grows unboundedly; in degenerate
  cases the wrong analysis is rendered for a recycled UID.

### 7. `analysis.overridePriority` doesn't feed the learned-rules engine
- **Severity:** P2
- **Surface:** `sidecar/src/methods/analysis.ts:127-142`,
  `sidecar/src/methods/emails.ts:51-90` (only path that calls
  `recordOverride`).
- **Repro:** Static read. The renderer's manual priority override (from
  the priority badge dropdown) calls `analysis.overridePriority`. That
  handler simply writes a row to `analyses` and returns. It does not
  invoke `recordOverride`, so the learned-rules engine never sees this
  signal.
- **Root cause:** `maybeRecordOverride` is wired only into archive/trash.
  When the user says "this doesn't actually need a reply" via the badge,
  no learning happens.
- **Recommended fix:** In `analysis.overridePriority`, when the new
  needsReply contradicts the previous analysis, fire `recordOverride`
  with `action: "archived"` (or a new `action: "manual-override"` if
  we want to track it separately).
- **Risk if unfixed:** A core compose-with-the-system feature — "the more
  you correct it, the smarter it gets" — only fires from the
  archive/trash gestures. Manual badge overrides are wasted training
  signal.

### 8. Gmail archive doesn't update local `label_ids` until next sync
- **Severity:** P2
- **Surface:** `sidecar/src/services/providers/gmail-actions.ts:27-45`.
- **Repro:** Static read. `archiveMessageGmail` calls
  `users.messages.modify({ removeLabelIds: ["INBOX"] })` but doesn't
  update the local `emails.label_ids` JSON. The renderer's optimistic
  removal hides the row, but the next `sync.getEmails` SELECT (e.g.
  account switch + back) reloads the row with `INBOX` still in
  `label_ids` until the History API catches up.
- **Root cause:** The IMAP path mirrors local state (line 171:
  `DELETE FROM emails`); the Gmail path does not. Inconsistent.
- **Recommended fix:** After the API call returns, run an
  `UPDATE emails SET label_ids = json(...) WHERE id = ?` to remove
  `INBOX` from the local row. Same pattern for trash/star/setRead so
  archive doesn't re-show across account switches before history sync
  lands.
- **Risk if unfixed:** "Reappearing archived emails" UX wart whenever
  the user switches accounts or refreshes within ~30 s of an archive.

### 9. Background `sync.start` timer never persists across sidecar restarts
- **Severity:** P3
- **Surface:** `sidecar/src/methods/sync.ts:129-186`.
- **Repro:** Quit + reopen the app. The renderer calls `sync.now` for
  each connected account at boot and then `sync.start`. If the sidecar
  process crashes, `sync.start` is never re-invoked until the next
  manual refresh, because `App.tsx`'s `initializeSync` only runs once.
- **Root cause:** Timers live in process memory; the sidecar's
  startup code (`index.ts`) doesn't auto-restart timers for accounts
  that were running before. Acceptable for a fresh launch but not for
  a watchdog-restarted sidecar.
- **Recommended fix:** Auto-start a timer for every connected account
  during `registerSyncMethods()` initialization (or wire a heartbeat
  RPC the Tauri host can call when it respawns the sidecar). Document
  the lifecycle in CLAUDE.md.
- **Risk if unfixed:** Background sync silently dies on sidecar
  restarts. New mail not surfaced until user clicks Refresh.

### 10. `prefetchBodies` is fire-and-forget against the sidecar lifetime
- **Severity:** P3
- **Surface:** `src/renderer/App.tsx:578-605`,
  `sidecar/src/methods/sync.ts:223-283`.
- **Repro:** Static read. The renderer's `prefetchEmailBodies` aborts an
  in-flight loop with an `AbortController` only on the renderer side,
  but the sidecar continues processing the batch and emitting
  `prefetch:progress` events. The renderer ignores them, so they're
  harmless, but if the user switches accounts mid-prefetch the sidecar
  burns N IMAP connections fetching bodies for the previous account.
- **Root cause:** The sidecar RPC has no cancel mechanism. Aborting the
  renderer's `await window.api.sync.prefetchBodies(...)` only stops the
  Promise resolution — the underlying NDJSON request is still
  processed.
- **Recommended fix:** Add a `sync.prefetchBodiesCancel` (or an
  `AbortSignal`-aware sidecar protocol). For V1, accept the wasted work
  and document it.
- **Risk if unfixed:** Wasted IMAP/Gmail quota on rapid account
  switching. Not user-visible day-to-day.

### 11. Schema migration step swallows non-"duplicate column" errors
- **Severity:** P2 (data corruption potential)
- **Surface:** `sidecar/src/db/index.ts:67-88`.
- **Repro:** Static read. The migration loop runs `ALTER TABLE` DDLs and
  catches *any* error, only escalating those that don't match
  `/duplicate column name/`. A typo'd `DEFAULT` value, NOT NULL constraint
  conflict, or syntax error becomes a `log.warn` and the schema sits
  half-migrated.
- **Root cause:** No real migration framework; ad-hoc try/catch.
- **Recommended fix:** Replace with a numbered-migration system (mirror
  the Electron `NUMBERED_MIGRATIONS` pattern referenced in CLAUDE.md).
  Bookkeep applied versions in a `schema_version` table and run
  migrations inside a transaction; failure aborts and logs the user
  out of the bad version.
- **Risk if unfixed:** A future schema change can leave the user's
  local DB on the wrong shape. Better-sqlite3 will then silently miss
  expected columns, returning `undefined` in row mappers. The current
  surface is small enough that no production user has hit this yet.

### 12. `setApiKey` writes API keys plaintext to `preferences.json`
- **Severity:** P2 (security)
- **Surface:** `sidecar/src/services/anthropic.ts:85-92`,
  `services/providers/openrouter.ts:99-101`.
- **Repro:** Configure an Anthropic key in Settings → AI Models. Inspect
  `~/Library/Application Support/AOS Mail/preferences.json` — the key is
  in plaintext.
- **Root cause:** TODO comments in both files: "for production we should
  escalate to OS Keychain. plaintext on disk; ok for V1, not ok for
  shipping." That migration hasn't happened.
- **Recommended fix:** Use Tauri's `tauri-plugin-keyring` (or the macOS
  Keychain via `osascript`) for `anthropicApiKey` and
  `openRouterApiKey`. Migrate existing plaintext values on first run.
- **Risk if unfixed:** Anyone with disk access (malware, lost laptop
  before disk encryption verifies, leaked Time Machine backup) reads
  the key.

### 13. `usage.getStats` "today" uses UTC, not local time
- **Severity:** P3
- **Surface:** `sidecar/src/methods/usage.ts:66-68`.
- **Repro:** Static read. `WHERE date(created_at) = date('now')`. SQLite's
  `date('now')` returns UTC. A user in PST seeing the "today" tray badge
  at 9 PM is already past midnight UTC; an LLM call from 2 PM PST will
  show in "today" even though the user's local "today" hasn't ended.
- **Root cause:** Pasted from the Electron analyzer where the same bug
  also exists.
- **Recommended fix:** Use `date('now','localtime')` or compute the
  client-local boundary in JS and pass an ISO string.
- **Risk if unfixed:** Cosmetic mismatch on the daily cost badge.

### 14. Smart-action "skip" branch is dead code
- **Severity:** P3 (dead code)
- **Surface:** `src/renderer/lib/smart-action.ts:58-60`,
  `sidecar/src/services/email-analyzer.ts:264-272`,
  `sync.ts:1015-1018`.
- **Repro:** Static read. `pickSmartAction` checks
  `priority === "skip"` first. The analyzer never emits "skip" — its
  priority field is `"high" | "medium" | "low" | null`. The persisted
  priority column is `null` for skipped emails, which the row mapper
  surfaces as `undefined`, not `"skip"`. The first decision branch
  never fires.
- **Root cause:** `Email-analyzer` was simplified during the lift but
  smart-action still references the older 4-priority shape.
- **Recommended fix:** Either teach the analyzer to emit "skip" for
  needsReply=false (and have the mapper preserve it) OR delete the
  branch and document that "automated-fyi" handles the same case.
- **Risk if unfixed:** Reading the smart-action picker is misleading;
  future contributors will assume the branch fires and design around
  it.

### 15. `sender.lookup` shim drops the `from` header it receives
- **Severity:** P3
- **Surface:** `src/renderer/lib/electron-shim.ts:1203`,
  `sidecar/src/methods/sender.ts:63-71`.
- **Repro:** Static read. Shim calls `bridge.call("sender.lookup",
  { from, email })`. The sidecar reads `{ email, name, accountId }`.
  The `from` (header containing the display name) is silently dropped
  and the sidecar falls back to using the bare email as the display
  name in its prompt.
- **Root cause:** Shim+sidecar contract drift. The contract test in
  `tests/sidecar/contract.test.ts` doesn't pin `sender.lookup` params.
- **Recommended fix:** Either rename `from` → `name` in the shim or
  parse `from` ("Name <email@x.com>") into `name` before forwarding.
  Add the `sender.lookup` shape to the contract `_MustHave` list so
  drift fails CI.
- **Risk if unfixed:** Web search prompts get a worse signal; the
  cached profile may be lower quality.

### 16. Boot-path duplicate sync → analyzer fan-out
- **Severity:** P3
- **Surface:** `src/renderer/App.tsx:929-937`, `:1546-1565`.
- **Repro:** Static read. `initializeSync` fires both `sync.now` AND
  starts the background timer for each account, then a separate
  `useQuery` triggers `gmail.fetchUnread` (= `sync.getEmails`) in
  parallel. Both call `analysis.analyzeBatch`. If the same email is
  in both batches we end up making two Claude calls for it.
- **Root cause:** Two parallel triage paths exist: the manual one in
  initializeSync's onNewEmails listener, and the React-Query
  fetchUnread effect. Both decide to triage on the same data
  independently.
- **Recommended fix:** De-dupe at the analyzer level — `analysis.analyze`
  should look up the existing `analyses` row and short-circuit if
  `analyzed_at` is recent. Or hoist the boot-time triage to one
  effect.
- **Risk if unfixed:** ~2x analysis cost on first boot per account.

### 17. `prefetch:progress` events emit raw email ids without redaction
- **Severity:** P3 (privacy/log policy)
- **Surface:** `sidecar/src/methods/sync.ts:241-280`.
- **Repro:** Static read. The progress event includes
  `currentTask.emailId`. The CLAUDE.md logging policy says
  "Only log IDs (email_id, account_id, thread_id)". The notification
  payload is fine; just confirming the policy.
- **Root cause:** N/A — flagged for completeness.
- **Recommended fix:** None needed (ids are the policy).
- **Risk if unfixed:** None.

### 18. `recordOverride` fires Claude classification fire-and-forget
- **Severity:** P3
- **Surface:** `sidecar/src/methods/emails.ts:74-89`.
- **Repro:** Static read. `maybeRecordOverride` calls
  `recordOverride(...)` (which itself runs a Claude classification call)
  without awaiting. The IPC verb returns to the renderer immediately,
  which is intentional — but if the user hits archive 50 times in a
  row and quits the app within ~1 s, we'll have 50 in-flight Claude
  calls dangling. The sidecar process exits when stdin closes; pending
  promises die without their `recordCall` ever flushing.
- **Root cause:** Fire-and-forget design has no completion bookkeeping
  beyond the `.catch(...)` log line.
- **Recommended fix:** Track outstanding promises in a Set and `await
  Promise.all(outstanding)` on SIGTERM. Or accept the loss and document
  it.
- **Risk if unfixed:** A small number of would-be learned-rule
  observations are lost on app exit. Cosmetic for the user; nuisance
  for cost accounting.

### 19. `learned-rules` test harness exposes `devRecordOverride` via
   env-var gate, but the gate isn't checked against `NODE_ENV`
- **Severity:** P3
- **Surface:** `sidecar/src/methods/learned-rules.ts:60-97`.
- **Repro:** Static read. If a packaged production binary is ever
  launched with `LEARNED_RULES_TEST_HOOKS=1` in the environment (an
  attacker on the user's machine could set it before invoking the
  binary, or a malicious launchctl plist could), the dev RPC methods
  would register and let arbitrary callers manipulate the rules
  engine.
- **Root cause:** Defense in depth missing — the comment acknowledges
  the trade-off ("mitigated by the env-var gate") but doesn't combine
  it with `NODE_ENV !== "production"`.
- **Recommended fix:** Gate on
  `process.env.LEARNED_RULES_TEST_HOOKS === "1" && process.env.NODE_ENV !== "production"`.
  Or move the dev hooks into a separate file imported only by the test
  harness.
- **Risk if unfixed:** Local privilege-escalation surface for a
  malicious app on the same machine. Low likelihood; trivial to fix.

### 20. `useThreadedEmails` runs `groupByThread` on every store update
- **Severity:** P3 (performance)
- **Surface:** `src/renderer/store/index.ts:1927-2020`.
- **Repro:** Static read. The `useMemo` deps include `emails` (the
  whole list). Any sync-buffer flush touches the array reference,
  re-running `groupByThread` over up to 500 emails. With ~2000 IMAP
  rows the cost is real.
- **Root cause:** `bufferUpdateEmails` returns a new array reference
  even when only one email changed.
- **Recommended fix:** Move thread grouping to a Zustand selector that
  computes incrementally (Map-based), or batch buffer flushes at most
  once per animation frame.
- **Risk if unfixed:** Noticeable lag during heavy sync; e.g.
  initial backfill jitter.

### 21. Schema lacks `ON DELETE CASCADE` for thread-summary cache
- **Severity:** P3
- **Surface:** `sidecar/src/methods/summary.ts:36-47`.
- **Repro:** Static read. `thread_summaries` is keyed on
  `(thread_id, account_id)`. When all messages of a thread are
  archived (and IMAP path DELETEs them), the row stays. On the very
  rare collision with a new thread reusing the same ID we'd serve a
  stale summary.
- **Root cause:** No FK enforcement — same family as issue 6.
- **Recommended fix:** Either purge `thread_summaries` rows whose
  `thread_id` no longer has any `emails` row, or accept the staleness
  (low-impact; keyed on `latest_message_id` which would mismatch).
- **Risk if unfixed:** Negligible; fix is cheap if you're already
  touching this code.

### 22. Settings panel calls `extensions.authenticate` without provider
   metadata
- **Severity:** P3
- **Surface:** `src/renderer/App.tsx:2345-2350`,
  `electron-shim.ts:2205-2207` (returns a hardcoded "not supported").
- **Repro:** A bundled extension that ever fires
  `auth:extension-auth-required` will surface an "Authenticate"
  banner. Clicking it calls `window.api.extensions.authenticate(extId)`
  which the shim hard-codes to fail. The user sees an error toast
  with no remediation.
- **Root cause:** V1 ships only the bundled `mail-ext-web-search`
  which is sidecar-internal and never fires the auth-required event,
  so this code is unreachable today. But the renderer surface assumes
  it will work.
- **Recommended fix:** Hide the Authenticate button when the
  extension's auth method is the V1 stub; or implement the
  `extensions.authenticate` RPC.
- **Risk if unfixed:** Latent — surfaces only when V2 extensions
  land.

### 23. `sender.lookup` model gate is an `if (!startsWith("claude-"))` —
   ignores future Anthropic model name conventions
- **Severity:** P3
- **Surface:** `sidecar/src/services/sender-lookup.ts:278-283`.
- **Repro:** Static read. If Anthropic ever ships a model whose id
  doesn't start with `claude-` (unlikely, but `aos-` or a versioned
  rename), the gate rejects it. Today's Claude id format is stable;
  flagged for awareness.
- **Recommended fix:** Maintain a whitelist of supported web-search
  models in one place (`PRICING` keys are a candidate).
- **Risk if unfixed:** Negligible; catch-on-rename.

### 24. `awaitingReply` does not de-snooze its detector
- **Severity:** P2
- **Surface:** `sidecar/src/services/awaiting-reply.ts:103-119`,
  `sidecar/src/db/schema.ts:174-184` (`snoozed_emails`).
- **Repro:** Static read. The awaiting-reply detector finds threads
  whose latest message is the user's. It does NOT exclude threads
  that the user has snoozed. So a snoozed thread waiting on a reply
  shows in the rail badge AND the view.
- **Root cause:** The detector queries `emails`, not the snooze
  table. Easy to miss because the snooze namespace lifted before
  awaiting-reply.
- **Recommended fix:** Left-join `snoozed_emails` on `thread_id` and
  filter out rows whose `snooze_until > now()`.
- **Risk if unfixed:** "Awaiting Reply" surfaces threads the user
  has explicitly deferred. Confusing rail badge.

### 25. `sync.now` events fire even when fetch returned no new rows
- **Severity:** P3 (UX polish)
- **Surface:** `sidecar/src/methods/sync.ts:90-95`.
- **Repro:** Static read. If `result.newEmails.length === 0` the
  branch is skipped, which is correct. But `sync:status-change`
  still fires `idle` at the end which causes the renderer's
  `setSyncStatus` to re-render the title bar dot. Cosmetic.
- **Root cause:** N/A — flagged for completeness.
- **Recommended fix:** Compare prev/new status before emitting.
- **Risk if unfixed:** Negligible re-render churn.

### 26. `compose.send` swallows SMTP partial failures (`rejected` array
   present but no surfacing)
- **Severity:** P2
- **Surface:** `sidecar/src/methods/compose.ts:104-134`.
- **Repro:** Static read. `sendViaSmtp` returns `{ messageId, accepted,
  rejected }`. `compose.send` returns `{ id, threadId, messageId,
  accepted, rejected }` but the renderer in `useComposeForm` reads
  only `success` (from the IPC response wrapper). If 3 of 5 recipients
  rejected, the renderer shows a "Sent!" toast and the user has no
  signal that 3 didn't deliver.
- **Root cause:** The shim's `compose.send` wraps in an IpcResponse
  but doesn't propagate `rejected`. The renderer treats `success:
  true` as "everything sent."
- **Recommended fix:** When `rejected.length > 0`, surface a yellow
  "Partial send" banner with the bounced recipients.
- **Risk if unfixed:** Silently delivered partial sends. Email-app
  table-stakes UX.

## Architectural debt

These are NOT bugs but coupled patterns that future work will fight against.

1. **`window.api` is `any`-shaped at the renderer boundary.** The shim
   builds the surface with Proxy + auto-stub, but the renderer reads
   via `(window as any).api` casts in many call-sites
   (`useKeyboardShortcuts.ts:797`, `AwaitingReplyView.tsx:34`,
   `EmailDetail.tsx` x4, etc.). Renaming an RPC method or changing a
   param shape is a silent breaking change. The contract typing in
   `bridge.call` works end-to-end but it's not what most consumers
   use. **Fix:** type `window.api` from the contract by generating a
   declaration file — e.g. a `WindowApi` namespace mirroring
   `SidecarMethods`. The shim's `installRealNamespaces` would consume
   it as the source of truth.

2. **Three error-toast surfaces (`UndoActionToast`, `SmartActionToast`,
   `UndoSendToast`) overlap.** They share an undo timer concept but
   reinvent expiration, the Cmd+Z handler, and the cancellation
   path. The smart-action toast bolts onto undo via the
   `smartActionToastId` cross-link. Future undo features will pile
   on more bespoke surfaces. **Fix:** unify around a single
   `Toast` queue/dispatcher with kind-specific renderers.

3. **`emails` schema mixes IMAP + Gmail rows under one PRIMARY KEY
   (id) but assumes account_id is implicit.** Several queries filter
   by `account_id` *separately* from the id (`getEmailsForThread`,
   `archiveThread`). The id format prevents collisions today, but
   per-account thread tables would be a cleaner model for the
   "switch account → instant" UX path. The current `WHERE thread_id
   = ? AND account_id = ?` works but the index is `(thread_id)`
   only — secondary by account is on disk twice (`(account_id)`).
   **Fix:** add a composite `(account_id, thread_id)` index, or shard
   by account.

4. **No `service` boundary for retries — analyzer/drafter/summary all
   open-code their model resolution.** `resolveAnalysisModel`,
   `resolveDraftModel`, `resolveRefineModel`, `resolveSummaryModel`,
   `resolveArchiveReadyModel`, `resolveSenderLookupModel`,
   `resolveClassifyModel` (in learned-rules) all do the same
   "preferences → tier-name → concrete-id" dance. Five places to
   change when a tier name flips. **Fix:** one helper in
   `services/anthropic.ts` taking the prefs key (`"analysis" |
   "drafts" | "summary" | …`) and returning the resolved id.

5. **Tests against IPC ergonomics, not behavior.** `tests/sidecar/*`
   skews toward "throws when missing X" assertions (`requires {
   accountId }`), which is valuable for the contract surface but
   doesn't catch the kind of bugs in this audit. The Gmail
   `historyId` string-compare bug (issue 5), the missing
   `archiveReady.dismiss` (issue 4), the auto-stub fall-throughs
   (issue 1) — all would have been caught by an integration test that
   walks the full archive→list→dismiss flow with seeded fixtures.
   **Fix:** add behavior-level tests around the highest-stakes
   cross-feature compositions (smart-action → archive → learned
   rule → next-email-skipped, awaiting-reply → snooze interaction,
   etc).

## Shipped quality assessment

**What's solid.** The core lift mechanics — `bridge.call`, `dispatch`, the
JSON-RPC framing in `rpc.ts`, the contract typing — are clean and the right
shape. The IMAP and Gmail provider abstractions in `services/providers/*` are
small and direct, and `sync.ts`'s upsert + history-based incremental sync is
mostly correct (modulo the string-compare watermark). The 88 unit tests pin
the right argument-validation surface; type-level contract drift fails CI.

**What's load-bearing-and-fragile.** The renderer's `App.tsx` boot path is
2700 lines of effects with implicit ordering: theme → setup wizard →
accounts → sync init → sync.now → background timer → React Query refetch →
triage. It works but several effects re-fire under conditions that aren't
obvious from the deps array (`apiKeyConfigured` polling every 5 s, dock
badge useMemo over the entire emails array). The `electron-shim.ts` Proxy
is clever — auto-stubbing every namespace lets partial migrations coexist —
but the cleverness is what hides the missing handlers (`searchRemote`,
`archiveReady.dismiss`). A single end-to-end "every namespace at least
returns success" test would have caught both.

**What's load-bearing-and-broken.** Three things, in priority order: (1)
the OpenRouter "free LLM" feature is partially broken because the boot
triage gate only checks for an Anthropic key (issue 2). (2) The IMAP
late-undo path (issue 3) — smart-action's safety promise is undelivered on
non-Gmail accounts. (3) Gmail remote search (issue 1) — the auto-stub
silently masks a missing implementation that the UI assumes exists.

**What's polished.** Smart-action picker's decision matrix is genuinely
good — five short branches, single source of truth, pure. The learned-rules
encoding (prefix + JSON in existing tables) is a clever no-migration trick
that landed correctly. The OpenRouter shape adapter (Anthropic Message →
OpenAI chat → Anthropic Message) is small, isolated, and well-explained.
The awaiting-reply detector's pure-SQL approach is fast and predictable.
These three modules are good models for future feature lifts.
