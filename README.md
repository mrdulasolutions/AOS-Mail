<div align="center">

### AOS Mail — Agent Operated System for Mail

[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-orange.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-13%2B-blue?logo=apple&logoColor=white)](https://github.com/mrdulasolutions/AOS-Mail/releases)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)

<br />

**AOS Mail** is a native-feeling, multi-inbox, Claude-powered Mac email client. <br />
Built with Tauri 2, a Node sidecar, React, TypeScript, and Tailwind CSS.

<br />

The vision: the **beauty of a native Mac app**, the **horsepower of a fully agentic email worker/partner**, and the ability to **handle multiple inboxes** at once.

<br />

</div>

# AOS Mail

AOS Mail treats AI as a first-class citizen — not a bolted-on feature. Every email gets analyzed, prioritized, and optionally drafted before you even open it. The goal is zero cognitive load: open your inbox and everything is already handled or ready to send.

> **Fork notice.** AOS Mail is a downstream fork of [`ankitvgupta/exo`](https://github.com/ankitvgupta/exo) — *"Claude Code for your Inbox."* — by Ankit Gupta. Substantial portions of the agent infrastructure, Gmail integration, draft pipeline, and overall product shape come from that work and remain (c) 2025-2026 Ankit Gupta. AOS Mail extends Exo with a Tauri 2 + Node-sidecar shell, IMAP/SMTP support, multi-inbox, native Mac chrome, calendar, extensions, and more agent tooling. See [LICENSE](LICENSE) for the full attribution and BUSL-1.1 terms.

## Status

V1 is shipped end-to-end on macOS:

- **Shell** — Tauri 2 + Node sidecar (Rust + TypeScript). NDJSON JSON-RPC bridge, native window chrome, Keychain-backed secrets, Tauri auto-updater, sub-50 MB packaged app.
- **Inboxes** — Gmail (OAuth + History API) and IMAP/SMTP (imapflow + nodemailer) both shipped. iCloud, Fastmail, Outlook, Yahoo, and custom IMAP servers all supported.
- **Agent** — Triage, thread summary, draft-in-your-voice, awaiting-reply nudges, learned rules, morning briefing, sender lookup, archive-ready batch view.
- **UX** — j/k keyboard, smart-action key, command palette, undo-everything toast queue, split inbox, snooze with NL parsing, hybrid local FTS + remote search.

Phase 5 (signed/notarized DMG releases via GitHub Actions) is staged but waits on Apple Developer cert + GH secrets.

## Features

### Native Mac feel
- `NSVisualEffectView` vibrancy for the sidebar and toolbar
- Native menu bar with Mac-standard shortcuts (`⌘N`, `⌘\\`, `⌘K`, `⌘J`, …)
- Traffic-light positioning, frameless window, system fonts
- Dock badge for unread, native notifications, light/dark/auto theming

### Multi-inbox
- **Gmail** — OAuth + Gmail History API for incremental sync
- **IMAP / SMTP** — iCloud, Yahoo, Fastmail, Outlook, custom domains; IMAP IDLE for push, polling fallback
- Per-account isolation (splits, snooze, agent tasks scoped per account)
- Instant account switching — emails for all accounts stay in the local store

### Agentic inbox worker
- **Triage** — Claude analyzes every incoming email; assigns priority and a one-line summary
- **Thread summary** — 2-4 sentence summary + extracted action items on thread open, cached per `(thread_id, last_message_id)`
- **Draft in your voice** — replies generated from your sent-mail style profile, with a "why" panel for trust
- **Awaiting-reply nudges** — flags threads waiting on a response and proposes a one-line follow-up
- **Morning briefing** — opens with a digest of overnight mail, top decisions to make, and suggested actions
- **Smart-action key** — single-key shortcut runs the agent's recommendation for the current thread (archive / reply / snooze / delegate)
- **Learned rules** — agent picks up on your patterns over time (always archive X, always star Y) with explicit confirmation
- **Permission tray** — every agent action visible, confirmable, audited; nothing silently committed
- **Cmd+J agent palette** — natural-language commands on the current email
- **Persistent memories** — per-sender / per-topic context the agent reuses

### Inbox organization
- Split inbox (Priority / Other / custom splits)
- Snoozed view with natural-language time input
- Archive-ready batch view (one button to clear the inbox of low-priority items)
- Hybrid local FTS5 + remote search

### Composition
- Tiptap rich-text composer with formatting toolbar
- `@`/`+` mention autocomplete; CC/BCC with full contact-history autocomplete
- Multiple signatures, scheduled send, undo send, inline images, drag-and-drop attachments

### Keyboard-driven
- j/k navigation, e archive, # trash, s star, u unread, r/a/f reply/reply-all/forward
- Optional Gmail-standard bindings
- Cmd+K command palette, batch select with Cmd/Shift+click

### Calendar (sync + V1 day view shipped; richer UI coming)
- Day view with events from connected Google Calendars
- Suggest-time / quick-create from threads via the agent

## Architecture

```
+-----------------------------------------------+
|  Tauri 2 shell (Rust)                         |
|   - native window, vibrancy, traffic lights   |
|   - native menu bar, Keychain, notifications  |
|   - spawns + supervises Node sidecar          |
+----------------+------------------------------+
                 | NDJSON JSON-RPC over stdio
+----------------v------------------------------+
|  Node sidecar (TypeScript)                    |
|   - gmail / imap / anthropic / agents         |
|   - SQLite + FTS5 at                          |
|     ~/Library/Application Support/AOS Mail/   |
+----------------+------------------------------+
                 | Tauri events
+----------------v------------------------------+
|  React renderer (TypeScript, Vite)            |
|   - Tailwind, Zustand, Tiptap, react-query    |
+-----------------------------------------------+
```

See [CLAUDE.md](CLAUDE.md) for architecture details and data flows.

## Install

### Prebuilt (recommended)

Grab the latest signed DMG from [Releases](https://github.com/mrdulasolutions/AOS-Mail/releases) once Phase 5 ships. Until then, build from source.

### Build from source

```bash
git clone https://github.com/mrdulasolutions/AOS-Mail
cd AOS-Mail
npm install
npm run dev          # tauri dev — opens the app + watches renderer & sidecar
```

Optional `.env` (only needed if you want Gmail OAuth pre-baked rather than entering credentials in Settings on first launch):

```
MAIN_VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
MAIN_VITE_GOOGLE_CLIENT_SECRET=your-client-secret
ANTHROPIC_API_KEY=sk-ant-...        # optional; can also be set in Settings
```

If you skip these, you'll be prompted to paste your own Google OAuth credentials and Anthropic key the first time you launch — no `.env` required.

To produce a packaged `.app` + `.dmg`:

```bash
npm run build        # builds sidecar + renderer + tauri (release profile)
```

Output lands in `src-tauri/target/release/bundle/`.

## Commands

```bash
npm run dev                # Start Tauri dev (renderer + sidecar + native shell)
npm run build              # Full production build (.app + .dmg)
npm run typecheck          # Renderer typecheck (tsc --noEmit)
npm run typecheck:sidecar  # Sidecar typecheck
npm run test:sidecar       # Sidecar tests (currently 233/233 passing)
npm run test:e2e           # Playwright end-to-end tests
npm run lint               # ESLint on src/ + sidecar/src/
npm run format             # Prettier write
npm run eval               # Email-analyzer eval harness (see docs/EVALS.md)
```

## Configuration

All app data lives under `~/Library/Application Support/AOS Mail/` on macOS:

- `data/aos-mail.db` — SQLite (emails, threads, accounts, drafts, learned rules, …)
- `credentials.json` — Gmail OAuth client config (per-install)
- `tokens-<account>.json` — OAuth refresh tokens (one per Gmail account)
- `imap-creds-<account>.json` — IMAP server config (passwords are kept in the macOS Keychain, not in this file)
- `preferences.json` — per-user UI prefs and feature toggles
- `splits.json`, `snippets.json` — user-defined splits and snippets
- `sidecar.log` — append-only sidecar diagnostic log (handy for support)

## Contributing

PRs welcome. Please run `npm run lint`, `npx tsc --noEmit`, and `npm run test:sidecar` before opening one. See [CLAUDE.md](CLAUDE.md) for codebase conventions.

## Acknowledgements

- **[Exo Email Client](https://github.com/ankitvgupta/exo)** by Ankit Gupta — the upstream project AOS Mail is forked from. Most of the agent loop, Gmail sync, draft pipeline, style profiler, and overall product shape are theirs.
- **[Anthropic Claude](https://www.anthropic.com/claude)** — the model powering the agent.
- **[Tauri 2](https://tauri.app/)** — the native shell.

## License

[BUSL-1.1](LICENSE) — same Parameters as upstream Exo, with attribution preserved. The license becomes Apache 2.0 on the Change Date (2033-01-01) or four years from this fork's first publicly available distribution, whichever comes first.
