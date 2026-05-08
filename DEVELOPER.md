# AOS Mail — Developer Guide

This is the technical companion to [README.md](README.md). README is for users; this is for the people building, hacking on, and shipping AOS Mail.

For Claude / AI-agent collaboration patterns specific to this codebase, see [CLAUDE.md](CLAUDE.md).

---

## Table of contents

- [Architecture](#architecture)
- [Delta from upstream Exo](#delta-from-upstream-exo)
- [Build from source](#build-from-source)
- [Commands](#commands)
- [Configuration paths](#configuration-paths)
- [The renderer ↔ sidecar contract](#the-renderer--sidecar-contract)
- [Testing](#testing)
- [Release pipeline](#release-pipeline-sign-notarize-publish)
- [Updater key management](#updater-key-management)
- [Contributing](#contributing)

---

## Architecture

```
+-----------------------------------------------+
|  Tauri 2 shell (Rust)                         |
|   • native window, vibrancy, traffic lights   |
|   • native menu bar, Keychain, notifications  |
|   • signed + notarized, hardened runtime      |
|   • spawns + supervises Node sidecar          |
+----------------+------------------------------+
                 | NDJSON JSON-RPC over stdio
+----------------v------------------------------+
|  Node sidecar (TypeScript)                    |
|   • gmail / imap / anthropic / openrouter     |
|   • agents/* (coordinator, worker, audit)     |
|   • SQLite + FTS5 at                          |
|     ~/Library/Application Support/AOS Mail/   |
|   • better-sqlite3 (external, NODE_PATH)      |
+----------------+------------------------------+
                 | Tauri events (server-sent)
+----------------v------------------------------+
|  React renderer (TypeScript, Vite)            |
|   • Tailwind, Zustand, Tiptap, react-query    |
|   • typed bridge (WindowApi from              |
|     SidecarMethods via mapped types)          |
+-----------------------------------------------+
```

### Why Node sidecar instead of pure Rust

The Anthropic SDK, MCP SDK, googleapis, better-sqlite3, imapflow, and Tiptap are all first-class in Node and would have been 6–10 weeks of porting to land in Rust. Tauri's [sidecar pattern](https://tauri.app/develop/sidecar/) gives us the supervised process model without rewriting the backend. The renderer talks to Tauri (Rust); Tauri forwards JSON-RPC to the sidecar over stdio; events come back the other way as Tauri events.

### Process model

```
┌─ Tauri shell (aos-mail) ─────────────────────────┐
│   stdin  ◄──── renderer requests via Rust IPC    │
│   stdout ────► route by id to pending request    │
│                or emit as Tauri event            │
│   stderr ────► tauri-plugin-shell debug log      │
│                                                  │
│   Spawns: aos-mail-sidecar (bash stub →          │
│           extracts bundled .cjs → execs node)    │
└──────────────────────────────────────────────────┘
```

The sidecar binary at `src-tauri/binaries/aos-mail-sidecar-<triple>` is a self-extracting bash script (see `sidecar/scripts/package-sidecar.mjs`) that drops the bundled JS into a tempfile and execs `node` against it. `NODE_PATH` is baked in to point at `sidecar/node_modules` so the externalised `better-sqlite3` `.node` binary resolves at runtime. Production should graduate to Node SEA or `@yao-pkg/pkg`.

---

## Delta from upstream Exo

The full breakdown of what AOS Mail changes vs upstream Exo:

### Shell — full rewrite (Electron → Tauri 2 + Node sidecar)

- **Tauri 2 Rust shell** — native window with `NSVisualEffectView` vibrancy (sidebar + headerView materials), traffic-light positioning, hardened runtime, native menu bar built via Tauri's `Menu` API, native notifications, dock badge updates from unread count.
- **Node sidecar** — the entire main process logic (Gmail client, IMAP, agents, SQLite, draft pipeline) lifted into a long-running Node process the Rust shell supervises. NDJSON JSON-RPC over stdio with the contract typed end-to-end.
- **Keychain integration** via Rust `keyring` crate.
- **Auto-updater** wired to GitHub Releases via `tauri-plugin-updater` with minisign-signed manifests.
- **Bundle size** dropped from Electron's ~80 MB+ to a ~9 MB DMG / ~43 MB unpacked `.app`.

### Multi-inbox — IMAP/SMTP added (Gmail-only upstream)

- IMAP via [`imapflow`](https://github.com/postalsys/imapflow) (active maintenance, async/await, IDLE for push), SMTP via [`nodemailer`](https://nodemailer.com), RFC 822 parsing through [`mailparser`](https://github.com/nodemailer/mailparser).
- **Provider abstraction** (`MailProvider` interface in `sidecar/src/services/providers/`) with id-prefix dispatch (`gmail:`, `imap:`, `sent:`).
- **Onboarding wizard** with presets for iCloud, Fastmail, Outlook, Yahoo, and custom IMAP.
- IMAP server config in JSON, passwords in Keychain, OAuth tokens scoped per account.
- Schema migrations: composite `(account_id, thread_id)` indexes, cascade deletes on dependent tables.

### Agent — extended on Exo's foundation

The triage / draft / style-profiler core is upstream Exo. AOS Mail adds:

- **Morning Briefing** — wake-up panel summarizing overnight mail.
- **Smart-action key** — single-keystroke shortcut runs the agent's recommendation, with full undo.
- **Awaiting-reply nudges** — flags threads waiting on a response, drafts a follow-up, integrates with snooze.
- **Learned rules** — pattern detection ("you always archive these newsletters"), proposed explicitly, never silent.
- **Permission tray + audit visibility** — every queued action visible in a top-right tray; full audit log filterable in Settings.
- **OpenRouter** support — same agent loop runs against any OpenAI-compatible model (DeepSeek, Llama, etc.).

### Calendar — V1 UI added

Sync was upstream. UI is ours: day view, list of upcoming events, agent-driven "suggest a time" / "create event from thread" via MCP tools.

### Extensions — V1 system

Bundled extensions are inlined into the JS bundle at build time (no runtime filesystem scanning, packaged-app-friendly). Used today by the calendar extension; designed to grow.

### Architectural cleanup

- **Typed renderer↔sidecar bridge** — `WindowApi` generated from `SidecarMethods` via mapped/conditional types. No `any` casts at the boundary.
- **Composite `(account_id, thread_id)` indexes** — bench shows ~2.66× speedup on the awaiting-reply argmax subquery (18.5 ms → 6.9 ms avg).
- **Unified toast queue** — one `Toast` component + Zustand queue replaced four overlapping legacy surfaces (`UndoActionToast`, `SmartActionToast`, `TriageStatusToast`, `UndoSendToast`). 1150 lines net deleted, single Cmd+Z handler.
- **One `resolveModelFor()`** consolidated eight per-feature model-resolver helpers.
- **233 sidecar tests** including 6 cross-feature behavior tests.
- **Persistent sidecar log** at `~/Library/Application Support/AOS Mail/sidecar.log` plus global `unhandledRejection` / `uncaughtException` traps.

---

## Build from source

### Prerequisites

- macOS 13+ on Apple Silicon (Intel + Linux + Windows builds are roadmap V2)
- Node 20+
- Rust (install via [rustup](https://rustup.rs))
- Xcode Command Line Tools (`xcode-select --install`)

### Quick start

```bash
git clone https://github.com/mrdulasolutions/AOS-Mail
cd AOS-Mail
npm install
npm run dev          # tauri dev — opens app, watches renderer & sidecar
```

Optional `.env` for build-time defaults:

```
MAIN_VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
MAIN_VITE_GOOGLE_CLIENT_SECRET=your-client-secret
ANTHROPIC_API_KEY=sk-ant-...
```

If you skip `.env`, you'll be prompted to paste credentials into Settings on first launch.

### Production build (unsigned, for local testing)

```bash
npm run build
```

Produces unsigned `.app` and `.dmg` in `src-tauri/target/release/bundle/`. macOS Gatekeeper will block opening these on other machines — see the [release pipeline](#release-pipeline-sign-notarize-publish) section below for the signed flow.

---

## Commands

```bash
# Development
npm run dev                # Tauri dev (renderer + sidecar + native shell)
npm run dev:renderer       # Vite dev server only
npm run build:sidecar      # Bundle + package sidecar binary
npm run build:renderer     # Vite production build
npm run build              # Full production build (sidecar + renderer + tauri)

# Quality gates
npm run typecheck          # Renderer typecheck (tsc --noEmit)
npm run typecheck:sidecar  # Sidecar typecheck
npm run lint               # ESLint on src/ + sidecar/src/
npm run lint:fix           # ESLint with autofix
npm run format             # Prettier write
npm run format:check       # Prettier check (no write)

# Tests
npm run test:sidecar       # Sidecar tests (233/233 passing as of v0.1.0)
npm run test:e2e           # Playwright end-to-end
npm run test:problematic   # Excluded flaky/incomplete tests
npm run test:bench         # Benchmark project

# Misc
npm run eval               # Email-analyzer eval harness (see docs/EVALS.md)
```

---

## Configuration paths

All app data lives under `~/Library/Application Support/AOS Mail/` on macOS:

| Path | Contents |
|---|---|
| `data/aos-mail.db` | SQLite (emails, threads, accounts, drafts, learned rules, audit log, FTS5 index) |
| `credentials.json` | Gmail OAuth client config (per-install) |
| `tokens-<account>.json` | OAuth refresh tokens (also mirrored to Keychain) |
| `imap-creds-<account>.json` | IMAP server config (passwords held in Keychain, never in this file) |
| `preferences.json` | Per-user UI prefs and feature toggles |
| `splits.json`, `snippets.json` | User-defined splits and snippets |
| `sidecar.log` | Append-only sidecar diagnostic log (handy for support tickets) |

> **Important:** Reading from this directory is fine for diagnostics, but **never write to or modify files in this production directory without explicitly asking the user** — this is real user data shared across packaged-app installs. Dev runs use `.dev-data/` instead (set `AOS_DATA_DIR` to override).

Environment variables that change behavior:

| Variable | Effect |
|---|---|
| `AOS_TEST_MODE=true` | Use mock data; database becomes `aos-mail-demo.db` |
| `AOS_DEMO_MODE=true` | Demo data without real API calls |
| `AOS_LOG_LEVEL=debug` | Enable debug-level sidecar logs |
| `AOS_DATA_DIR=...` | Override the data directory location (dev / tests) |
| `ANTHROPIC_API_KEY` | Default Anthropic key (otherwise prompts in Settings) |

---

## The renderer ↔ sidecar contract

The single source of truth is **`src/shared/sidecar-contract.ts`** — every IPC method's name, params, and result type. From this:

- `src/shared/window-api.ts` derives the `WindowApi` interface used by the renderer (`window.api.<namespace>.<method>`) via mapped/conditional types.
- `sidecar/src/rpc.ts`'s `registerMethod<K extends SidecarMethodName>` overload binds handler signatures to the contract.
- `src/renderer/lib/bridge.ts`'s `bridge.call<K>(method, params)` is typed end-to-end.

**Adding a new IPC method:**

1. Add an entry to `SidecarMethods` in `src/shared/sidecar-contract.ts` (params + result types).
2. The renderer's `bridge.call` and `window.api.<ns>.<method>` immediately type-check.
3. In the sidecar, call `registerMethod("<namespace>.<method>", async (params) => { ... })` — TypeScript will require the handler matches the contract.
4. If the renderer reads the call via `window.api.<ns>.<method>(...)` (vs `bridge.call(...)`), make sure the namespace's `WindowApi` mapping in `src/renderer/lib/electron-shim.ts` includes a passthrough.

Read-only methods can opt into automatic retry by adding their name (or a glob like `myns.list*`) to `RETRYABLE_METHOD_PATTERNS` in `src/renderer/lib/bridge.ts`.

---

## Testing

The test pyramid:

- **Sidecar unit + integration tests** (`tests/sidecar/`) — node:test runner, spawns a real sidecar process per test file via `tests/sidecar/_helpers/sidecar-process.ts`. Currently **233 tests passing**.
- **Cross-feature behavior tests** (`tests/sidecar/integration/`) — drive the sidecar through realistic flows (smart-action archive flow, awaiting-reply snooze flow, thread-summary cache bust, compose-send partial failure, Gmail history watermark, folder switch + load-more).
- **Playwright E2E** (`tests/e2e/`) — full app under playwright with `npm run test:e2e`.
- **Email-analyzer eval harness** (`tests/evals/`) — fixture-based regression test for the agent's analysis quality, run with `npm run eval`. Update baseline with `npm run eval -- --update-baseline`.

Pre-PR gate:

```bash
npm run lint && \
npm run typecheck && \
npm run typecheck:sidecar && \
npm run test:sidecar
```

---

## Release pipeline (sign, notarize, publish)

This is what you run to ship a new version to GitHub Releases.

### Prerequisites (one-time, per machine)

1. **Apple Developer Program** membership ($99/yr) under the Apple ID used for signing.
2. **Developer ID Application certificate** installed in the login Keychain. Verify with:
   ```bash
   security find-identity -v -p codesigning
   ```
   Should list `Developer ID Application: <Name> (<Team ID>)`.
3. **App-specific password** for notarization, generated at <https://account.apple.com> → Sign-In and Security → App-Specific Passwords.
4. **Tauri updater key** at `~/.tauri/aos-mail-v1.key`. The matching pubkey is embedded in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
5. `gh` CLI authenticated against `mrdulasolutions/AOS-Mail`.

### Cutting a release

```bash
# 1. Bump version in three places
#    - package.json
#    - sidecar/package.json
#    - src-tauri/tauri.conf.json
#    - src-tauri/Cargo.toml
# Commit the bump.
git commit -am "chore(release): bump to v0.1.1"

# 2. Build (signed + notarized + updater-signed)
APPLE_ID=mattdula@gmail.com \
APPLE_PASSWORD=<app-specific-password> \
APPLE_TEAM_ID=PPY9K2BYJH \
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/aos-mail-v1.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<your-key-password> \
npm run build

# 3. Notarize the DMG separately (Tauri only notarizes the .app's zip)
xcrun notarytool submit \
  "src-tauri/target/release/bundle/dmg/AOS Mail_<version>_aarch64.dmg" \
  --apple-id $APPLE_ID --password $APPLE_PASSWORD --team-id $APPLE_TEAM_ID --wait

xcrun stapler staple \
  "src-tauri/target/release/bundle/dmg/AOS Mail_<version>_aarch64.dmg"

# 4. Compress the .app for the updater
cd src-tauri/target/release/bundle/macos
tar -czf AOS_Mail.app.tar.gz "AOS Mail.app"

# 5. Sign the .app.tar.gz with the updater key
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/aos-mail-v1.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<your-key-password> \
npx @tauri-apps/cli signer sign AOS_Mail.app.tar.gz

# 6. Generate latest.json (see scripts/release-latest-json.sh or do it manually
#    with the .sig contents)

# 7. Tag and push
git tag v0.1.1
git push origin main v0.1.1

# 8. Publish the release
gh release create v0.1.1 \
  --title "v0.1.1 — <one-line summary>" \
  --notes-file release-notes.md \
  /path/to/AOS_Mail_<version>_aarch64.dmg \
  /path/to/AOS_Mail.app.tar.gz \
  /path/to/AOS_Mail.app.tar.gz.sig \
  /path/to/latest.json
```

### Verifying a signed build

```bash
# Gatekeeper assessment
spctl -a -vv "src-tauri/target/release/bundle/macos/AOS Mail.app"
# Should print: accepted / source=Notarized Developer ID

# Stapler ticket validation
xcrun stapler validate "src-tauri/target/release/bundle/macos/AOS Mail.app"
xcrun stapler validate "src-tauri/target/release/bundle/dmg/AOS Mail_<version>_aarch64.dmg"
# Both should print: The validate action worked!

# Inspect signing details
codesign -dvv "src-tauri/target/release/bundle/macos/AOS Mail.app"
# Should show:
#   Authority=Developer ID Application: <Name> (<Team ID>)
#   Authority=Developer ID Certification Authority
#   Authority=Apple Root CA
#   TeamIdentifier=<Team ID>
```

### `latest.json` format

```json
{
  "version": "0.1.1",
  "notes": "Brief release summary",
  "pub_date": "2026-05-08T20:27:58Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of AOS_Mail.app.tar.gz.sig>",
      "url": "https://github.com/mrdulasolutions/AOS-Mail/releases/download/v0.1.1/AOS_Mail.app.tar.gz"
    }
  }
}
```

The Tauri updater is configured (in `src-tauri/tauri.conf.json`) to fetch this from `https://github.com/mrdulasolutions/AOS-Mail/releases/latest/download/latest.json`. Existing installs check it on startup and at intervals; if `version` is greater than the installed version and the signature validates, the user is offered the update.

---

## Updater key management

The Tauri updater uses a minisign keypair. Public key is embedded in `src-tauri/tauri.conf.json`; private key lives outside the repo at `~/.tauri/aos-mail-v1.key` (chmod 600).

**If the private key or password is lost**, you cannot sign update manifests for any version that has the *current* pubkey embedded. Recovery:

```bash
# 1. Generate a new key
CI=true npx @tauri-apps/cli signer generate \
  --password <new-password> \
  --write-keys ~/.tauri/aos-mail-v2.key \
  --force

# 2. Copy the new public key out of ~/.tauri/aos-mail-v2.key.pub
#    Update src-tauri/tauri.conf.json plugins.updater.pubkey

# 3. Bump version, rebuild, ship.
#    Existing installs (with the OLD pubkey embedded) will reject signed
#    updates from the new key — they'll have to download the new DMG manually
#    once. From there forward, auto-updates resume working.
```

Plan ahead: back the private key + password up to a password manager before you forget.

---

## Contributing

PRs welcome. Before opening one:

```bash
npm run lint
npm run typecheck
npm run typecheck:sidecar
npm run test:sidecar
```

All four must pass. CI enforces them on every PR.

For larger changes (migrations, multi-file refactors, architectural pivots), please open a discussion or draft PR first so we can talk shape before you sink time. Code-style conventions, naming, and review guidelines are in [CLAUDE.md](CLAUDE.md).

### Reporting bugs

If something breaks:

1. Check `~/Library/Application Support/AOS Mail/sidecar.log` for stack traces.
2. Open an issue at <https://github.com/mrdulasolutions/AOS-Mail/issues> with:
   - Your macOS version
   - AOS Mail version (Settings → About, or `grep version package.json`)
   - The relevant slice of `sidecar.log`
   - Steps to reproduce
3. Don't paste OAuth tokens or API keys — the logger redacts those automatically but double-check before posting.

---

## Roadmap

V2 backlog lives at [docs/ROADMAP-V2.md](docs/ROADMAP-V2.md). Highlights: voice-to-inbox, thread-derailment warnings, knowledge graph, Microsoft Graph / JMAP adapters, cross-app MCP (Calendar / ClickUp / Slack / HubSpot), Linux + Windows builds, iOS companion.
