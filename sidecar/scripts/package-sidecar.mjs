// Package the built sidecar bundle into a single platform-tagged binary that
// Tauri can ship as `binaries/aos-mail-sidecar-<target-triple>`.
//
// Tauri's externalBin convention: the binary basename is what we declare in
// tauri.conf.json (e.g. "aos-mail-sidecar"); at build time Tauri looks for
// `<basename>-<target-triple>` (e.g. "aos-mail-sidecar-aarch64-apple-darwin").
//
// We ship the sidecar as the bundled Node ESM file plus a small shell stub
// that invokes `node` against it. For real distribution we'll switch to a
// fully-bundled Node-based binary (e.g. via @yao-pkg/pkg or sea), but the
// stub form keeps Phase 1 unblocked while we wire up the rest of the system.

import { mkdirSync, copyFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
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
  const bundleName = `aos-mail-sidecar-${triple}.js`;
  const stubName = `aos-mail-sidecar-${triple}`;
  const bundleDest = resolve(TAURI_BIN_DIR, bundleName);
  const stubDest = resolve(TAURI_BIN_DIR, stubName);
  copyFileSync(dist, bundleDest);
  // Shell stub: locate the bundled JS next to ourselves and exec node.
  const stub = `#!/usr/bin/env bash\nset -euo pipefail\nDIR="$(cd "$(dirname "$0")" && pwd)"\nexec node "$DIR/${bundleName}" "$@"\n`;
  writeFileSync(stubDest, stub);
  chmodSync(stubDest, 0o755);
  console.log(`packaged sidecar -> ${stubDest}`);
}

main();
