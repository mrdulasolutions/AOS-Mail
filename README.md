<div align="center">

### AOS Mail — Agent Operated System for Mail

[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-orange.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-13%2B-blue?logo=apple&logoColor=white)](https://github.com/mrdulasolutions/AOS-Mail/releases)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)

<br />

**A native Mac email client where Claude does the work, and you decide what ships.**

</div>

---

## Why AOS Mail

Most email clients treat AI as a sidebar feature: a "Generate reply" button bolted onto an inbox that still expects you to do all the triage, all the sorting, all the follow-up tracking. We wanted something that flips the relationship — an inbox where an agent has already read everything, decided what matters, drafted the responses, and surfaces a tight queue of decisions for you to approve.

AOS Mail is built around three convictions:

1. **A real Mac app, not a re-skinned web view.** Vibrancy, native menu bar, Keychain-backed secrets, hardened runtime, signed + notarized DMG, native notifications, dock badge — all of it. The shell is Tauri 2 + a Rust supervisor, not Electron.
2. **Multiple inboxes, one brain.** Gmail and IMAP/SMTP are first-class peers. iCloud, Fastmail, Outlook, Yahoo, custom domains — they all work the same. The agent treats them as one queue, but per-account state (splits, snooze, learned rules, drafts) stays cleanly isolated.
3. **The agent is in the loop, not in charge.** Every action is visible in a permission tray. Drafts wait for your approval. Learned rules ("always archive these newsletters") propose themselves; you confirm or reject. Nothing silent. A complete audit log is one click away.

## What this is, and what it isn't

AOS Mail is a **downstream fork of [Ankit Gupta's Exo](https://github.com/ankitvgupta/exo)** — *"Claude Code for your Inbox"* — and we want to be straightforward about that. Exo gave us the agent infrastructure, the Gmail integration, the draft pipeline, the style profiler, and the overall shape of how an agentic email client *could* work. That work is excellent, and it's the foundation we're building on.

What AOS Mail adds, on top of that foundation, is itemized below. Where the upstream did the heavy lift, we credit it; where we extended or rewrote, we say so.

## Delta from upstream Exo

These are the meaningful divergences. Everything not listed is approximately upstream-as-shipped or a small refinement.

### Shell — full rewrite (Electron → Tauri 2 + Node sidecar)

This was the largest piece of work. Exo ships as Electron + electron-vite. We replaced that with:

- **Tauri 2** Rust shell — native window with vibrancy (`NSVisualEffectView`, sidebar + headerView materials), traffic-light positioning, hardened runtime, native menu bar built via Tauri's `Menu` API, native notifications, dock badge updates from unread count.
- **Node sidecar** — the entire main process logic (Gmail client, IMAP, agents, SQLite, draft pipeline) is lifted into a long-running Node process the Rust shell supervises. Communication is **NDJSON JSON-RPC over stdio**, with the contract typed end-to-end (mapped types map `SidecarMethods` → `WindowApi` so renaming a method is a typecheck error at every call site).
- **Keychain integration** via the Rust `keyring` crate — no more passwords or OAuth refresh tokens in plaintext on disk. The renderer talks to the keychain through dedicated Tauri commands.
- **Auto-updater** wired to GitHub Releases via `tauri-plugin-updater` with minisign-signed update manifests.
- **Bundle size** dropped from Electron's ~80 MB+ to a ~9 MB DMG (43 MB unpacked `.app`), with a self-extracting bash stub packaging the Node sidecar so we don't ship a second runtime.

### Multi-inbox — IMAP/SMTP added (Gmail was upstream)

Exo is Gmail-only. AOS Mail adds:

- **IMAP** via `imapflow` (active maintenance, async/await, IDLE for push) and **SMTP** via `nodemailer`. RFC 822 parsing through `mailparser`.
- **Provider abstraction** (`MailProvider` interface) with id-prefix dispatch (`gmail:`, `imap:`, `sent:`) so the existing email-analyzer, draft-pipeline, and agent-coordinator stay provider-agnostic.
- **Onboarding wizard** with presets for iCloud, Fastmail, Outlook, Yahoo, and a custom IMAP path with sane defaults.
- **Per-account credential storage** — IMAP server config in JSON, passwords in Keychain, OAuth tokens scoped per account.
- **Schema migrations** (composite `(account_id, thread_id)` indexes; cascade deletes on dependent tables) sized for the multi-inbox query patterns.

### Agent — new features layered on Exo's foundation

The triage / draft / style-profiler core is upstream Exo. AOS Mail adds:

- **Morning Briefing** — Tier-1 wake-up panel that summarizes overnight mail, surfaces decisions, and proposes a queue of one-tap actions on first open of the day.
- **Smart-action key** — single-keystroke shortcut that runs the agent's recommendation for the current thread (archive / reply / snooze / delegate), with full undo.
- **Awaiting-reply nudges** — flags threads where you sent something and haven't gotten a response, drafts a one-line follow-up, integrates cleanly with snooze.
- **Learned rules** — agent watches for patterns ("you always archive these newsletters") and proposes them as explicit rules. Confirmed by the user, never silent.
- **Permission tray + audit visibility** — every queued agent action is visible in a top-right tray; the audit log is exposed in Settings, last 200 actions, filterable.
- **OpenRouter** support as a Claude alternative — same agent loop runs against any OpenAI-compatible model (DeepSeek, Llama, etc.) for users who want a free / open-weight path.

### Calendar — V1 UI (sync was upstream)

Exo had Google Calendar sync working but no UI. AOS Mail ships a day view, list of upcoming events, and an MCP-backed "suggest a time" / "create event from thread" path the agent uses when the user asks it to schedule something.

### Extensions — V1 system

A small extension system layered on the sidecar — bundled extensions ship inlined into the JS bundle at build time (no runtime filesystem scanning, packaged-app-friendly). Used today by the calendar extension; designed to grow.

### Architectural cleanup

A handful of post-mortem items we closed during the public-release prep:

- **Typed renderer↔sidecar bridge** — `WindowApi` is generated from `SidecarMethods` via mapped/conditional types; no `any` casts at the boundary.
- **Composite `(account_id, thread_id)` indexes** — bench shows ~2.66× speedup on the awaiting-reply argmax subquery (18.5 ms → 6.9 ms avg).
- **Unified toast queue** — one `Toast` component + Zustand queue replaced four overlapping legacy surfaces (`UndoActionToast`, `SmartActionToast`, `TriageStatusToast`, `UndoSendToast`). Net: 1150 lines deleted, single Cmd+Z handler.
- **One `resolveModelFor()`** consolidated eight per-feature model-resolver helpers.
- **233 sidecar tests** including 6 cross-feature behavior tests (smart-action archive flow, awaiting-reply snooze flow, thread-summary cache bust, compose-send partial failure, Gmail history watermark, folder switch + load-more).
- **Persistent sidecar log** at `~/Library/Application Support/AOS Mail/sidecar.log` plus global `unhandledRejection` / `uncaughtException` traps so production crashes leave a stack trace, not silence.

## Status

V1 is shipped end-to-end on macOS. `npm run build` produces a signed + notarized DMG. Auto-updates land via GitHub Releases. iCloud, Fastmail, Outlook (basic), Yahoo, custom IMAP, and Gmail all work as account types.

V2 backlog (`docs/ROADMAP-V2.md`): voice-to-inbox, thread-derailment warnings, knowledge graph, Microsoft Graph / JMAP adapters, cross-app MCP (Calendar / ClickUp / Slack / HubSpot), Linux + Windows builds, iOS companion.

## Architecture

```
+---------------------------------------------------+
|  Tauri 2 shell (Rust)                             |
|   • native window, vibrancy, traffic lights       |
|   • native menu bar, Keychain, notifications      |
|   • signed + notarized, hardened runtime          |
|   • spawns + supervises Node sidecar              |
+----------------+----------------------------------+
                 | NDJSON JSON-RPC over stdio
+----------------v----------------------------------+
|  Node sidecar (TypeScript)                        |
|   • gmail / imap / anthropic / openrouter         |
|   • agents/* (coordinator, worker, audit)         |
|   • SQLite + FTS5 at                              |
|     ~/Library/Application Support/AOS Mail/       |
|   • better-sqlite3 (better-sqlite3 external,      |
|     loaded via NODE_PATH at runtime)              |
+----------------+----------------------------------+
                 | Tauri events (server-sent)
+----------------v----------------------------------+
|  React renderer (TypeScript, Vite)                |
|   • Tailwind, Zustand, Tiptap, react-query        |
|   • typed bridge (WindowApi from SidecarMethods)  |
+---------------------------------------------------+
```

See [CLAUDE.md](CLAUDE.md) for full architecture details, IPC inventory, data flows, and codebase conventions.

## Install

### Prebuilt DMG (recommended)

Once we publish to GitHub Releases, grab the latest signed DMG: <https://github.com/mrdulasolutions/AOS-Mail/releases>. Until then, build from source:

### Build from source

```bash
git clone https://github.com/mrdulasolutions/AOS-Mail
cd AOS-Mail
npm install
npm run dev          # tauri dev — opens the app, watches renderer & sidecar
```

You can paste your Gmail OAuth client and Anthropic / OpenRouter key into Settings on first launch, or pre-bake them into a `.env` (optional, for development convenience):

```
MAIN_VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
MAIN_VITE_GOOGLE_CLIENT_SECRET=your-client-secret
ANTHROPIC_API_KEY=sk-ant-...
```

Production build (signed + notarized DMG, requires Apple Developer cert):

```bash
APPLE_ID=you@example.com \
APPLE_PASSWORD=app-specific-password \
APPLE_TEAM_ID=YOUR_TEAM_ID \
npm run build
```

Output: `src-tauri/target/release/bundle/{macos,dmg}/`.

## Commands

```bash
npm run dev                # Start Tauri dev (renderer + sidecar + native shell)
npm run build              # Full production build (.app + .dmg)
npm run typecheck          # Renderer typecheck (tsc --noEmit)
npm run typecheck:sidecar  # Sidecar typecheck
npm run test:sidecar       # Sidecar tests (233/233 passing)
npm run test:e2e           # Playwright end-to-end tests
npm run lint               # ESLint
npm run format             # Prettier write
npm run eval               # Email-analyzer eval harness (see docs/EVALS.md)
```

## Configuration

All app data lives under `~/Library/Application Support/AOS Mail/` on macOS:

- `data/aos-mail.db` — SQLite (emails, threads, accounts, drafts, learned rules, audit log)
- `credentials.json` — Gmail OAuth client config (per-install)
- `tokens-<account>.json` — OAuth refresh tokens (one per Gmail account, also mirrored to Keychain)
- `imap-creds-<account>.json` — IMAP server config (passwords held in macOS Keychain, never in this file)
- `preferences.json` — per-user UI prefs and feature toggles
- `splits.json`, `snippets.json` — user splits and snippets
- `sidecar.log` — append-only sidecar diagnostic log

## Contributing

PRs welcome. Before opening one, please run:

```bash
npm run lint
npx tsc --noEmit
npm --prefix sidecar run typecheck
npm run test:sidecar
```

See [CLAUDE.md](CLAUDE.md) for codebase conventions, testing patterns, and the IPC contract.

## Acknowledgements

- **[Exo](https://github.com/ankitvgupta/exo)** by Ankit Gupta — upstream of this fork; agent loop, Gmail integration, draft pipeline, style profiler.
- **[Anthropic Claude](https://www.anthropic.com/claude)** — the model the agent runs on.
- **[Tauri 2](https://tauri.app/)** — the native shell.
- The maintainers of `imapflow`, `nodemailer`, `mailparser`, `better-sqlite3`, `googleapis`, `Tiptap`, `Zustand`, and the rest of the stack listed in [`NOTICE`](NOTICE).

## License

[BUSL-1.1](LICENSE), with identical Parameters to upstream Exo and explicit attribution to the upstream authors. Becomes Apache 2.0 on the Change Date (2033-01-01) or four years after this fork's first publicly available distribution, whichever comes first. Any commercial use requires a separate license — see the LICENSE for the full grant.
