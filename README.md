<div align="center">

# AOS Mail

### Your inbox, but Claude already read it.

[![Download for macOS](https://img.shields.io/badge/Download-macOS%20Apple%20Silicon-blue?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/mrdulasolutions/AOS-Mail/releases/latest)
[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-orange.svg?style=for-the-badge)](LICENSE)

</div>

---

## What it is

AOS Mail is a Mac email client where an AI agent has already read every message before you open the app. It tells you what's important, drafts the replies, sorts the noise, and surfaces a tight queue of decisions for you to confirm.

Think of it less like an email app with an AI button bolted on, and more like having an assistant who triages your inbox while you sleep — except the assistant shows their work, asks before doing anything, and never sends a thing without your sign-off.

It's a real Mac app: native window chrome, Keychain-backed secrets, system notifications, dock badge for unread, signed and notarized so it just opens. No web wrapper.

## What you can do with it

**Connect any inbox.** Gmail, iCloud, Fastmail, Outlook, Yahoo, your custom domain — they all work the same. Multiple accounts at once. Switch between them instantly.

**Open the app to a digest, not a flood.** A morning briefing summarizes overnight mail, surfaces decisions waiting on you, and lays out the day's queue in priority order.

**Hit one key to do the right thing.** The smart-action key runs the agent's recommendation for whatever thread you're looking at — archive, reply, snooze, or delegate — with full undo.

**Get drafted replies in your voice.** The agent learns from your sent mail and produces drafts that sound like you, not like a chatbot. Click "Why" to see its reasoning. Edit, send, or trash.

**Stop forgetting follow-ups.** "Awaiting reply" surfaces threads where you sent something and never heard back, and offers a one-line nudge.

**Watch it learn.** When the agent notices a pattern ("you always archive these newsletters"), it proposes a rule. You confirm or reject. Nothing silent.

**Keep control.** Every queued agent action is visible in a tray. The full audit log is one click away. Nothing gets sent or moved without your approval.

**Search like it's local.** Hybrid search hits your local index first (instant), then your provider's server for older mail.

**Calendar is in the loop.** Day view of upcoming events. Ask the agent to schedule something from a thread; it suggests times and creates the event.

## Get it

> **Requires:** macOS 13 or later, Apple Silicon (M-series). Intel Mac support is on the roadmap.

1. **[Download `AOS_Mail_0.1.0_aarch64.dmg`](https://github.com/mrdulasolutions/AOS-Mail/releases/latest)** from the latest release
2. Double-click the DMG and drag **AOS Mail** to your Applications folder
3. Open it. On first launch you'll be asked to:
   - Connect a Gmail account (OAuth) or an IMAP account (iCloud, Fastmail, etc.)
   - Paste an Anthropic or OpenRouter API key (or skip and add later in Settings)

That's it.

The app is signed by Apple Developer ID and notarized — Gatekeeper opens it without a fight. New versions auto-update silently in the background.

## Where it came from

AOS Mail is a fork of [**Exo**](https://github.com/ankitvgupta/exo) — *"Claude Code for your Inbox"* — by Ankit Gupta. Exo built the core agent loop, the Gmail integration, and the product shape we're standing on.

Where AOS Mail goes further: a real Mac app instead of an Electron window, IMAP support so it's not Gmail-only, a wider agent surface (morning briefing, smart-action, awaiting-reply, learned rules), calendar UI, an extensions system, and a signed release pipeline. Full breakdown lives in [DEVELOPER.md](DEVELOPER.md).

We're indebted to Ankit and the upstream Exo project. License is identical to upstream — see [LICENSE](LICENSE).

## Building from source / contributing

If you want to build AOS Mail yourself, hack on it, or contribute back, head to **[DEVELOPER.md](DEVELOPER.md)** — that's where the architecture, commands, contracts, and release pipeline live.

For agent / Claude collaboration patterns specific to this codebase, see **[CLAUDE.md](CLAUDE.md)**.

## License

[BUSL-1.1](LICENSE) — same as upstream Exo. Free for personal and internal-organization use; commercial use requires a separate license. Becomes Apache 2.0 on January 1, 2033.

## Acknowledgements

- **[Ankit Gupta](https://github.com/ankitvgupta)** — for [Exo](https://github.com/ankitvgupta/exo), the upstream this is built on
- **[Anthropic](https://www.anthropic.com/claude)** — for Claude
- **[Tauri](https://tauri.app/)**, **[imapflow](https://github.com/postalsys/imapflow)**, **[nodemailer](https://nodemailer.com)**, **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** — and everyone else listed in [NOTICE](NOTICE)
