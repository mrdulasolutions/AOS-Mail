// Package the built sidecar bundle into a single platform-tagged binary that
// Tauri can ship as `binaries/aos-mail-sidecar-<target-triple>`.
//
// Tauri's externalBin convention: the binary basename is what we declare in
// tauri.conf.json (e.g. "aos-mail-sidecar"); at build time Tauri looks for
// `<basename>-<target-triple>` (e.g. "aos-mail-sidecar-aarch64-apple-darwin").
//
// In dev mode Tauri copies ONLY the named binary into target/debug, not any
// sibling files. So a stub that does `node ./bundle.js` breaks the moment
// Tauri relocates it. We work around this by inlining the bundled ESM into
// a self-contained bash script via a quoted heredoc, piped to `node
// --input-type=module -`. Result: a single self-sufficient executable.
//
// For production we'll graduate to Node SEA or @yao-pkg/pkg; for V1 dev this
// keeps the iteration loop fast without a second toolchain in the build.

import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TAURI_BIN_DIR = resolve(ROOT, "..", "src-tauri", "binaries");

function rustTargetTriple() {
  // Derive from `rustc -vV` so we match Tauri's conventions exactly.
  const out = execSync("rustc -vV").toString();
  const match = out.match(/host:\s*(\S+)/);
  if (!match) throw new Error("could not parse rustc target triple");
  return match[1];
}

function main() {
  const dist = resolve(ROOT, "dist", "index.cjs");
  if (!existsSync(dist)) {
    throw new Error(`sidecar build missing: ${dist} — run \`npm run build\` first`);
  }
  mkdirSync(TAURI_BIN_DIR, { recursive: true });
  const triple = rustTargetTriple();
  const stubName = `aos-mail-sidecar-${triple}`;
  const stubDest = resolve(TAURI_BIN_DIR, stubName);

  const bundle = readFileSync(dist, "utf8");

  // Self-extracting bash stub:
  //  1) Write the inlined ESM bundle to a temp .mjs file (one per stub
  //     invocation, deleted via trap on exit).
  //  2) Exec node against that temp file, leaving stdin/stdout free for the
  //     sidecar's own JSON-RPC traffic.
  //
  // Why not a heredoc-fed `node --input-type=module -`? That feeds the bundle
  // through stdin, which means the sidecar's own stdin is consumed before any
  // code runs — RPC requests never arrive. Self-extracting keeps stdio clean.
  //
  // Pick a delimiter that doesn't appear in the bundle so the heredoc is
  // robust regardless of bundle contents.
  let n = 0;
  let delim = "AOS_SIDECAR_EOF_0";
  while (bundle.includes(delim)) {
    n++;
    delim = `AOS_SIDECAR_EOF_${n}`;
  }

  // The sidecar bundle is bare ESM — esbuild leaves better-sqlite3 (and any
  // other native module flagged --external:*) as a runtime require/import.
  // Node resolves those by walking up from the script location (a tmpfile),
  // which can't see sidecar/node_modules. We bake the sidecar's
  // node_modules absolute path into NODE_PATH at package time so dev runs
  // work without the user setting anything. (Production will switch to
  // Node SEA or pkg so we don't depend on this path existing.)
  const sidecarNodeModules = resolve(ROOT, "node_modules");

  // Resolve `node` at sidecar-launch time. macOS apps launched from Finder /
  // Dock / Spotlight inherit launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:
  // /sbin`), which does NOT include /usr/local/bin or /opt/homebrew/bin where
  // node typically lives. Without this, `exec node` fails with
  // "node: not found" before the bundled JS even loads, the bash stub exits,
  // and Tauri sees the sidecar terminate immediately — surfacing as
  // "sidecar channel closed before response" on every RPC.
  //
  // We probe the common Homebrew / nvm / system install paths in priority
  // order, then fall back to whatever `command -v node` finds (which uses
  // the inherited PATH and only matters when the user launched from a
  // terminal). If nothing's found, we print an actionable error to stderr
  // (visible in `~/Library/Application Support/AOS Mail/sidecar.log`-adjacent
  // logging or in the Tauri shell's debug log) and exit non-zero, which is
  // strictly better than dying silently.
  const nodeLookup = `
NODE_BIN=""
for cand in \\
  /opt/homebrew/bin/node \\
  /usr/local/bin/node \\
  /opt/local/bin/node \\
  /usr/bin/node; do
  if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
done
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  for cand in $(ls -t "$HOME/.nvm/versions/node" 2>/dev/null); do
    if [ -x "$HOME/.nvm/versions/node/$cand/bin/node" ]; then
      NODE_BIN="$HOME/.nvm/versions/node/$cand/bin/node"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  fallback="$(command -v node 2>/dev/null || true)"
  if [ -n "$fallback" ] && [ -x "$fallback" ]; then NODE_BIN="$fallback"; fi
fi
if [ -z "$NODE_BIN" ]; then
  cat >&2 <<'NODE_NOT_FOUND_EOF'
AOS Mail: Node.js (v20+) not found.

The sidecar process needs Node.js to run. We searched:
  /opt/homebrew/bin/node, /usr/local/bin/node,
  /opt/local/bin/node, /usr/bin/node, ~/.nvm/versions/node/*

None of those contained an executable. Please install Node.js from
https://nodejs.org/ (the LTS installer puts it in /usr/local/bin/node)
and re-launch AOS Mail.
NODE_NOT_FOUND_EOF
  exit 127
fi
`.trim();

  const stub =
    `#!/usr/bin/env bash\n` +
    `set -euo pipefail\n` +
    `export NODE_PATH=${JSON.stringify(sidecarNodeModules)}\${NODE_PATH:+:$NODE_PATH}\n` +
    nodeLookup +
    `\n` +
    `TMP="$(mktemp -t aos-mail-sidecar.XXXXXX).cjs"\n` +
    `trap 'rm -f "$TMP"' EXIT\n` +
    `cat > "$TMP" <<'${delim}'\n` +
    bundle +
    (bundle.endsWith("\n") ? "" : "\n") +
    `${delim}\n` +
    `exec "$NODE_BIN" "$TMP" "$@"\n`;

  writeFileSync(stubDest, stub);
  chmodSync(stubDest, 0o755);
  console.log(`packaged sidecar -> ${stubDest} (${bundle.length} bytes inlined)`);
}

main();
