# Releasing AOS Mail

How to ship a new version of AOS Mail end to end — from a clean checkout to a signed, notarized, auto-updating `.dmg` on GitHub Releases.

## Overview

The release workflow lives at `.github/workflows/release.yml`. It is built around the official [`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action), which handles cross-platform Tauri bundling, optional code signing + notarization, and uploading artifacts to a GitHub Release in one step.

When you push a tag matching `v*`, the workflow:

1. Builds on macOS for both `aarch64-apple-darwin` (Apple Silicon, runner: `macos-latest`) and `x86_64-apple-darwin` (Intel, runner: `macos-13`) as a matrix.
2. Compiles the Node sidecar binary via `npm --prefix sidecar run build && npm --prefix sidecar run package` so `src-tauri/binaries/aos-mail-sidecar` exists before Tauri bundles the app.
3. Probes the runner for Apple signing + Tauri updater secrets and prints whether each step will run or be skipped — visible in the run UI before tauri-action even starts.
4. Invokes `tauri-action` with `args: --target <triple>` so each runner produces a per-arch `.app`, `.dmg`, and updater bundle (`.app.tar.gz` + `.sig`).
5. Reads Apple secrets from the repo's GitHub Actions secrets. If signing identity secrets are present, the artifacts are signed + notarized. If they are empty, `tauri-action` skips signing gracefully and produces an unsigned artifact — the build will not hard-fail, but the result is not distributable to end users on macOS Gatekeeper.
6. Generates `latest.json` for the auto-updater and signs the bundle with `TAURI_SIGNING_PRIVATE_KEY`. tauri-action handles this automatically when the updater plugin is configured AND the signing key is present.
7. Creates (or appends to) a draft GitHub Release named `AOS Mail v<version>` and uploads the `.app`, `.dmg`, `.app.tar.gz`, `.sig`, and `latest.json`.

The release is created as a **draft** so you can review the artifacts and the auto-generated release notes before publishing it manually from the GitHub Releases UI.

## First-time setup

This section is the one-time prerequisite list for getting signing + notarization working. The Tauri updater key has its own ceremony — see "Updater key" below.

### 1. Apple Developer Program membership

You need an **active Apple Developer Program** membership ($99/yr) on the same Apple ID you intend to sign with. Verify status at <https://developer.apple.com/account>. An iOS Developer or free Apple ID will not work — distributing signed Mac apps requires the paid Developer Program.

### 2. Create a Developer ID Application certificate

1. Sign in to <https://developer.apple.com/account/resources/certificates/list>.
2. Click **+** to create a new certificate.
3. Pick **Developer ID Application** (NOT "Developer ID Installer", NOT "Mac App Distribution"). This is the cert used for distribution outside the Mac App Store, which is what we ship.
4. Follow the CSR (Certificate Signing Request) flow:
   - On macOS, open **Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority**.
   - Use the email tied to your Apple ID, leave CA blank, choose "Saved to disk", and continue.
   - Upload the resulting `.certSigningRequest` file to Apple's portal.
5. Apple issues the cert. Download the `.cer` file and double-click it to install into your login keychain.

### 3. Export the cert as a `.p12`

The runner needs the cert AND the private key. The `.cer` file alone only contains the public certificate — Keychain Access can export both as a `.p12`:

1. Open **Keychain Access → login keychain → My Certificates**.
2. Find the entry that starts with **Developer ID Application: <Name> (<TEAMID>)**.
3. Expand it (the disclosure triangle) — you should see both the certificate and a private key under it.
4. Right-click the certificate row → **Export "Developer ID Application: ..."**.
5. Save as `.p12`. **Set a strong password** — you will paste it into a GitHub secret. Keep it.

### 4. Discover your signing identity string

Open Terminal:

```sh
security find-identity -v -p codesigning
```

You want the line that looks like:

```
1) ABCD1234... "Developer ID Application: Your Name (TEAMID1234)"
```

The string in quotes is the value for `APPLE_SIGNING_IDENTITY`. The 10-character code in parentheses is your `APPLE_TEAM_ID` (also visible at <https://developer.apple.com/account#MembershipDetailsCard>).

### 5. Generate an app-specific password for notarization

Notarytool authenticates with an app-specific password, not your Apple ID password.

1. Sign in to <https://appleid.apple.com>.
2. Under **Sign-In and Security → App-Specific Passwords**, click **+**.
3. Label it "AOS Mail Notarization" (or anything memorable).
4. Apple generates a 16-character password. Copy it — Apple will not show it again.

### 6. Base64-encode the `.p12` for the GitHub secret

GitHub secrets cannot store binary, so encode the `.p12`:

```sh
base64 -i path/to/AOS-Mail-DeveloperID.p12 | pbcopy
```

The encoded blob is now on your clipboard.

### 7. Add the six secrets to GitHub

Go to <https://github.com/mrdulasolutions/AOS-Mail/settings/secrets/actions> and add **New repository secret** for each:

| Secret name                  | What it is                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded `.p12` of the Developer ID Application certificate.           |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting the `.p12` (set in step 3).                              |
| `APPLE_SIGNING_IDENTITY`     | The signing identity string, e.g. `Developer ID Application: Name (TEAMID)`. |
| `APPLE_ID`                   | Apple ID email used for notarization.                                        |
| `APPLE_PASSWORD`             | The app-specific password from step 5 (NOT your Apple ID password).          |
| `APPLE_TEAM_ID`              | 10-character team ID (e.g. `ABCDE12345`).                                    |

Plus the Tauri updater signing key (see "Updater key" below):

| Secret name                          | What it is                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | The private updater key file's contents (the entire base64 minisign blob). |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the key (optional — leave blank if key has no password).      |

`GITHUB_TOKEN` is provided automatically by GitHub Actions — you do not add it manually.

## Cutting a release

1. Bump the version in **all three** places so they match (Tauri reads from `tauri.conf.json` at bundle time, but keep them aligned for `npm version` / `cargo` semantics):
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
   git push origin v0.x.y
   ```
