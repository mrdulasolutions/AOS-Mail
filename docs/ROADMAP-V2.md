# AOS Mail — Roadmap to "where has this been my whole life"

V1 is the foundation: Tauri shell, Gmail + IMAP sync, Claude-powered triage and drafts, calendar shell, sender enrichment. It works. It's even good.

Wonder is the next thing. The features below are the ones a user couldn't walk away from — the ones where we earn the agent-operated-system-for-mail name. This is a roadmap, not a sprint plan. Each item lists why it matters, what it would take, and the order I'd do them in.

## Tier 1 — the "I'm never using another mail client" moves

These are the features where, if AOS Mail did them and nothing else did, switching would be irreversible.

### 1. The agent that handles your inbox while you sleep

**The wow:** open the app in the morning. Inbox is already triaged into "needs you" / "decided" / "delegated" / "killed." 47 newsletters auto-archived. Three drafts are waiting in your voice for the conversations the agent couldn't finish without you. Your calendar already has tentative meetings the agent agreed to on your behalf, marked `[DRAFT]` for one-tap confirmation. The agent leaves a 30-second morning briefing in plain English: "you owe Tom a yes/no on the Q3 plan; the Acme renewal needs your decision by Wednesday; everything else is handled."

**Why no one else has this:** every existing email client is reactive. They show you what arrived. The wow is *you arrive to a finished inbox*. Superhuman speeds you up; Hey filters you; AOS Mail is the only one that can actually *do work for you* because the agent SDK is in the loop.

**What it takes:**
- Permission gate is already scaffolded (`agent_audit_log`, `permission-gate.ts` in the original plan). Resurrect it: the agent proposes, the user approves in batch.
- A small "morning briefing" panel that runs daily at the user's preferred local time (cron in the sidecar; falls back to "next time you open the app").
- Auto-archive rules learned from your behavior — already half-built via `analysisOverrideLearned` events that nobody surfaces yet.
- Calendar autonomy: agent reads invites, checks free/busy, drafts a "Yes Tuesday at 2 works" reply, and creates a tentative event. User approves in one click.

**Effort:** 2 weeks of focused work once the calendar provider lands.

---

### 2. Voice-to-Inbox

**The wow:** while walking, you say *"hey Mail, what does Sarah's email need from me?"* AOS Mail reads it aloud in its own voice, you say *"reply yes, push to Friday, no other times this week,"* and it drafts in your style and shows it next time you look at the screen. Or you say *"send the contract from yesterday to Tom with a one-line note saying we're good,"* and it composes and queues for your review.

**Why no one else has this:** Apple Mail has dictation in fields. Gmail has "smart compose." Nobody has a *conversational agent that operates on your inbox by voice.* This is what every "AI assistant" demo promised in 2010 and never delivered. With Whisper + Claude + tool use, it's two days of work.

