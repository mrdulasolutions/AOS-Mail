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
import { dispatch, registerMethod } from "./rpc.js";
import { awaitAll as drainBackgroundTasks } from "./lib/background-tasks.js";
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
    process.stdout.write(response + "\n");
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
  void gracefulExit();
});
process.on("SIGTERM", () => {
  void gracefulExit();
});
// stdin closing means the host process (Tauri / test harness) is gone. Same
// shutdown semantics as SIGTERM — flush, then exit.
process.stdin.on("end", () => {
  void gracefulExit();
});
