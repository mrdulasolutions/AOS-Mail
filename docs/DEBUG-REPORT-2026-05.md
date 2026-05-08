# AOS Mail — Debug Pass Report (2026-05)

## Methodology

A driver script (`scripts/debug-pass.ts`) walks every user-flow RPC the
renderer issues, against a fresh-DB sidecar instance spawned by the existing
`tests/sidecar/_helpers/sidecar-process.ts` harness. Each flow asserts:

- the method is registered (no `Method not found`),
- the response shape matches the contract,
- error paths return clean errors (not stack traces),
- timing is reasonable (any flow > 500 ms is flagged "slow").

Coverage: **152 flow checks** across the 130 registered RPC methods —
positive paths, negative paths, and round-trips.

The driver is checked in at `scripts/debug-pass.ts` and runs end-to-end
in ~3 s. It does **not** add tests under `tests/`; it stays in `scripts/`
so the 88/88 sidecar-test suite is untouched.

To rerun: `npx tsx scripts/debug-pass.ts`

## Topline

- 152 flow checks, **0 broken**, 0 slow, 0 weird
- Sidecar-test suite: 88/88 passing (baseline preserved)
- TypeScript: `npx tsc --noEmit` clean
- All flows in this run completed in **< 5 ms** in the harness (no real
  network); slowest were `network.getStatus` at 2 ms and a couple of
  prepared-statement first-hits at 1 ms

## What works

Every documented user flow round-trips cleanly against the sidecar's
RPC surface. Detailed pass list:

### First boot (fresh DB)
- `ping` → `{ ok, pid, node, ts }`
- `sync.init` → `[]` when no accounts
- `accounts.list` → `[]` when no accounts
- `settings.get` / `settings.getEA` / `settings.getPrompts` return
  populated defaults
- `theme.get` returns `{ preference: "system" }`
- `usage.getStats` / `usage.getHistory` / `usage.getStatsToday` /
  `usage.getStatsThisMonth` / `usage.getHistoryWithSubjects` return
  zeroed aggregates and `[]`
- `anthropic.hasApiKey` / `openrouter.hasApiKey` correctly report no
  key configured
- `network.getStatus` returns `{ online: true }`
- `extensions.list` returns the `sender-profile` bundled manifest
  with `enabled: true`
- Unknown method → `Method not found` (clean -32601 error)

### Add Gmail account flow
- `gmail.hasCredentials` flips `false → true` after `gmail.saveCredentials`
- `gmail.saveCredentials` rejects missing fields with a clear error
- `gmail.checkAuth` returns `{ accounts: [] }` with no tokens
- `gmail.listLabels` rejects with "No tokens for account" when called
  without auth
- `gmail.disconnect` rejects without `accountId`

### Add IMAP account flow
- `imap.presets` returns 6 presets (iCloud, Fastmail, Yahoo, Outlook,
  AOL, Gmail-IMAP)
- `imap.suggestForEmail` returns the matching preset or `null` for
  unknown domains; rejects missing `email`
- `imap.testConnection` to a bogus host (port 1) returns
  `{ ok: false, error: "..." }` (does not throw — by design)
- `imap.addAccount` rejects missing fields cleanly
- `imap.disconnect` / `imap.listFolders` reject missing `accountId`

### Inbox load + folder switch
- `sync.now` against an account with no real provider returns
  `{ accountId, fetched: 0, newRows: 0, newEmails: [], errors: […] }`
  — graceful per-account failure, not a crash
- `sync.getEmails` filters by `accountId`, `folder`, and `label`
- `sync.getSentEmails` returns rows tagged `SENT`
- `sync.prefetchBodies` returns `[]` for empty input, `[{id, body}]`
  for already-populated bodies; missing ids skipped
- `sync.fetchBody` returns the row when bodies are present
- `sync.loadMore` / `sync.start` / `sync.stop` / `sync.setInterval`
  all behave per the V1 surface

### Open thread + summary
- `emails.getThread` returns oldest-first, filtered by
  `(threadId, accountId)`
- `summary.thread` short-circuits single-message threads with
  `{ summary: "", actionItems: [], decisions: [], cached: false }`
