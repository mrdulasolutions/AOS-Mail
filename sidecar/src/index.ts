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
import { registerGmailMethods } from "./methods/gmail.js";
import { registerAccountsMethods } from "./methods/accounts.js";
import { registerImapMethods } from "./methods/imap.js";
import { registerSyncMethods } from "./methods/sync.js";

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
registerGmailMethods();
registerAccountsMethods();
registerImapMethods();
registerSyncMethods();

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

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
