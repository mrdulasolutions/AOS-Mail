# Releasing AOS Mail

This document describes how the GitHub Actions release pipeline works and how to cut a new release of AOS Mail.

## Overview

The release workflow lives at `.github/workflows/release.yml`. It is built around the official [`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action), which handles cross-platform Tauri bundling, optional code signing + notarization, and uploading artifacts to GitHub Releases in one step.

When you push a tag matching `v*`, the workflow:

1. Builds on macOS for both `aarch64-apple-darwin` (Apple Silicon) and `x86_64-apple-darwin` (Intel) as a matrix.
2. Compiles the Node sidecar binary via `npm --prefix sidecar run build && npm --prefix sidecar run package` so `src-tauri/binaries/aos-mail-sidecar` exists before Tauri bundles the app.
3. Invokes `tauri-action` with `args: --target <triple>` so each runner produces a per-arch `.app` and `.dmg`.
4. Reads Apple secrets from the repo's GitHub Actions secrets. If signing identity secrets are present, the artifacts are signed + notarized. If they are empty, `tauri-action` skips signing gracefully and produces an unsigned artifact (the build will not hard-fail).
5. Creates (or appends to) a draft GitHub Release named `AOS Mail v<version>` and uploads the `.app` and `.dmg` files.

The release is created as a **draft** so you can review the artifacts and the auto-generated release notes before publishing it manually from the GitHub Releases UI.

## Required GitHub Actions secrets

These secrets must be added in the repo's **Settings → Secrets and variables → Actions** before the workflow can produce a properly signed & notarized release. Without them, the workflow still runs but produces unsigned artifacts.

| Secret name                  | What it is                                                                 |
| ---------------------------- | -------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded `.p12` of the Developer ID Application certificate.         |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting the `.p12`.                                            |
| `APPLE_SIGNING_IDENTITY`     | The signing identity string (e.g. `Developer ID Application: Name (TEAMID)`). |
| `APPLE_ID`                   | The Apple ID email used for notarization.                                  |
| `APPLE_PASSWORD`             | An app-specific password generated for that Apple ID.                      |
| `APPLE_TEAM_ID`              | Your Apple Developer Team ID.                                              |

`GITHUB_TOKEN` is provided automatically by GitHub Actions — you do not add it manually.

To produce the base64 `APPLE_CERTIFICATE` from your local `.p12`:

```sh
base64 -i path/to/certificate.p12 | pbcopy
```

Paste that as the secret value.

## How to cut a release

1. Bump the version in **all three** places so they match (Tauri reads the version from `tauri.conf.json` at bundle time, but keep them aligned):
   - `package.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`
   - `src-tauri/tauri.conf.json` → `"version"`
2. Commit the version bump:
   ```sh
   git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
   git commit -m "chore: release v0.x.y"
   ```
3. Tag and push:
   ```sh
   git tag v0.x.y
   git push origin main
   git push --tags
   ```
4. Watch the run under **Actions → Release** in GitHub. Both arch jobs must succeed.
5. Once the workflow completes, go to **Releases**. The new release will be in **Draft** status with the `.app` and `.dmg` artifacts attached for both architectures.
6. Review the auto-generated release notes, edit if needed, then click **Publish release**.

## Manual trigger

The workflow also supports `workflow_dispatch`, so you can run it from the **Actions → Release → Run workflow** button without pushing a tag. This is useful for testing the pipeline. When triggered manually without a tag, the workflow still builds but the release-upload step uses a placeholder version derived from `tauri.conf.json`.

## Where artifacts land

- **GitHub Releases** at <https://github.com/mrdulasolutions/AOS-Mail/releases> — the canonical destination.
- The artifacts attached to each release are produced inside `src-tauri/target/<triple>/release/bundle/` on the runner; `tauri-action` uploads them automatically.

## Updater (future)

The Tauri updater plugin is currently disabled (`plugins.updater.active = false` in `tauri.conf.json`). When we enable it, the workflow will also need to publish a `latest.json` manifest signed with an updater private key. That key would be added as an additional GitHub secret (e.g. `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), and `tauri-action` will pick those up automatically when present.
