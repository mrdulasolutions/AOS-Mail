// AOS Mail sidecar entry point.
//
// Wire format (newline-delimited JSON over stdin/stdout):
//   request:      {"jsonrpc":"2.0","id":N,"method":"foo","params":{...}}
//   response:     {"jsonrpc":"2.0","id":N,"result":...}
//                 {"jsonrpc":"2.0","id":N,"error":{"code":N,"message":"..."}}
//   notification: {"jsonrpc":"2.0","method":"channel","params":...}   (no id)
//
// As main-process services get lifted from src/main into this sidecar, they
// register handlers via `registerMethod` and push events via `emit`.

import { createInterface } from "node:readline";
import { dispatch, isStdoutBroken, registerMethod } from "./rpc.js";
import { awaitAll as drainBackgroundTasks } from "./lib/background-tasks.js";
import { createLogger } from "./lib/logger.js";

// Global error trap. Without this, an unhandled promise rejection silently
// kills the process (Node 15+ default), producing the renderer-side
// "sidecar channel closed before response" with no diagnostic. Logging
// here lands the cause in the daily log file so we can recover the chain.
//
// CRITICAL: when the cause is EPIPE on stdout (the parent disconnected),
// the sidecar should EXIT GRACEFULLY rather than try to keep working —
// without an exit, fire-and-forget emit() calls keep throwing, recursing
// into this handler and writing GBs of noise to the log. The
// post-mortem 2026-05-08 bug exactly this. We trip the rpc module's
// `stdoutBroken` flag and gracefulExit instead.
const bootLog = createLogger("sidecar-boot");
let exitingDueToBrokenPipe = false;
function isEpipeError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as { code?: unknown; message?: unknown };
  if (obj.code === "EPIPE" || obj.code === "ERR_STREAM_DESTROYED") return true;
  if (typeof obj.message === "string" && /\bEPIPE\b|broken pipe/i.test(obj.message)) {
    return true;
  }
  return false;
}
function handleHostDisconnected(reason: unknown): void {
  if (exitingDueToBrokenPipe) return;
  exitingDueToBrokenPipe = true;
  bootLog.warn("sidecar: stdout disconnected (EPIPE), exiting gracefully", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
  void gracefulExit();
}
process.on("unhandledRejection", (reason) => {
  if (isEpipeError(reason) || isStdoutBroken()) {
    handleHostDisconnected(reason);
    return;
  }
  bootLog.error("unhandledRejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
process.on("uncaughtException", (err) => {
  if (isEpipeError(err) || isStdoutBroken()) {
    handleHostDisconnected(err);
    return;
  }
  bootLog.error("uncaughtException", { err: err.message, stack: err.stack });
});

// Attach error listeners directly to the stdio streams. Node's default
// behavior for an unhandled 'error' event on a stream is to escalate to
// uncaughtException — we want to absorb the EPIPE locally instead, so we
// don't pay the cost of trip-the-handler / log / risk-recursion every
// time. If stdout / stderr breaks, the parent has disconnected; treat it
// the same as a SIGTERM.
process.stdout.on("error", (err) => {
  if (isEpipeError(err)) {
    handleHostDisconnected(err);
  }
});
process.stderr.on("error", (err) => {
  if (isEpipeError(err)) {
    handleHostDisconnected(err);
  }
});
import { registerNetworkMethods } from "./methods/network.js";
import { registerDbMethods } from "./methods/db.js";
import { registerThemeMethods } from "./methods/theme.js";
import { registerUsageMethods } from "./methods/usage.js";
import { registerSnippetsMethods } from "./methods/snippets.js";
import { registerSplitsMethods } from "./methods/splits.js";
import { registerSnoozeMethods } from "./methods/snooze.js";
import { registerSenderMethods } from "./methods/sender.js";
import { registerSearchMethods } from "./methods/search.js";
import { registerAnthropicMethods } from "./methods/anthropic.js";
import { registerOpenRouterMethods } from "./methods/openrouter.js";
import { registerGmailMethods } from "./methods/gmail.js";
import { registerAccountsMethods } from "./methods/accounts.js";
import { registerImapMethods } from "./methods/imap.js";
import { registerSyncMethods } from "./methods/sync.js";
import { registerComposeMethods } from "./methods/compose.js";
import { registerEmailsMethods } from "./methods/emails.js";
import { registerAnalysisMethods } from "./methods/analysis.js";
import { registerArchiveReadyMethods } from "./methods/archive-ready.js";
import { registerDraftsMethods } from "./methods/drafts.js";
import { registerMemoryMethods } from "./methods/memory.js";
import { registerLearnedRulesMethods } from "./methods/learned-rules.js";
import { registerSettingsMethods } from "./methods/settings.js";
import { registerSummaryMethods } from "./methods/summary.js";
import { registerCalendarMethods } from "./methods/calendar.js";
import { registerExtensionsMethods } from "./methods/extensions.js";
import { registerAwaitingReplyMethods } from "./methods/awaiting-reply.js";
import { registerDiagnosticsMethods } from "./methods/diagnostics.js";
import { registerSecretsMethods } from "./methods/secrets.js";
import { registerBriefingMethods } from "./methods/briefing.js";
import { registerPermissionsMethods } from "./methods/permissions.js";

// Built-in: pipe smoke test.
registerMethod("ping", async () => ({
  ok: true,
  pid: process.pid,
  node: process.version,
  ts: new Date().toISOString(),
}));

// Lifted IPC namespaces (Phase 1B).
registerNetworkMethods();
registerDbMethods();
registerThemeMethods();
registerUsageMethods();
registerSnippetsMethods();
registerSplitsMethods();
registerSnoozeMethods();
registerSenderMethods();
registerSearchMethods();
registerAnthropicMethods();
registerOpenRouterMethods();
registerGmailMethods();
registerAccountsMethods();
registerImapMethods();
registerSyncMethods();
registerComposeMethods();
registerEmailsMethods();
registerAnalysisMethods();
registerArchiveReadyMethods();
registerDraftsMethods();
registerMemoryMethods();
registerLearnedRulesMethods();
registerSettingsMethods();
registerSummaryMethods();
registerCalendarMethods();
registerExtensionsMethods();
registerAwaitingReplyMethods();
registerDiagnosticsMethods();
registerSecretsMethods();
registerBriefingMethods();
registerPermissionsMethods();

// stdio loop.
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const response = await dispatch(trimmed);
  if (response !== null) {
    // Safe write: if the parent has disconnected we drop the response
    // rather than throw EPIPE and recurse into the unhandled handler.
    // The handleHostDisconnected path below kicks the sidecar into
    // gracefulExit so we don't keep doing fruitless work.
    try {
      process.stdout.write(response + "\n");
    } catch (err) {
      handleHostDisconnected(err);
    }
  }
});

// Graceful shutdown — drain in-flight background tasks (Claude classify
// calls from learned-rules, etc.) before the process exits. Without this,
// fire-and-forget IPC handlers can lose work the user expects to land.
// See lib/background-tasks.ts and post-mortem P3 #18.
async function gracefulExit(): Promise<void> {
  try {
    await drainBackgroundTasks(3_000);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => {
  bootLog.info("sidecar: SIGINT, draining background tasks then exiting");
  void gracefulExit();
});
process.on("SIGTERM", () => {
  bootLog.info("sidecar: SIGTERM, draining background tasks then exiting");
  void gracefulExit();
});
// stdin closing means the host process (Tauri / test harness) is gone. Same
// shutdown semantics as SIGTERM — flush, then exit.
process.stdin.on("end", () => {
  bootLog.info("sidecar: stdin end, draining background tasks then exiting");
  void gracefulExit();
});

// Confirms the sidecar reached the bottom of bootstrap. If the sidecar dies
// before this line lands in the log, the crash is a module-load issue (or
// happens during one of the registerMethod calls above). This is the
// canary log entry to look for after a "sidecar channel closed" complaint.
bootLog.info("sidecar: ready, listening on stdin");
