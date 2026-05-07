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
│   - Gmail + IMAP + Claude agents + SQLite    │
│   - DB: ~/Library/Application Support/       │
│         AOS Mail/data/aos-mail.db            │
│   - Prefs: <dataDir>/preferences.json        │
└──────────────┬───────────────────────────────┘
               │ Tauri events (via the shell)
┌──────────────▼───────────────────────────────┐
│  React renderer (TypeScript, Vite)           │
│   - Tailwind, Zustand, Tiptap                │
│   - bridge.ts: Tauri-aware invoke + listen   │
│   - electron-shim.ts: window.api Proxy       │
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
2. **Create `sidecar/src/methods/<ns>.ts`** — a small file that:
   - Imports `registerMethod` (and optionally `emit`) from `../rpc.js`
   - Exports `register<Ns>Methods()` that wires `ns.foo`, `ns.bar`, etc.
   - Calls `emit("<channel>", payload)` for any push events
3. **Register from `sidecar/src/index.ts`** with one new line.
4. **Replace the auto-stub** for that namespace in [`installRealNamespaces()`](../src/renderer/lib/electron-shim.ts) with a real entry that:
   - Calls `bridge.call("ns.method", params)` and wraps in `IpcResponse`
   - Calls `bridge.listen("ns:event", cb)` and tracks unlisteners for `removeAllListeners`

The wire format hides the details — every namespace lift uses the same primitives.

## Status by namespace

Tracked against the 33 namespaces exposed at `window.api.*`.

| Namespace | Status | Notes |
| --- | --- | --- |
| `diagnostics` | ✅ NEW | `shellPing`, `ping`, `dbInfo`, `dbListAccounts` — used to verify the pipeline |
| `network` | ✅ lifted | First lift; pattern reference. In-memory + push events. |
| `theme` | ✅ lifted | JSON prefs file; renderer resolves `system` via matchMedia |
| `usage` | ✅ lifted | LLM cost / call history; pure SELECT against `llm_calls` |
| `auth` | 🟡 stubbed | Pure event subscriptions. Wire-up trivial; events fire only when gmail/extensions lift. |
| `defaultMailApp` | 🔴 blocked | Needs Tauri equivalent for `app.setAsDefaultProtocolClient` (mailto handler). |
| `find` | 🔴 blocked | Needs JS-side `window.find()` instead of Electron's `webContents.findInPage`. |
| `updates` | 🔴 blocked | Migrate from `electron-updater` to `tauri-plugin-updater`. |
| `prefetch` | pending | Service + DB + progress events (clean DB lift, plus a service with onProgress callback). |
| `outbox` | pending | DB + service with stats / sent / failed / authRequired events. |
| `snooze` | pending | DB + service with auto-unsnooze timer. The setInterval lives in the sidecar. |
| `snippets` | pending | electron-store → preferences.json migration; small DB. |
| `splits` | pending | electron-store + DB; per-account splits. |
| `search` | pending | DB FTS5 only (no service, no events). Largest pure-DB lift. |
| `memory` | pending | DB CRUD on memories + draft_memories. |
| `archiveReady` | pending | DB + service + Anthropic API. |
| `analysis` | pending | DB + Anthropic API. |
| `drafts` | pending | DB + service + Anthropic API. |
| `compose` | pending | DB + nodemailer + Gmail API. Largest single namespace (30 KB). |
| `gmail` | 🔴 blocked | OAuth flow needs Tauri equivalent (`tauri-plugin-oauth` or hand-rolled local-server callback). |
| `accounts` | 🔴 blocked | Same OAuth blocker. |
| `sync` | 🔴 blocked | Same OAuth blocker; biggest IPC handler (59 KB). |
| `agent` | pending | Anthropic + agent SDK + permission gate. |
| `backgroundSync` | 🔴 blocked | OAuth + sync. |
| `calendar` | 🔴 blocked | Google Calendar OAuth. |
| `contacts` | pending | DB CRUD; small. |
| `emails` | pending | DB CRUD on emails. |
| `sender` | pending | DB CRUD on sender_profiles + Anthropic for lookup. |
| `extensions` | pending | Extension host system; runtime-loadable bundles. |
| `attachments` | pending | File system + Gmail API. |
| `scheduledSend` | pending | DB + timer + Gmail API (partially blocked by OAuth). |
| `style` | pending | DB + Anthropic. |
| `onboarding` | pending | Initial setup flow; light. |

**OAuth blocker note:** Gmail / Calendar / Microsoft accounts all need a Tauri-native OAuth flow. Two paths: `tauri-plugin-oauth` (community plugin) or a hand-rolled local HTTP server (Node side) that the system browser redirects to. We'll resolve this before lifting `gmail`, after which `accounts`, `sync`, `backgroundSync`, `calendar`, `compose` (sending), `attachments` (downloads) all unblock.

## Phases

| Phase | What | Status |
| --- | --- | --- |
| 0 | Clone `mail-app`, rebrand to AOS Mail | ✅ done |
| 1a | Tauri scaffolding (Rust shell, sidecar skeleton, bridge stub) | ✅ done |
| 1b-i | First lift: `network` end-to-end + wire protocol with notifications | ✅ done |
| 1b-ii | Sidecar DB infrastructure (better-sqlite3, schema, opener) | ✅ done |
| 1b-iii | Lift remaining 30+ namespaces | 🟡 in progress (3 / 33 lifted) |
| 1c | Rolls into 1b-iii — each lift swaps its stub | 🟡 in progress |
| 1d | Cut Electron deps; `npm run tauri:dev` is the only dev path | pending |
| 2 | IMAP provider behind a `MailProvider` interface | pending |
| 3 | Native Mac polish (vibrancy, menus, keys, dock badge) | pending |
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
- [ ] OAuth flow works inside Tauri
- [ ] Auto-update works via `tauri-plugin-updater`
- [ ] Native menu bar reproduces the existing keyboard shortcuts
- [ ] Vibrancy + traffic-light positioning render correctly in light + dark mode
- [ ] Production sidecar packaging (Node SEA / @yao-pkg/pkg) replaces the dev-only inlined bash stub

After cutover, delete: `electron-vite.config.ts`, `src/main/`, `src/preload/`, and `electron`/`electron-builder`/`electron-updater`/`electron-vite` from `package.json`.

## Production note: sidecar packaging

The current sidecar binary is a **bash stub** that inlines the bundled CommonJS, writes it to a tmp file, sets `NODE_PATH` to a hardcoded absolute path of `sidecar/node_modules`, and execs `node`. **This is dev-mode only** — `sidecar/node_modules` won't ship in a packaged build.

Production migration plan: graduate to **Node SEA** (Node 20+ Single Executable Application) or **@yao-pkg/pkg**. Both can embed the runtime + bundle + native modules into one binary. Outstanding work:
- Choose between SEA (simpler, official) and pkg (battle-tested, easier native module bundling)
- Update `package-sidecar.mjs` to produce that artifact
- Test on macOS-arm64 + macOS-x64 (Tauri builds both)

This is its own piece of Phase 1d.