- `summary.thread` rejects missing args
- `summary.thread` for a multi-message thread without an Anthropic
  key surfaces a clean error through the LLM client

### Triage (analysis)
- `analysis.analyze` rejects missing or unknown `emailId`
- `analysis.list` returns the seeded analysis row joined back to its
  email correctly
- `analysis.overridePriority` persists
- `analysis.analyzeBatch` rejects non-array `emailIds`; returns
  `{ results: [] }` for empty input
- `archiveReady.list` / `archiveReady.analyze` / `archiveReady.override`
  all behave correctly (note: `archiveReady.analyze` takes
  `{ threadId, accountId }`, not `{ emailId }`)

### Drafts
- `drafts.save`: rejects missing `emailId`/`body`; persists; empty
  body deletes
- `drafts.refine`: rejects missing args, rejects unknown email
- `drafts.rerunAgent`: rejects missing/unknown email
- `drafts.rerunAllAgents`: V1 noop returns `{ ok: true, ran: 0 }`

### Smart action verbs
- `emails.archive` / `emails.trash` / `emails.unarchive` /
  `emails.setRead` / `emails.setStarred` / `emails.archiveThread` /
  `emails.batchArchive` / `emails.batchTrash` all reject missing
  `emailId`/empty arrays cleanly
- Unknown id schemes raise `unknown email id scheme: …`

### Awaiting reply
- `awaitingReply.list` returns `[]` for an account with no waiting
  threads; rejects missing `accountId`
- `awaitingReply.draftNudge` rejects missing args, returns
  `no SENT message found in thread …` when no SENT message present

### Learned rules
- `learnedRules.list` returns `{ rules: [] }`
- `learnedRules.toggle` rejects missing/unknown `ruleId`
- `learnedRules.reset` is idempotent

### Calendar
- `calendar.list` with no Gmail accounts returns
  `{ success: true, calendars: [], accountEmails: {} }`
- `calendar.getEvents` with no accounts returns `[]`
- `calendar.respondToEvent` rejects missing args and invalid responses
- `calendar.setVisibility` rejects missing args

### Sender + extensions
- `sender.getCached` / `sender.getProfile` return `null` on miss
- `extensions.list` lists the bundled `sender-profile` extension
- `extensions.getEnrichment` rejects unknown `extensionId` with
  `no dispatcher` and missing `email` cleanly

### Settings
- `settings.set` / `settings.get` round-trip arbitrary keys
- `settings.setEA` / `settings.getEA` round-trip the EA shape
- `settings.setPrompts` / `settings.getPrompts` round-trip prompts;
  rejects non-string values
- `theme.set` / `theme.get` round-trip; `theme.set` rejects invalid
  preferences
- `settings.validateApiKey` rejects missing key

### Compose + send + local drafts
- `compose.send` rejects missing `accountId`/`to`; rejects unknown
  account
- Local-draft CRUD: `compose.listLocalDrafts` (empty),
  `compose.saveLocalDraft` (creates row), `compose.updateLocalDraft`,
  `compose.deleteLocalDraft` all round-trip
- `compose.getSendAsAliases` returns `{ aliases: [] }`

### Snippets / Splits / Snooze / Memory
- `snippets.create` / `snippets.update` / `snippets.delete`
  round-trip; `snippets.update` rejects unknown id with `not found`
- `splits.create` / `splits.update` / `splits.delete` similar
- `snooze.snooze` + `snooze.list` + `snooze.unsnooze` round-trip
- `memory.list` / `memory.categories` / `memory.save` /
  `draftMemory.list` round-trip; all require `accountId` cleanly
- `draftMemory.promote` cleanly throws `not yet wired` (a known stub)

### Search + contacts
- `search.query` / `search.suggestions` / `search.rebuildIndex` /
  `contacts.suggest` all behave correctly

### DB / theme / network
- `db.info` / `db.listAccounts` work
- `network.updateStatus` / `network.setOffline` work

### Account CRUD
- `accounts.list` / `accounts.remove` / `accounts.setPrimary` reject
  missing args cleanly

## What's broken

