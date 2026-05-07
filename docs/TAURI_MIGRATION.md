# Tauri Migration

AOS Mail is migrating from Electron to **Tauri 2 + Node sidecar**. This doc tracks the migration's shape and current state.

## Why

The legacy `mail-app` (which we forked) is an Electron app. AOS Mail aims for **native Mac feel**, which Electron struggles to deliver: heavyweight binary (~150 MB), bundled Chromium, weaker integration with macOS-native chrome (NSToolbar, vibrancy, system services).

Tauri 2 gives us:
- A small Rust shell that uses the OS WebView (WKWebView on macOS)
- ~5 MB binary; faster startup; smaller memory footprint
- Direct macOS integration via crates like `window-vibrancy`, `cocoa`, `objc`
- Real native menu bar, traffic-light positioning, and system look-and-feel

We keep the existing TypeScript backend by running it as a **Node sidecar** spawned by Tauri. This avoids rewriting the Anthropic agent stack, MCP integration, Gmail sync, and SQLite layer in Rust — work that would buy us nothing user-visible.

## Target architecture

```
┌──────────────────────────────────────────────┐
│  Tauri 2 shell (Rust)                        │
│   - Native window, vibrancy, traffic lights  │
│   - Native menu bar, Keychain, notifications │
│   - Spawns + supervises Node sidecar         │
│   - invoke('sidecar_request', method, args)  │
└──────────────┬───────────────────────────────┘
               │ NDJSON over stdin/stdout
               │ (JSON-RPC 2.0 + notifications)
┌──────────────▼───────────────────────────────┐
│  Node sidecar (TypeScript)                   │
│   - Lifted from src/main/                    │
│   - Gmail OAuth + Anthropic + SQLite         │
│   - DB: ~/Library/Application Support/       │
│         AOS Mail/data/aos-mail.db            │
│   - Prefs: <dataDir>/preferences.json        │
│   - Tokens: <dataDir>/tokens-<email>.json    │
└──────────────┬───────────────────────────────┘
               │ Tauri events (via the shell)
┌──────────────▼───────────────────────────────┐
│  React renderer (TypeScript, Vite)           │
│   - Tailwind, Zustand, Tiptap                │
│   - bridge.ts: Tauri-aware invoke + listen   │
│   - electron-shim.ts: window.api Proxy       │
│     (real namespaces fall through to auto-   │
│     stubs for un-lifted methods)             │
└──────────────────────────────────────────────┘
```

## Wire format

NDJSON over stdin/stdout. Three message kinds:

```js
// Request (renderer → sidecar)
{"jsonrpc":"2.0","id":7,"method":"network.getStatus","params":{}}

// Response (sidecar → renderer, matched by id)
{"jsonrpc":"2.0","id":7,"result":{"online":true}}
{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}

// Notification / server-sent event (sidecar → renderer, no id)
{"jsonrpc":"2.0","method":"network:offline","params":null}
// → forwarded by Rust via app.emit("network:offline", null)
// → renderer subscribes via bridge.listen("network:offline", cb)
```

## Lift recipe

For each `src/main/ipc/<ns>.ipc.ts`:

1. **Port any DB query functions** into `sidecar/src/db/` or inline in the methods file. Drop Electron-specific imports (`electron`, `nativeTheme`, `BrowserWindow`).
2. **Create `sidecar/src/methods/<ns>.ts`** — small file that:
   - Imports `registerMethod` (and optionally `emit`) from `../rpc.js`
   - Exports `register<Ns>Methods()` that wires `ns.foo`, `ns.bar`, etc.
   - Calls `emit("<channel>", payload)` for any push events
3. **Register from `sidecar/src/index.ts`** with one new line.
4. **Replace the auto-stub** for that namespace in [`installRealNamespaces()`](../src/renderer/lib/electron-shim.ts) with a real entry that:
   - Calls `bridge.call("ns.method", params)` and wraps in `IpcResponse`
   - Calls `bridge.listen("ns:event", cb)` and tracks unlisteners for `removeAllListeners`

The wire format hides the details — every namespace lift uses the same primitives. Partially-lifted namespaces (some methods real, some still stubbed) coexist via the `mergedNamespace` Proxy wrapper.

## Status by namespace

Tracked against the 33 namespaces exposed at `window.api.*`.

