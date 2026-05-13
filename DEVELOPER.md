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
- [Release pipeline](#release-pipeline-automated-via-github-actions)
- [Updater key management](#updater-key-management)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting-common-devrelease-issues)
- [Roadmap](#roadmap)

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
- **Bundle size** — the unpacked `.app` is ~125 MB on disk; the shipped `.dmg` compresses that to ~45 MB. The dominant payload is the bundled Node binary (~113 MB) — required so the sidecar runs on any Mac without a system Node install. Pre-Tauri Electron was 80 MB+ for a smaller-functionality slice; we're paying for self-contained Node here, knowingly.

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

## Release pipeline (automated via GitHub Actions)

Releases are fully automated by `.github/workflows/release.yml`. **You don't run `codesign` or `notarytool` locally.** You bump the version, push a tag, and the workflow does the rest.

### The pipeline at a glance

A tag push matching `v*` triggers a matrix build (currently `aarch64-apple-darwin` on `macos-latest` only; `x86_64-apple-darwin` on `macos-13` is configured but GitHub's Intel runner pool has been unreliable — see [docs/POST-MORTEM-2026-05.md](docs/POST-MORTEM-2026-05.md)). Each matrix job runs through 14 steps:

1. **Checkout** the tagged commit.
2. **Setup Node + Rust** toolchains.
3. **Cache cargo** registry and `src-tauri/target/`.
4. **`npm ci`** root + sidecar.
5. **Pre-import Apple Developer ID cert** into a fresh keychain in `$RUNNER_TEMP` (necessary so the next step can codesign `.node` binaries — see [PR #9, #10](https://github.com/mrdulasolutions/AOS-Mail/pulls)).
6. **Build sidecar** — runs `prepare-node` (bundle real Node binary), `build` (esbuild the JS), `package` (wrap in self-extracting bash stub), `runtime-modules` (copy + sign `better_sqlite3.node`).
7. **Probe Apple signing secrets** — logs whether codesign and notarization will run.
8. **Strip AppleDouble metadata** — sweeps `._*` files from `src-tauri/target`, `sidecar/`, `node_modules`. Without this, `tauri-plugin-updater`'s tar extractor SIGKILLs on the resulting `.app.tar.gz`. See [PR #2](https://github.com/mrdulasolutions/AOS-Mail/pull/2).
9. **`tauri-action@v0`** — compiles the Rust binary, bundles the `.app`, codesigns with the Developer ID, notarizes via Apple, builds the `.dmg`, signs the updater bundle with the minisign key, and uploads everything to a **draft** GitHub release.
10. **Verify update tarball** — raw-parses the produced `.app.tar.gz` (since BSD `tar -t` hides AppleDouble entries) and fails the build if any `._*` entries are present.
11. **Summarize artifacts** in the run log.

### Cutting a release

```bash
# 1. Bump the version in all four canonical files (they MUST agree):
#    - package.json                 "version"
#    - sidecar/package.json         "version" (optional but conventional)
#    - src-tauri/tauri.conf.json    "version"
#    - src-tauri/Cargo.toml         [package] version
#    - src-tauri/Cargo.lock         [[package]] name = "aos-mail" → version
git commit -am "chore(release): bump to v0.1.9"
git push origin main

# 2. Tag and push.
git tag v0.1.9
git push origin v0.1.9

# 3. Watch the workflow.
gh run watch  # or visit Actions in the GitHub UI

# 4. When green, GitHub Releases has a DRAFT release with all artifacts
#    attached. Review the assets, edit the auto-generated release notes
#    if needed, then click "Publish release."
gh release view v0.1.9                       # check artifacts
gh release edit v0.1.9 --draft=false          # or publish from UI
```

The moment the draft is published, `releases/latest/download/latest.json` flips, and every running install picks up the new version on its next check.

### Required GitHub Actions secrets

All eight must be set at <https://github.com/mrdulasolutions/AOS-Mail/settings/secrets/actions> for a fully-signed + notarized + auto-updatable release:

| Secret | Value | How to obtain |
|---|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` of the Developer ID Application cert | `security export -k login.keychain-db -t identities -f pkcs12 -P <pw> -o cert.p12 && base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set on the `.p12` export | (whatever you typed above) |
| `APPLE_SIGNING_IDENTITY` | The exact CN: `Developer ID Application: <Name> (<Team ID>)` | `security find-identity -v -p codesigning` |
| `APPLE_ID` | Apple ID email for notarization | The Apple ID enrolled in the Developer Program |
| `APPLE_PASSWORD` | App-specific password (16-char `xxxx-xxxx-xxxx-xxxx`) | <https://account.apple.com> → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | 10-char team identifier | Visible in the CN above, also at <https://developer.apple.com/account> |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/aos-mail-v2.key` (the entire base64 minisign blob) | `npx @tauri-apps/cli signer generate -w ~/.tauri/aos-mail-v2.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the minisign key | (whatever you chose when generating) |

If any signing secret is missing, the build still produces an `.app` and `.dmg` but they'll be unsigned and won't pass Gatekeeper on a fresh machine. If any notarization secret is missing, the build signs but skips notarytool — users see the "unidentified developer" warning on first open.

If `TAURI_SIGNING_PRIVATE_KEY` is missing, the workflow skips producing `.app.tar.gz.sig` and `latest.json` — auto-update breaks. Don't ship a release this way; users will be stuck manually downloading DMGs.

### Verifying a published release

```bash
# Pull the produced .app
mkdir /tmp/verify && cd /tmp/verify
gh release download v0.1.9 --repo mrdulasolutions/AOS-Mail --pattern '*aarch64*.tar.gz'
tar -xzf AOS.Mail_aarch64.app.tar.gz

# Gatekeeper assessment
spctl -a -vv "AOS Mail.app"
# Expect: accepted / source=Notarized Developer ID

# Stapler ticket validation
xcrun stapler validate "AOS Mail.app"
# Expect: The validate action worked!

# Inspect signing chain
codesign -dvv "AOS Mail.app"
# Expect three Authority lines:
#   Authority=Developer ID Application: Matthew Dula (PPY9K2BYJH)
#   Authority=Developer ID Certification Authority
#   Authority=Apple Root CA

# Confirm zero AppleDouble entries in the updater tarball
gzip -dc AOS.Mail_aarch64.app.tar.gz | python3 -c '
import sys
d = sys.stdin.buffer.read(); i = 0; n = 0
while i + 512 <= len(d):
    name = d[i:i+100].split(b"\x00",1)[0].decode("utf-8","replace")
    if not name: break
    if name.startswith("._") or "/._" in name: n += 1
    try: size = int((d[i+124:i+135].split(b"\x00",1)[0].strip() or b"0"), 8)
    except ValueError: size = 0
    i += 512 + ((size + 511) // 512) * 512
print("AppleDouble entries:", n)
'
# Expect: AppleDouble entries: 0
```

### `latest.json` format (auto-generated by tauri-action)

```json
{
  "version": "0.1.9",
  "notes": "Brief release summary",
  "pub_date": "2026-05-13T22:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of AOS.Mail_aarch64.app.tar.gz.sig>",
      "url": "https://github.com/mrdulasolutions/AOS-Mail/releases/download/v0.1.9/AOS.Mail_aarch64.app.tar.gz"
    }
  }
}
```

Note the **single-platform-only** structure today. The matrix runs both arm64 and x64 jobs (when Intel runners are available), but each job uploads its own `latest.json` to the same draft and the second upload wins. A future workflow patch should merge platform entries into one `latest.json` before publish. Until then, Intel users have no auto-update channel.

---

## Updater key management

The Tauri updater uses a minisign keypair. Public key is embedded in `src-tauri/tauri.conf.json`; private key lives outside the repo.

**Current key:** `~/.tauri/aos-mail-v2.key` (pubkey ID `6B791DD61977DEDE`). The v1 key was retired in [PR #8](https://github.com/mrdulasolutions/AOS-Mail/pull/8) after its password was lost — see [docs/POST-MORTEM-2026-05.md](docs/POST-MORTEM-2026-05.md) for the full incident.

**Where the key lives:**

- **Canonical local copy**: `~/.tauri/aos-mail-v2.key` + `.pub` on the maintainer's machine, chmod 600.
- **GitHub Actions secret**: `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Password manager**: 1Password (or equivalent) vault entry "AOS Mail — Tauri Updater Private Key v2". **This is mandatory — losing the password breaks auto-update for every installed client.**

### Rotation

Rotate when:

1. The private key was committed or leaked.
2. **Hygiene:** every 2-3 years.

```bash
# 1. Generate a new key
npx @tauri-apps/cli signer generate \
  --password <pick a strong password> \
  --write-keys ~/.tauri/aos-mail-v3.key \
  --force

# 2. Update tauri.conf.json:
#    plugins.updater.pubkey ← contents of ~/.tauri/aos-mail-v3.key.pub
#    Commit + merge that change.

# 3. Update GitHub secrets:
cat ~/.tauri/aos-mail-v3.key | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo mrdulasolutions/AOS-Mail
echo -n '<the new password>' | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo mrdulasolutions/AOS-Mail

# 4. Save the new password to 1Password BEFORE cutting the release.

# 5. Tag a new version. Existing installs (with the OLD pubkey embedded
#    in their .app) will REJECT signed updates from the new key — they
#    have to download the .dmg manually once. From there forward,
#    auto-updates resume working.
```

**The rotation cost is real.** Every user on the old pubkey loses auto-update until they manually install the new build. Communicate the rotation in the release notes and consider keeping both pubkeys valid during a transition window (Tauri 2 doesn't support multi-pubkey natively; this would require a custom updater fork).

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

## Troubleshooting (common dev/release issues)

### `tauri dev` exits immediately with `sidecar terminated: signal: Some(9)`

The bundled Node binary at `src-tauri/target/debug/aos-mail-node` was SIGKILL'd by macOS's `amfid`. Modern macOS (14.4+) refuses to execute unsigned arm64 Mach-O binaries. The `prepare-node` script strips Node Foundation's signature so tauri-action can re-sign with the Developer ID in production — but in dev mode nothing re-signs, leaving the binary unsigned. Fixed in [PR #16](https://github.com/mrdulasolutions/AOS-Mail/pull/16) by ad-hoc signing after the strip. If you see this on a branch that pre-dates PR #16, run:

```bash
codesign --sign - --force --timestamp=none src-tauri/binaries/aos-mail-node-aarch64-apple-darwin
```

### Release build: `failed to import keychain certificate` during tauri-action

`security import` is rejecting the `.p12`. Almost always one of:

- `APPLE_CERTIFICATE_PASSWORD` secret is empty or wrong.
- `APPLE_CERTIFICATE` secret contains multiple identities — the runner picks one that doesn't match `APPLE_SIGNING_IDENTITY`. Re-export the Developer ID cert **without** the Apple Development cert (use Keychain Access → select only the Developer ID identity + its private key → File → Export).

### Release build: `failed to notarize app: Team ID must be at least 3 characters`

Notarization secrets are missing or empty. tauri-action treats empty env vars as "present, try to notarize" and Apple rejects. Either set all three (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`), or wait for the workflow patch that conditionally passes them.

### Released `.app.tar.gz` is 9 MB instead of 45 MB

Stale tauri-bundler cache. `src-tauri/target/` is cached by `actions/cache@v4`; the cached `bundle/macos/*.app.tar.gz` from a previous broken run can survive a rebuild even when the underlying `.app` is correct. The workflow now wipes `src-tauri/target/<triple>/release/bundle/` before tauri-action runs (PR #12). If you see this regress, that step is the first thing to check.

### Auto-update fails on user machines with `failed to unpack \`._AOS Mail.app\``

The updater tarball contains macOS AppleDouble metadata files. Caused by `actions/cache@v4` restoring files with extended attributes — `gtar` seeds `._*` companions into the workspace, which then leak into the updater bundle. The workflow's `COPYFILE_DISABLE=1` env var + "Strip AppleDouble metadata" step (PR #2) prevent this; the "Verify update tarball" gate catches regressions before publish.

### Notifications stopped working in production

Almost always a macOS TCC desync, not the app. Reset and re-grant:

```bash
tccutil reset Notifications com.mrdulasolutions.aosmail
# Quit AOS Mail entirely, relaunch from /Applications, click Test.
```

If the banner still doesn't appear, watch `usernoted` live while clicking Test:

```bash
log stream --predicate 'process == "usernoted"' --info
```

Apple's daemon will log the filter reason in plain text — Focus mode, alert style None, signature mismatch, etc.

### "OpenRouter API key not saving" / changes don't take effect mid-session

Pre-PR #14 bug: the renderer's Settings page wrote the new key to Keychain but never forwarded it to the sidecar's in-memory secrets store. The key took effect only after restart. PR #14 added the missing `settings.set` / `openrouter.setApiKey` forward. If you see this on an old branch, restart the app.

### Free OpenRouter models hit `HTTP 429: free-models-per-min`

OpenRouter caps free models at 16 req/min, and concurrent agent flows blow through that in seconds. PR #13 added a client-side sliding-window limiter scoped to `:free` model ids. If 429s persist even with the limiter active, it's almost certainly an upstream provider's own throttling — `google/gemma-*:free` proxies to Google AI Studio which has its own (much tighter) per-account quota. Switch model or BYOK upstream.

---

## Roadmap

V2 backlog lives at [docs/ROADMAP-V2.md](docs/ROADMAP-V2.md). Highlights: voice-to-inbox, thread-derailment warnings, knowledge graph, Microsoft Graph / JMAP adapters, cross-app MCP (Calendar / ClickUp / Slack / HubSpot), Linux + Windows builds, iOS companion.
