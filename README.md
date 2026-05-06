<div align="center">

### AOS Mail — Agent Operated System for Mail

[![License](https://img.shields.io/github/license/mrdulasolutions/AOS-Mail?style=flat)](LICENSE)
[![Build status](https://img.shields.io/github/actions/workflow/status/mrdulasolutions/AOS-Mail/ci.yml?style=flat&logo=github)](https://github.com/mrdulasolutions/AOS-Mail/actions)

<br />

**AOS Mail** is a native-feeling, multi-inbox, Claude-powered Mac email client. <br />
Built with Tauri 2, React, TypeScript, and Tailwind CSS.

<br />

The vision: the **beauty of a native Mac app**, the **horsepower of a fully agentic email worker/partner**, and the ability to **handle multiple inboxes** at once.

<br />

</div>

# AOS Mail

AOS Mail treats AI as a first-class citizen — not a bolted-on feature. Every email gets analyzed, prioritized, and optionally drafted before you even open it. The goal is zero cognitive load: open your inbox and everything is already handled or ready to send.

## Status

V1 in progress. The shell is migrating from Electron to **Tauri 2 + Node sidecar** for a native Mac feel; multi-inbox support is being added on top of the existing Gmail integration.

## Features (current + V1 targets)

### Native Mac feel (V1)
- Vibrancy / `NSVisualEffectView` sidebar and toolbar
- Native menu bar with Mac-standard shortcuts
- Traffic-light positioning, frameless window, system fonts
- Dock badge for unread count, native notifications

### Multi-inbox (V1)
- **Gmail** — OAuth + Gmail History API for incremental sync (working)
- **IMAP / SMTP** — iCloud, Yahoo, Fastmail, Outlook, custom domains (V1 target)
- Per-account isolation (splits, snooze timers, agent tasks scoped per-account)
- Instant account switching

### Agentic inbox worker (V1)
- **Triage** — Claude analyzes every incoming email; assigns priority and one-line summary
- **Thread summary** — 2–4 sentence summary + extracted action items on thread open
- **Draft in your voice** — replies generated from your sent-mail style profile, with a "why" panel for trust
- **Agent activity tray** — every agent action visible, confirmable, and audited; nothing silently committed
- **Cmd+J agent palette** — natural-language commands on the current email
- **Per-email agent tasks** — each thread can have its own running agent task
- **Persistent memories** — agent learns from corrections and accumulates per-sender / per-topic context

### Inbox organization
- Split inbox (Priority / Other / custom)
- Snoozed view with natural-language time input
- Archive-ready batch view
- Hybrid local FTS5 + remote search

### Composition
- ProseMirror rich-text composer with formatting toolbar
- `@`/`+` mention autocomplete; CC/BCC with full contact-history autocomplete
- Multiple signatures, scheduled send, undo send, inline images, drag-and-drop attachments

### Keyboard-driven
- j/k navigation, e archive, # trash, s star, u unread, r/a/f reply/reply-all/forward
- Optional Gmail-standard bindings
- Cmd+K command palette, batch select with Cmd/Shift+click

### Calendar (sync exists; UI in V2)
- Day view with events from connected Google Calendars

## Architecture (V1, in progress)

```
+-----------------------------------------------+
|  Tauri 2 shell (Rust)                         |
|   - native window, vibrancy, traffic lights   |
|   - native menu bar, Keychain, notifications  |
|   - spawns + supervises Node sidecar          |
+----------------+------------------------------+
                 | local Unix socket / stdio
+----------------v------------------------------+
|  Node sidecar (TypeScript)                    |
|   - gmail, imap, anthropic, agents            |
|   - SQLite at                                 |
|     ~/Library/Application Support/AOS Mail/   |
+----------------+------------------------------+
                 | Tauri events
+----------------v------------------------------+
|  React renderer (TypeScript, Vite)            |
|   - Tailwind, Zustand, Tiptap                 |
+-----------------------------------------------+
```

See [CLAUDE.md](CLAUDE.md) for full architecture details and data flows.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Provide credentials

Copy `.env.example` to `.env` and fill in:

- `MAIN_VITE_GOOGLE_CLIENT_ID`, `MAIN_VITE_GOOGLE_CLIENT_SECRET` — for Gmail OAuth (Google Cloud Console → Enable Gmail API + Calendar API → OAuth credentials with redirect `http://localhost`)
- `ANTHROPIC_API_KEY` — for the agent (can also be set in Settings)

### 3. Run

```bash
npm run dev
```

### Demo mode (no API keys needed)

```bash
npm run dev:demo
```

## Commands

```bash
npm run dev          # Start dev server
npm run dev:demo     # Demo mode with fake data
npm run build        # Production build
npm test             # Run all tests
npx tsc --noEmit     # Type check
```

## Configuration

All app data lives under `~/Library/Application Support/AOS Mail/` on macOS.

## Attribution

AOS Mail is forked from [`mrdulasolutions/mail-app`](https://github.com/mrdulasolutions/mail-app), itself a fork of [`ankitvgupta/exo`](https://github.com/ankitvgupta/exo) (BSL-1.1) — *"Claude Code for your Inbox."* Substantial credit to the upstream authors for the agent infrastructure, Gmail sync, and overall product shape we're building on.

## License

[BSL-1.1](LICENSE) — same as upstream.
