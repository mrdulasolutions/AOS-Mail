// Copy ONLY the node_modules that the bundled sidecar needs at runtime into
// sidecar/runtime-modules/. Tauri's bundle.resources then ships that
// directory inside the .app at Contents/Resources/runtime-modules, and the
// bash stub points NODE_PATH at it. This is what makes the .app self-
// sufficient on a fresh Mac that doesn't have AOS Mail's source tree (and
// might not have node_modules anywhere).
//
// Why these three:
//
//   - better-sqlite3   — externalized by esbuild because it has a native
//                        .node file that can't be inlined into JS.
//   - bindings         — better-sqlite3's runtime dep (locates the .node
//                        file).
//   - file-uri-to-path — bindings' runtime dep.
//
// Every other dep (anthropic, googleapis, imapflow, mailparser, nodemailer)
// is pure JS and gets baked into dist/index.cjs by esbuild — it never reads
// from node_modules at runtime.
//
// Each package is copied with its .node binary, its lib/index.js, and its
// package.json — but NOT its src/, deps/ (the upstream sqlite3 source),
// tests/, or build artifacts other than build/Release. This trims
// better-sqlite3 from ~30MB down to ~2MB.

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "node_modules");
const DEST = resolve(ROOT, "runtime-modules");

const RUNTIME_PACKAGES = ["better-sqlite3", "bindings", "file-uri-to-path"];

// Within better-sqlite3, copy only what's loaded at runtime:
//   lib/                     JS entrypoint + helpers (~50KB)
//   build/Release/*.node     compiled native binding (~2MB)
//   package.json             needed for require() to find lib/index.js
//
// Skip:
//   src/ deps/               the upstream SQLite C source (~50MB)
//   binding.gyp build/Makefile etc. — only used by node-gyp at install
//   docs, README, LICENSE    optional but small enough to keep
const BETTER_SQLITE3_KEEP = new Set(["lib", "build", "package.json", "LICENSE", "README.md"]);
const BETTER_SQLITE3_BUILD_KEEP = new Set(["Release"]);
const BETTER_SQLITE3_BUILD_RELEASE_KEEP_EXT = new Set([".node"]);

function copyDir(src, dest, filter) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const rel = relative(src, srcPath);
    if (filter && !filter(entry, srcPath, rel)) continue;
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyDir(srcPath, destPath, filter);
    } else if (st.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}

function clean() {
  if (existsSync(DEST)) {
    rmSync(DEST, { recursive: true, force: true });
  }
  mkdirSync(DEST, { recursive: true });
}

function copyBetterSqlite3() {
  const src = join(SRC, "better-sqlite3");
  const dest = join(DEST, "better-sqlite3");
  if (!existsSync(src)) {
    throw new Error(`better-sqlite3 not found at ${src} — run \`npm install\` in sidecar/`);
  }
  // Top-level filter: keep only the entries we listed.
  copyDir(src, dest, (entry, srcPath) => {
    const top = relative(src, srcPath).split("/")[0];
    if (top === "build") {
      // Inside build/, only keep Release/.
      const inBuild = relative(join(src, "build"), srcPath);
      if (inBuild === "" || inBuild === "Release") return true;
      const insideRelease = inBuild.startsWith("Release");
      if (insideRelease) {
        // Inside Release/, only keep .node files (and the dir itself).
        if (statSync(srcPath).isDirectory()) return true;
        return BETTER_SQLITE3_BUILD_RELEASE_KEEP_EXT.has(
          entry.includes(".") ? entry.slice(entry.lastIndexOf(".")) : "",
        );
      }
      return false;
    }
    return BETTER_SQLITE3_KEEP.has(top);
  });
}

function copyWholePackage(name) {
  const src = join(SRC, name);
  const dest = join(DEST, name);
  if (!existsSync(src)) {
    throw new Error(`${name} not found at ${src} — run \`npm install\` in sidecar/`);
  }
  copyDir(src, dest);
}

function summarize() {
  // Compute size + emit a manifest so the build is auditable.
  let totalBytes = 0;
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        totalBytes += st.size;
        files.push({ path: relative(DEST, p), size: st.size });
      }
    }
  }
  walk(DEST);
  const mb = (totalBytes / 1024 / 1024).toFixed(1);
  console.log(`runtime-modules/ contains ${files.length} files, ${mb} MB total`);
}

// Re-sign every .node file with our Developer ID + hardened runtime + secure
// timestamp. Apple's notarization rejects any Mach-O binary inside the .app
// that isn't signed with the same Developer ID — and Tauri's auto-signing
// only walks Contents/MacOS/, NOT Contents/Resources/, so we have to do it
// ourselves before Tauri bundles the resources.
//
// Skipped silently if SIGNING_IDENTITY isn't set (dev build / CI without
// notarization). Production builds invoke this with the identity from
// tauri.conf.json.
function findNodeFiles(dir) {
  const out = [];
  function walk(d) {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (entry.endsWith(".node")) out.push(p);
    }
  }
  walk(dir);
  return out;
}

function readSigningIdentityFromTauriConf() {
  try {
    const conf = JSON.parse(
      readFileSync(resolve(ROOT, "..", "src-tauri", "tauri.conf.json"), "utf8"),
    );
    return conf?.bundle?.macOS?.signingIdentity ?? null;
  } catch {
    return null;
  }
}

function signNodeBinaries() {
  const identity = process.env.SIGNING_IDENTITY ?? readSigningIdentityFromTauriConf();
  if (!identity) {
    console.log("(no signing identity available — skipping .node signing)");
    return;
  }
  const nodeFiles = findNodeFiles(DEST);
  if (nodeFiles.length === 0) return;
  // In CI, the tauri.conf.json identity is resolved but the matching cert
  // isn't in the keychain until tauri-action imports it — and that happens
  // in a later workflow step than this one. Same applies to local dev
  // contributors who don't have the production cert installed. In both
  // cases we'd rather emit the unsigned .node files and let notarization
  // (if enabled) flag it loudly than abort the whole build here.
  let signed = 0;
  let skipped = 0;
  for (const f of nodeFiles) {
    try {
      // --force replaces whatever signature node-gyp / prebuild-install added
      // (typically ad-hoc). --options runtime opts into hardened runtime.
      // --timestamp adds Apple's secure timestamp, required for notarization.
      execSync(
        `codesign --sign ${JSON.stringify(identity)} --options runtime --timestamp --force ${JSON.stringify(f)}`,
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      console.log(`signed: ${relative(DEST, f)}`);
      signed += 1;
    } catch (err) {
      const msg = (err?.stderr?.toString?.() || err?.message || String(err)).trim();
      console.warn(`could not sign ${relative(DEST, f)} (${msg.split("\n")[0]}) — leaving unsigned`);
      skipped += 1;
    }
  }
  if (skipped > 0) {
    console.warn(
      `${skipped} .node file(s) left unsigned. Acceptable for unsigned/dev builds; ` +
        "notarization will reject them — sign explicitly after tauri-action imports the cert.",
    );
  }
}

function main() {
  clean();
  copyBetterSqlite3();
  copyWholePackage("bindings");
  copyWholePackage("file-uri-to-path");
  summarize();
  signNodeBinaries();
  console.log(`copied -> ${DEST}`);
}

main();
