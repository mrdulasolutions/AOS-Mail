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
  const dist = resolve(ROOT, "dist", "index.js");
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

  const stub =
    `#!/usr/bin/env bash\n` +
    `set -euo pipefail\n` +
    `TMP="$(mktemp -t aos-mail-sidecar.XXXXXX).mjs"\n` +
    `trap 'rm -f "$TMP"' EXIT\n` +
    `cat > "$TMP" <<'${delim}'\n` +
    bundle +
    (bundle.endsWith("\n") ? "" : "\n") +
    `${delim}\n` +
    `exec node "$TMP" "$@"\n`;

  writeFileSync(stubDest, stub);
  chmodSync(stubDest, 0o755);
  console.log(`packaged sidecar -> ${stubDest} (${bundle.length} bytes inlined)`);
}

main();
