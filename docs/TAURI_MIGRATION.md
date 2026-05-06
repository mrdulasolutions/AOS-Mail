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
               │ (JSON-RPC 2.0)
┌──────────────▼───────────────────────────────┐
│  Node sidecar (TypeScript)                   │
│   - Lifted from src/main/                    │
│   - Gmail + IMAP + Claude agents + SQLite    │
│   - DB: ~/Library/Application Support/       │
│         AOS Mail/data/aos-mail.db            │
└──────────────┬───────────────────────────────┘
               │ Tauri events (via the shell)
┌──────────────▼───────────────────────────────┐
│  React renderer (TypeScript, Vite)           │
│   - Tailwind, Zustand, Tiptap                │
│   - bridge.ts: Tauri-aware invoke shim       │
└──────────────────────────────────────────────┘
```

## Wire format

The Rust shell talks to the sidecar over stdin/stdout using newline-delimited JSON-RPC 2.0:

```
// renderer  -> tauri:
invoke("sidecar_request", { method: "mail.list", params: { folderId: "INBOX" } })

// tauri    -> sidecar (stdin):
{"jsonrpc":"2.0","id":7,"method":"mail.list","params":{"folderId":"INBOX"}}\n

// sidecar  -> tauri (stdout):
{"jsonrpc":"2.0","id":7,"result":[...]}\n

// tauri    -> renderer:
the result, unwrapped.
```

Sidecar files:
- `sidecar/src/index.ts` — stdio loop
- `sidecar/src/rpc.ts` — JSON-RPC dispatcher
- Future: `sidecar/src/methods/*.ts` — one file per service area, each calling `registerMethod(...)`

## Migration phases

| Phase | What | Status |
| --- | --- | --- |
| 0 | Clone `mail-app`, rebrand to AOS Mail | done |
| 1a | Tauri scaffolding (Rust shell, sidecar skeleton, bridge stub) | in progress |
| 1b | Lift `src/main/services/*` into `sidecar/src/methods/*` | pending |
| 1c | Replace `src/preload/index.ts` calls with `bridge.call()` | pending |
| 1d | Cut Electron deps; `npm run tauri dev` is the only dev path | pending |
| 2 | Add IMAP provider behind a `MailProvider` interface | pending |
| 3 | Native Mac polish (vibrancy, menus, keyboard, dock badge) | pending |
| 4 | Inbox agent V1 surfaces (triage, summary, draft, activity tray) | pending |
| 5 | Sign, notarize, ship via GitHub Releases + Tauri updater | pending |

## During the migration

Both shells coexist temporarily:
- `npm run dev` — still launches Electron (`electron-vite`)
- `npm run tauri:dev` — launches the Tauri shell + sidecar + Vite renderer
- `npm run build:electron` — produces an Electron build (legacy)
- `npm run build` — produces the Tauri build

The renderer source under `src/renderer/` is shared. Components that today use `window.api.*` keep working under Electron; new code should call `bridge.call()` from `src/renderer/lib/bridge.ts`. As services move into the sidecar, the corresponding components are rewritten to use the bridge.

## Phase 1d cutover checklist

When we delete Electron, all of these must be true:
- [ ] Every `window.api.*` call in the renderer is replaced or shimmed by `bridge.call()`
- [ ] Every IPC handler under `src/main/ipc/*` has an equivalent sidecar method
- [ ] OAuth flow works inside Tauri (see `tauri-plugin-oauth` or hand-rolled local-server callback)
- [ ] Auto-update works via `tauri-plugin-updater`
- [ ] Native menu bar reproduces the existing keyboard shortcuts
- [ ] Vibrancy + traffic-light positioning render correctly in light + dark mode

After cutover, delete: `electron-vite.config.ts`, `src/main/`, `src/preload/`, and `electron`/`electron-builder`/`electron-updater`/`electron-vite` from `package.json`.
