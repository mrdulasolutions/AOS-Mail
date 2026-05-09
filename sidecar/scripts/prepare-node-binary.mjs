// Prepare the bundled `aos-mail-node` binary that ships inside the .app's
// Contents/MacOS/. We pull the user's system node, slim it to the build's
// target architecture, and stage it where Tauri's externalBin convention
// expects it.
//
// Why bundle node at all: macOS apps launched from Finder/Dock/Spotlight
// inherit launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which
// has no /opt/homebrew/bin or /usr/local/bin where node typically lives.
// And many users don't have Node.js installed at all — it's a dev tool.
// Shipping it inside the .app removes node from the runtime requirements.
//
// The binary lands at:
//   src-tauri/binaries/aos-mail-node-<rust-target-triple>
// which Tauri copies into:
//   AOS Mail.app/Contents/MacOS/aos-mail-node
// at build time. The bash stub finds it as a sibling.
//
// Why it's not committed: ~119 MB exceeds GitHub's 100 MB per-file ceiling
// (and Git LFS is a heavier dep than just regenerating it from local node).

import { existsSync, statSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const TAURI_BIN_DIR = resolve(ROOT, "src-tauri", "binaries");

function rustTargetTriple() {
  const out = execSync("rustc -vV").toString();
  const match = out.match(/host:\s*(\S+)/);
  if (!match) throw new Error("could not parse rustc target triple");
  return match[1];
}

function findSystemNode() {
  const candidates = [
    process.env.AOS_BUNDLED_NODE,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/opt/local/bin/node",
  ].filter(Boolean);
  for (const cand of candidates) {
    if (existsSync(cand)) {
      try {
        statSync(cand); // confirm it's accessible
        return cand;
      } catch {
        // skip
      }
    }
  }
  // Try `which`
  try {
    const which = execSync("command -v node").toString().trim();
    if (which) return which;
  } catch {
    // none found
  }
  throw new Error(
    "Could not find a system `node` to bundle. Install Node.js 20+ from " +
      "https://nodejs.org/ or set AOS_BUNDLED_NODE=/path/to/node before building.",
  );
}

function archForTriple(triple) {
  if (triple.startsWith("aarch64")) return "arm64";
  if (triple.startsWith("x86_64")) return "x86_64";
  throw new Error(`Unrecognized rustc target triple: ${triple}`);
}

function main() {
  const triple = rustTargetTriple();
  const arch = archForTriple(triple);
  const dest = resolve(TAURI_BIN_DIR, `aos-mail-node-${triple}`);
  const sysNode = findSystemNode();

  // node binaries from nodejs.org are universal (x86_64 + arm64). On the build
  // machine we lipo down to the single slice the .app targets, which roughly
  // halves the bundled size.
  console.log(`source: ${sysNode}`);
  console.log(`target arch: ${arch} (rustc triple ${triple})`);

  const fileOut = execSync(`file "${sysNode}"`).toString();
  if (fileOut.includes("universal binary")) {
    execSync(`lipo "${sysNode}" -thin ${arch} -output "${dest}"`);
  } else {
    // Already thin — just copy.
    copyFileSync(sysNode, dest);
  }

  // Strip whatever signature came from Node Foundation; Tauri will re-sign
  // with our Developer ID at bundle time.
  try {
    execSync(`codesign --remove-signature "${dest}"`, { stdio: "ignore" });
  } catch {
    // already unsigned — fine
  }
  execSync(`chmod +x "${dest}"`);

  const size = (statSync(dest).size / 1024 / 1024).toFixed(1);
  console.log(`prepared bundled node -> ${dest} (${size} MB)`);
}

main();