4. Watch the run under **Actions → Release** in GitHub. Both arch jobs must succeed.
5. Once the workflow completes, go to **Releases**. The new release will be in **Draft** status with the artifacts attached for both architectures:
   - `AOS Mail_<ver>_aarch64.dmg`
   - `AOS Mail_<ver>_aarch64.app.tar.gz` (+ `.sig`)
   - `AOS Mail_<ver>_x64.dmg`
   - `AOS Mail_<ver>_x64.app.tar.gz` (+ `.sig`)
   - `latest.json`
6. Sanity-check the release notes, edit if needed, then click **Publish release**. The auto-updater pulls `latest.json` from the `releases/latest/download/` URL declared in `tauri.conf.json`, so the moment you publish, all running clients on prior versions become eligible for the update.

### Verifying the .dmg

Download the `.dmg` from the draft release, mount it, and:

```sh
# Should show "accepted" (signed) and your team ID
codesign --verify --verbose=4 /Volumes/AOS\ Mail/AOS\ Mail.app
spctl --assess --type execute --verbose /Volumes/AOS\ Mail/AOS\ Mail.app
# Notarization staple check
xcrun stapler validate /Volumes/AOS\ Mail/AOS\ Mail.app
```

A signed-but-unnotarized build will pass `codesign` but fail `spctl --assess` and `stapler validate`. A signed-and-stapled build is the goal.

## Auto-update verification

To confirm an old build picks up a new one:

1. Build a "v0.0.0" version locally with `npm run tauri:build`. Install the resulting `.dmg`.
2. Cut a real release at `v0.0.1` (using the steps above) — push the tag, let the workflow finish, **publish the draft**.
3. Launch the v0.0.0 app. The Tauri updater plugin's check should fire on app start (or via the in-app **Check for Updates** menu item, depending on UI wiring).
4. Watch for the in-app update prompt. Accepting it triggers `downloadAndInstall()`, which streams the signed `.app.tar.gz`, verifies the `.sig` against the embedded public key, and stages the new bundle. The plugin then relaunches via `tauri-plugin-process`.
5. Verify the relaunched app reports `v0.0.1` in **About AOS Mail**.