| Namespace | Status | Notes |
| --- | --- | --- |
| `diagnostics` | ✅ NEW | `shellPing`, `ping`, `dbInfo`, `dbListAccounts`, `anthropicPing`, `anthropicHasApiKey`, `anthropicSetApiKey` — pipeline verification |
| `network` | ✅ lifted | First lift; pattern reference. In-memory + push events. |
| `theme` | ✅ lifted | JSON prefs file; renderer resolves `system` via matchMedia |
| `usage` | ✅ lifted | LLM cost / call history; pure SELECT against `llm_calls` |
| `auth` | ✅ lifted | Pure event subscriptions wired through bridge.listen. Events fire when gmail/extensions emit. `reauth`/`cancelReauth` stay error-stubbed pending OAuth integration. |
| `snippets` | ✅ lifted | CRUD via openStore() against snippets.json. Superhuman import stays stubbed. |
| `splits` | ✅ lifted | Same shape as snippets. |
| `snooze` | ✅ lifted | DB-backed; 30s auto-unsnooze setInterval emits notifications. |
| `sender` | ✅ lifted | sender_profiles table SELECT only. Extension enrichment cache integration arrives with extensions namespace. |
| `search` | ✅ lifted | FTS5 + LIKE fallback, parseAddresses, sanitizeFtsQuery, rebuildSearchIndex — biggest pure-DB lift. |
| `contacts` | ✅ lifted | getContactSuggestions across emails + sender_profiles. |
| `gmail` | 🟡 partial | `saveCredentials`, `hasCredentials`, `startOAuth` (with Tauri-shell URL open + auth:gmail-connected event), `cancelOAuth`, `checkAuth`, `disconnect` — all working end-to-end. Gmail API operations (fetch / send / labels / drafts) lift next. |
| `defaultMailApp` | 🔴 blocked | Needs Tauri equivalent for `app.setAsDefaultProtocolClient` (mailto handler). Probably via tauri-plugin-deep-link or platform-specific Rust. |
| `find` | 🔴 blocked | Needs JS-side `window.find()` instead of Electron's `webContents.findInPage`. |
| `updates` | 🔴 blocked | Migrate from `electron-updater` to `tauri-plugin-updater`. |
| `prefetch` | pending | Service + DB + progress events. |
| `outbox` | pending | DB + service with stats / sent / failed / authRequired events. Send path needs gmail-client lifted first. |
| `analysis` | pending | Anthropic-using; ready to lift now that anthropic-service is ported. Needs email-analyzer.ts + memory-context.ts dependencies. |
| `archiveReady` | pending | Same shape as analysis (Anthropic + DB write). |
| `drafts` | pending | DB + Anthropic + agent SDK. |
| `compose` | pending | DB + nodemailer + Gmail API. Send path needs gmail-client. |
| `accounts` | pending | DB CRUD + Gmail (some methods OAuth-blocked). |
| `sync` | pending | Gmail History API + DB orchestration. The biggest single namespace (59 KB). |
| `agent` | pending | Anthropic + agent SDK + permission gate. |
| `backgroundSync` | pending | Sync orchestration; depends on sync. |
| `calendar` | pending | Google Calendar API + DB. |
| `emails` | pending | DB CRUD; most methods are Gmail-API-coupled (archive, trash, star). |
| `extensions` | pending | Extension host system; runtime-loadable bundles. |
| `attachments` | pending | File system + Gmail API. |
| `scheduledSend` | pending | DB + timer + Gmail API. |
| `style` | pending | DB + Anthropic. |
| `onboarding` | pending | Initial setup flow; depends on sync. |
| `memory` | pending | DB CRUD + Anthropic for `classify`. |

**Key unblockers landed:**
- Phase 1B-ii — DB infrastructure (better-sqlite3, schema, opener, FTS5)
- Phase 1B-iv — anthropic-service lifted (createMessage with retry + cost recording)
- Phase 1B-vi — Gmail OAuth flow with loopback HTTP server + token store

## Phases