**No P0 or P1 breakages found.** Every flow the renderer can issue
returns a well-formed result or a clean, descriptive error.

## What's slow

**No flows exceed 500 ms** in the test harness (every check ≤ 3 ms).
This is the floor — without real Gmail/IMAP servers in scope, the
slowest paths (`sync.now`, `summary.thread` LLM call, `imap.testConnection`)
weren't exercised end-to-end. Worth measuring those against a real
account in a follow-up.

## Observations & low-priority items

These aren't broken-flow bugs but are worth flagging for tidy-up
work. None warrant the 1-line-fix carve-out.

### O1 (P2) — `sender.getCached` is dead surface

`sidecar/src/methods/sender.ts:55-59` registers `sender.getCached`,
but no renderer code calls it. The contract entry at
`src/shared/sidecar-contract.ts:535` documents it as "for cheap
pre-render hits", and the bundled extension dispatcher uses
`getCachedSender` directly (`extensions.ts:60-62`) instead of routing
through RPC. Either wire it into the extension host's pre-render path
or delete the RPC method.

### O2 (P2) — `network.setOffline` ignores its `offline` param

`sidecar/src/methods/network.ts:39-42`:

```ts
registerMethod("network.setOffline", () => {
  setStatus(false);
  return { online: isOnline };
});
```

The doc comment says "Force-offline path used by send failures
elsewhere", which matches the current implementation; but the test
harness driver passed `{ offline: true }` and `{ offline: false }`
and got the same `{ online: false }` response either time. Renderer
doesn't call this method, so no real impact, but the unused param
is a footgun if anyone wires it later. Either honor it or rename
the method to make intent obvious (e.g. `network.markOffline`).

### O3 (P2) — `analysis.list` is registered but unused by the renderer

`sidecar/src/methods/analysis.ts:144` registers `analysis.list`. No
renderer code calls it. The renderer derives analysis state from the
LEFT JOIN in `sync.getEmails`. Either delete the RPC method or
document its purpose as a debug-only surface.

### O4 (P2) — IMAP RPC namespace partially untyped in the contract

`src/shared/sidecar-contract.ts` has `imap.listFolders` but not
`imap.presets`, `imap.suggestForEmail`, `imap.testConnection`,
`imap.addAccount`, or `imap.disconnect`. The renderer shim casts
through `as Record<string, unknown>`. Tightening these would catch
shape drift end-to-end at compile time. Same for the `accounts.*`
namespace.

### O5 (P2) — `compose.getSendAsAliases` is permanently empty

`compose.ts:334`: `registerMethod("compose.getSendAsAliases", () => ({ aliases: [] }));`
Both Gmail and IMAP currently have no aliases implementation. The
renderer's compose UI works around this by falling back to the
primary email. Worth a TODO comment in the implementation pointing
to where Gmail send-as aliases would land.

### O6 (P2) — `network.setOffline` event semantics

When `network.setOffline` is called repeatedly, the `network:offline`
event is only emitted once (the `setStatus` short-circuit on
unchanged status). This is correct, but the renderer's offline UI
won't get a re-confirmation event if it missed the first emission
(e.g. before the listener was registered). The contract doesn't
require re-emission, so this is informational only.

### O7 (informational) — Background timers unref'd correctly

`sync.ts` (background sync timer), `snooze.ts` (auto-unsnooze timer)
both call `.unref()` on their handles, so the sidecar exits cleanly
when stdin closes. Spot-checked under the harness — closing the
sidecar after `sync.start` and `snooze.list` succeeds within the
2 s SIGTERM window. Good.

## Run instructions

```bash
# from worktree root
npx tsx scripts/debug-pass.ts
```

Output is line-by-line per flow plus a final JSON dump suitable for
piping to `jq`. The script exits non-zero only on harness failures
(unrecoverable spawn errors); per-flow failures are reported in the
output but don't propagate.

## Reproducibility

- Branch: `claude/debug-pass` off `main` at `df8021a`
- Sidecar-test baseline: `88/88 passing` (verified before & after)
- TypeScript: `npx tsc --noEmit` clean (verified before & after)
- Driver itself is one file: `scripts/debug-pass.ts`