**What it takes:**
- macOS shortcut + tray menu to start a voice session
- Whisper for STT (local via `whisper.cpp`, or Anthropic's voice API when it ships)
- Conversational loop: agent's responses voiced via macOS `say` or ElevenLabs
- Tool surface for the agent: read emails, draft, schedule, snooze, archive — already exists in the agent layer

**Effort:** 1 week.

---

### 3. The "this thread is going to derail" early warning

**The wow:** you're in the middle of a thread with a customer. AOS Mail surfaces a small banner: *"This is heading toward a refund request. Last 4 customers who sent emails like this churned within 30 days. Suggested next step: jump on a 15-minute call. I drafted the invite."*

**Why no one else has this:** combines pattern matching across your historical inbox with present-context reasoning. Your inbox is already a treasure trove of business signal — outcomes are knowable (the customer churned or didn't, the deal closed or didn't). Surfacing those patterns in real time is something only an LLM can do, and only if it has access to the entire thread history *and* the eventual outcome.

**What it takes:**
- Outcome labeling: when a thread terminates (no replies for N days, archived, marked done), agent classifies the outcome (positive/neutral/negative + a free-text summary). Persisted.
- Embedding/index of past thread shapes (Anthropic embeddings + simple cosine search).
- On every new inbound, a quick "does this rhyme with anything bad?" check. Cheap with Haiku.
- Banner UI in EmailDetail when matched.

**Effort:** 2 weeks. Big-picture win.

---

## Tier 2 — make the daily experience effortless

### 4. Inbox Zero in three keystrokes per email

**The wow:** open an email. Hit `space`. The agent makes the right call (archive, send pre-drafted reply, schedule, defer to delegate). 80% of the time it nailed it; 20% you tap `escape` and decide manually. Inbox of 200 → empty in 12 minutes.

**What it takes:**
- A "smart action" key bound to space-bar that: reads the analysis, picks the most likely action, executes with a 5-second undo
- Rules for confidence thresholds: only auto-act when the analyzer's confidence is high; otherwise default to "open thread"
- Fast undo via toast → ⌘Z

**Effort:** 3 days.

---

### 5. The composer that already wrote the email

**The wow:** click "compose" → an empty composer? No. The composer opens with three drafts the agent thinks you might be writing right now, based on context (calendar invite you just looked at, a tab with a doc open in your browser via the Chrome MCP, a task you completed in ClickUp/Linear). Pick one or start fresh.

**What it takes:**
- Cross-app MCP integration (already a deferred Phase 2 item in the original plan)
- "Recent context" stream: last 10 calendar events viewed, last 10 docs opened, last 10 ClickUp tasks moved
- Composer mounts → fire a tiny Haiku call: "given this user's recent activity, predict 3 emails they might be about to write." Render as starter cards.

**Effort:** 1 week (mostly the MCP integration; the composer side is small).

---

### 6. The follow-up that knows when to follow up

**The wow:** you sent Tom an email three days ago asking him to review a doc. Tom hasn't responded. AOS Mail surfaces a small card: "Tom hasn't replied in 3 days. Last time it took 2 days. Want me to send a nudge? Here's a draft." If you tap yes, it sends in your voice with the right level of urgency.

**Why no one else has this:** everyone has reminders ("remind me if no reply"). Nobody has the LLM in the loop to *write a contextual nudge in your voice.* Boomerang and Mixmax have templates; we have Claude.

**What it takes:**
- Nudge-detector: scheduled job runs nightly, finds threads where the user sent the last message and no reply has come in N days (where N is learned per recipient).
- Surface as a "Awaiting Reply" smart inbox view.
- One-click "draft a nudge" that calls the drafter with `composeMode: "nudge"` and a short system prompt.

**Effort:** 1 week.

---

### 7. The summary that sees the whole forest

**The wow:** "How are things with the Acme deal?" — typed into the agent palette (`⌘J`). Agent reads the entire Acme thread history (every thread tagged Acme or with Acme employees), summarizes the relationship, surfaces open items, names the people involved, links the doc that was last attached. 4 seconds. You haven't had this kind of context for any deal you've ever worked on.

**What it takes:**
- Thread search across all accounts by free text (already wired via FTS5)
- "Topic" extraction — clusters of related threads
- Agent palette already exists (V2 in the build plan) — just unblock it
- The summary call is a 30k-token Haiku request — under a cent.

**Effort:** 1 week (mostly the agent palette UI).

---

## Tier 3 — the polish that compounds

### 8. Native Spotlight indexing — search your email from anywhere

Cmd-Space → type a sender name → up arrow shows their last 5 threads with you. Click → AOS Mail opens to that thread. NSUserActivity / CSSearchableItem on macOS makes this almost free. Stretch goal in the original plan; should land.

### 9. The Calendar that drafts your day

After Calendar V1 ships, the next step: every morning, the agent looks at your day, identifies the meeting that matters most, and pre-loads context. "Your 11am with Sarah is about the Q3 plan she sent Tuesday. Here's the doc, here's your last conversation, here's a 3-line agenda based on her email."

### 10. Cross-account smart inbox

You have personal Gmail + work IMAP + a side project email. AOS Mail shows them merged with consistent triage rules — but with a hover-revealed account badge and one-key filtering by account. Most multi-account clients fail this; the trick is a unified Zustand selector + careful UX.

### 11. Knowledge graph from your own inbox

Every person you've ever emailed → their company, role, last conversation, your last commitment to them, what you owe them, what they owe you. Powered by `correspondent_profiles` + `memory.classify` + a periodic graph build. Hover any name in any thread → mini-card.

### 12. Scheduled drafts you actually trust

You write a reply on Sunday for Monday morning. Currently every email client lets you schedule. Few let you say "send when Sarah is online and likely to read it" — but Claude can read her time-zone hints from her past emails and we already have her email metadata. Worth it for high-stakes notes.

### 13. Templates that learn

Snippets are already wired. Next: every time you send a similar reply 3+ times, AOS Mail proposes a snippet automatically with a name it generates. You confirm or kill it. Over a month you have a personal-style library that didn't take any work to build.

### 14. The "I'm at a coffee shop" mode

One toggle: hides email bodies in the list, shows only sender + subject. Nobody can shoulder-surf your inbox. Bonus: the right-sidebar Sender panel hides too. Tiny feature, huge for executives.

### 15. End-to-end keyboard

Already partially there (j/k/r/a/e). Round it out so you literally never need a mouse. Including: Cmd-K palette for any account / split / setting / extension. Once nailed, the app feels like a tool not a website.

---

## Tier 4 — the things that make us a moat

### 16. Inbox-as-a-database via SQL

A user-facing query box: "all unanswered emails from external customers in the last 30 days where the deal is over $50k" → table of results. Powered by FTS5 + a Claude-translated SQL layer over the user's local DB. Power users will marry this app.

### 17. Open-source extension marketplace

Today AOS Mail ships bundled extensions (sender-profile is the first). When the framework matures: a registry where developers can publish extensions (GitHub-based, signed). Verticalized extensions for legal review, sales follow-ups, etc. The agent + MCP + extensions trinity becomes the moat.

### 18. Background agents that run while the app is closed

The sidecar can run as a launchd-managed daemon: agent does morning triage at 6am even if the app isn't open. Notification when finished. App opens to a finished inbox.

### 19. Local LLM tier

For the truly privacy-conscious: bundle a small local model (Llama-3-8B or similar) for triage. Cloud Claude only for drafts where you want quality. User toggles privacy-mode and nothing leaves the machine. Already half-feasible via the OpenRouter integration's model picker.

### 20. Voice-cloned email replies

Once we have enough sent-email data per user (already tracked via `style_samples`), the drafts could be near-indistinguishable from the user's own writing. Already partially achieved via the style-profiler — push it harder.

---

## Sequencing

**Next 30 days:**
1. Calendar V1 lands (in flight)
2. Extensions framework + sender profile (in flight)
3. Auto-archive rules learned from behavior (#1 partial)
4. Smart action key (#4)
5. Awaiting-reply nudge (#6)

**60 days:**
6. Morning briefing + agent permission tray (#1 full)
7. Cross-app MCP (#5)
8. Spotlight indexing (#8)
9. Background daemon mode (#18)

**90 days:**
10. Voice-to-inbox (#2)
11. Thread-derailment warning (#3)
12. Knowledge graph (#11)
13. Local LLM tier (#19)

**Ongoing:**
- Snippets that learn (#13)
- Templates marketplace (#17)
- Keyboard rounding (#15)

---

## Why this works

Most email clients optimize for *speed of triage.* AOS Mail optimizes for *the agent doing your work.* That's the unlock — not faster manual processing, but *less manual processing.*

The agent SDK + MCP + style profiler + audit log + permission gate are scaffolding that nothing else has. We use them to build features that don't exist anywhere else, not to replicate Superhuman with a different keyboard layout.

Every feature on this list is doable in days-to-weeks because the foundation is right. The bet: ship 4–6 of the Tier 1 items and the app stops being "another email client" and starts being "the thing that runs my email so I can think about other things."
