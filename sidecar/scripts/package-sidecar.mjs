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

  // The sidecar bundle is bare CJS — esbuild leaves better-sqlite3 as a
  // runtime require because it has a native .node file that can't be inlined.
  // Node resolves it by walking up from the script location (a tmpfile),
  // which can't see anything useful. So we set NODE_PATH explicitly:
  //
  //   - In production (.app bundle): Contents/Resources/runtime-modules/,
  //     which is populated by sidecar/scripts/copy-runtime-modules.mjs
  //     and includes better-sqlite3 + bindings + file-uri-to-path (~2 MB).
  //
  //   - In dev (Tauri spawns the binary directly from
  //     src-tauri/binaries/<file>): falls back to the dev-machine's
  //     sidecar/node_modules so iteration stays fast.
  //
  // Both paths are checked at runtime; production hits the bundled one.
  const sidecarNodeModulesDev = resolve(ROOT, "node_modules");

  // Resolve `node` at sidecar-launch time. macOS apps launched from Finder /
  // Dock / Spotlight inherit launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:
  // /sbin`) which does NOT include any location where Homebrew, nvm, or the
  // standard Node.js installer place `node`. Worse, many users don't have
  // Node.js installed at all — it's a dev tool, not a system runtime.
  //
  // The fix: ship `node` itself inside the .app bundle. Tauri externalBin
  // copies `binaries/aos-mail-node` into Contents/MacOS/aos-mail-node at
  // build time, signs it with our Developer ID, notarizes it as part of
  // the .app, and the bash stub finds it as a sibling at
  // \$(dirname "\$0")/aos-mail-node. No PATH games. No "is node installed?".
  // No platform variation. Same code path on every Mac.
  //
  // The fallback paths (Homebrew, system install, nvm, \$PATH) only run in
  // dev mode where Tauri spawns the sidecar from
  // src-tauri/binaries/<file> directly without copying it into a .app
  // — there's no sibling there. Those probes existed before we bundled
  // node and are kept for the dev-mode path; they are NOT what production
  // users hit.
  const nodeLookup = `
SIDECAR_DIR="\${BASH_SOURCE[0]:-$0}"
SIDECAR_DIR="$(cd "$(dirname "$SIDECAR_DIR")" && pwd)"
BUNDLED_NODE="$SIDECAR_DIR/aos-mail-node"
NODE_BIN=""
if [ -x "$BUNDLED_NODE" ]; then
  NODE_BIN="$BUNDLED_NODE"
fi
if [ -z "$NODE_BIN" ]; then
  for cand in \\
    /opt/homebrew/bin/node \\
    /usr/local/bin/node \\
    /opt/local/bin/node \\
    /usr/bin/node; do
    if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
  done
fi
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
AOS Mail: failed to locate the bundled Node.js binary at
"$SIDECAR_DIR/aos-mail-node". This indicates a broken install — try
reinstalling AOS Mail from https://github.com/mrdulasolutions/AOS-Mail/releases.
NODE_NOT_FOUND_EOF
  exit 127
fi
`.trim();

  // NODE_PATH resolution: prefer the bundled Resources/runtime-modules
  // (production), fall back to the dev sidecar/node_modules (dev mode).
  const nodePathLookup = `
BUNDLED_MODULES="$SIDECAR_DIR/../Resources/runtime-modules"
if [ -d "$BUNDLED_MODULES" ]; then
  export NODE_PATH="$BUNDLED_MODULES\${NODE_PATH:+:$NODE_PATH}"
else
  export NODE_PATH=${JSON.stringify(sidecarNodeModulesDev)}\${NODE_PATH:+:$NODE_PATH}
fi
`.trim();

  const stub =
    `#!/usr/bin/env bash\n` +
    `set -euo pipefail\n` +
    nodeLookup +
    `\n` +
    nodePathLookup +
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