| Phase | What | Status |
| --- | --- | --- |
| 0 | Clone `mail-app`, rebrand to AOS Mail | ✅ done |
| 1a | Tauri scaffolding (Rust shell, sidecar skeleton, bridge stub) | ✅ done |
| 1b-i | First lift: `network` end-to-end + wire protocol with notifications | ✅ done |
| 1b-ii | Sidecar DB infrastructure (better-sqlite3, schema, opener) | ✅ done |
| 1b-iii | Lift remaining DB-only namespaces | 🟡 in progress (10 lifted) |
| 1b-iv | Lift anthropic-service | ✅ done |
| 1b-v | AI-using namespaces (analysis, drafts, archiveReady, style, memory, agent) | 🟡 unblocked, not started |
| 1b-vi | OAuth-in-Tauri research + implement | ✅ done |
| 1b-vii | OAuth-using namespaces (gmail-client API ops, accounts, sync, ...) | 🟡 in progress (gmail OAuth subset done) |
| 1b-viii | Electron-replacement namespaces (find, updates, defaultMailApp) | pending |
| 1c | Rolls into 1b — each lift swaps its stub | 🟡 in progress |
| 1d | Cut Electron deps; `npm run tauri:dev` is the only dev path | pending |
| 2 | IMAP provider behind a `MailProvider` interface | pending |
| 3 | Native Mac polish (vibrancy, menus, keys, dock badge) | 🟡 vibrancy + traffic lights done |
| 4 | Inbox agent V1 (triage, summary, draft, agent activity tray) | pending |
| 5 | Sign, notarize, ship via GitHub Releases + Tauri updater | pending |

## During the migration

Both shells coexist temporarily:
- `npm run dev` — still launches Electron (`electron-vite`)
- `npm run tauri:dev` — launches the Tauri shell + sidecar + Vite renderer
- `npm run build:electron` — produces an Electron build (legacy)
- `npm run build` — produces the Tauri build

The renderer source under `src/renderer/` is shared. Components that today use `window.api.*` keep working under Electron; the same calls flow through the sidecar under Tauri (real namespaces) or get a stub failure (auto-stubbed namespaces).

## Phase 1d cutover checklist

When we delete Electron, all of these must be true:
- [ ] All 33 IPC namespaces lifted into `installRealNamespaces()`
- [ ] OAuth flow works inside Tauri ✅ (Gmail; Microsoft Graph for Outlook in Phase 2 IMAP)
- [ ] Auto-update works via `tauri-plugin-updater`
- [ ] Native menu bar reproduces the existing keyboard shortcuts
- [ ] Vibrancy + traffic-light positioning render correctly in light + dark mode ✅
- [ ] Production sidecar packaging (Node SEA / @yao-pkg/pkg) replaces the dev-only inlined bash stub

After cutover, delete: `electron-vite.config.ts`, `src/main/`, `src/preload/`, and `electron`/`electron-builder`/`electron-updater`/`electron-vite` from `package.json`.

## Production note: sidecar packaging

The current sidecar binary is a **bash stub** that inlines the bundled CommonJS, writes it to a tmp file, sets `NODE_PATH` to a hardcoded absolute path of `sidecar/node_modules`, and execs `node`. **This is dev-mode only** — `sidecar/node_modules` won't ship in a packaged build.

The bundle is now ~30 MB (was 30 KB before googleapis was pulled in). Production migration plan: graduate to **Node SEA** (Node 20+ Single Executable Application) or **@yao-pkg/pkg**. Both can embed the runtime + bundle + native modules into one binary; SEA is preferable as it's official Node tooling. Outstanding work:
- Choose between SEA (simpler, official) and pkg (battle-tested, easier native module bundling)
- Update `package-sidecar.mjs` to produce that artifact
- Test on macOS-arm64 + macOS-x64 (Tauri builds both)
- Verify googleapis tree-shakes properly with whichever bundler

This is its own piece of Phase 1d.

## OAuth integration details

The Tauri-native Gmail OAuth flow lives in [`sidecar/src/services/oauth-gmail.ts`](../sidecar/src/services/oauth-gmail.ts) and [`sidecar/src/methods/gmail.ts`](../sidecar/src/methods/gmail.ts).

- Loopback port hardcoded to **3847** (matches the redirect URI users register in their Google Cloud Console — same as mail-app's Electron version).
- Tokens stored as plain JSON at `<dataDir>/tokens-<email>.json`. Same approach as Electron path; production should escalate to OS Keychain.
- The auth completion is delivered as a Tauri event (`auth:gmail-connected`) so the renderer's `startOAuth()` returns the same blocking-until-complete contract the Electron API had.

The same loopback pattern works for Microsoft Graph (Outlook) and the Phase 2 IMAP-with-OAuth providers — only scope/URL differ.