For local testing without cutting a real release, you can lie to the updater by changing `version` in a built `Info.plist` (or by running with `TAURI_UPDATER_FORCE_CHECK=1` and pointing `endpoints` at a local file URL). Both approaches are documented in [Tauri's updater plugin docs](https://v2.tauri.app/plugin/updater/).

## Updater key

Auto-updates are signed with a Tauri minisign key pair, generated via the Tauri CLI. The **public key** is embedded in `tauri.conf.json` (`plugins.updater.pubkey`) and ships with every release; the **private key** is stored as a GitHub secret (`TAURI_SIGNING_PRIVATE_KEY`) and is used by the release workflow to sign the updater bundle.

### Where the private key lives

- **Canonical copy**: 1Password vault entry "AOS Mail — Tauri Updater Private Key". Both the key file contents AND the password (currently empty) live there.
- **GitHub repo**: as the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets.
- **Local filesystem (dev convenience)**: `~/.aos-mail-updater/private.key` on the maintainer's machine. This is `.gitignore`-protected by being outside the worktree. **Do not commit it** to the repo, ever.
- **Pubkey** (not secret): committed to `tauri.conf.json` so all clients can verify update signatures.

If the private key is ever pasted into the wrong place (Slack, a PR description, the renderer bundle), treat it as compromised and rotate immediately.

### Rotation

You should rotate the updater key in two scenarios:

1. **Compromise** — the private key was committed, leaked, or otherwise exposed.
2. **Routine hygiene** — every 2-3 years, or when handing off the project.

Rotation breaks auto-update for all clients on the OLD pubkey, so it is a coordinated step:

1. **Generate a new key pair**:
   ```sh
   npx @tauri-apps/cli signer generate --ci -w ~/.aos-mail-updater/new.key
   ```
   This produces `new.key` (private) and `new.key.pub` (public, base64 minisign blob).
2. **Update `tauri.conf.json`** — replace `plugins.updater.pubkey` with the contents of `new.key.pub`. Commit + push.
3. **Cut a release with the OLD key still active** (the existing `TAURI_SIGNING_PRIVATE_KEY` secret). Existing clients will pick this release up via the old pubkey baked into THEIR running build, but the NEW pubkey is now embedded in the binary they install.
4. **Swap GitHub secrets** to the new private key contents. Future releases sign with the new key, which the just-installed clients can now verify.
5. **Move the old key** to an "Archived" 1Password vault for one release cycle in case you need to publish a hotfix on the old chain. After the next release, delete it.

If you rotate without step 3 — i.e. you swap secrets first, then cut a release — every client on the previous version will fail to verify the next update and gracefully drop back to "no update available". They'll need a manual reinstall to recover, which is a bad UX. Don't skip step 3.

## Manual trigger (dry runs)

The workflow also supports `workflow_dispatch`, so you can run it from the **Actions → Release → Run workflow** button without pushing a tag. This is useful for testing the pipeline. When triggered manually without a tag, the workflow still builds but the release-upload step uses a placeholder version derived from `tauri.conf.json` and the artifacts land in a draft titled with the workflow run name rather than a tag name.

## Where artifacts land

- **GitHub Releases** at <https://github.com/mrdulasolutions/AOS-Mail/releases> — the canonical destination.
- The artifacts attached to each release are produced inside `src-tauri/target/<triple>/release/bundle/` on the runner; `tauri-action` uploads them automatically via `softprops/action-gh-release` under the hood.

## Troubleshooting

| Symptom                                        | Likely cause                                                                        | Fix                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codesign` step in CI says "no identity found" | `APPLE_CERTIFICATE` decoded but the keychain import failed — usually a bad password | Re-export the `.p12` with a known password, re-base64, update both `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD`                                                                                                                                   |
| Notarization step hangs for >10 min            | Apple's notary service is slow OR the bundle has unsigned binaries inside           | Check `xcrun notarytool log <submission-id>`. Common offender: an unsigned helper inside `Contents/Resources/`. Make sure the sidecar binary at `binaries/aos-mail-sidecar` was produced AFTER Rust release-mode strip — it should be signed transitively |
| Updater fails with "Invalid signature"         | `pubkey` in `tauri.conf.json` does not match `TAURI_SIGNING_PRIVATE_KEY`            | Regenerate the key, or copy the matching pubkey from `~/.aos-mail-updater/public.key` into `tauri.conf.json`                                                                                                                                              |
| Build skips updater bundle entirely            | `TAURI_SIGNING_PRIVATE_KEY` secret is missing or `plugins.updater.active = false`   | Add the secret in repo settings; ensure `tauri.conf.json` has `plugins.updater.active = true` and a non-empty `pubkey`                                                                                                                                    |
| Release shows up but `.dmg` is missing         | Build succeeded but artifact upload was skipped — usually a cancelled job           | Re-run the failing matrix job from the Actions UI; tauri-action will re-upload to the existing draft                                                                                                                                                      |
