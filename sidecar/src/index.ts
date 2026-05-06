// AOS Mail sidecar entry point.
//
// Stage 1 of the migration: stdio JSON-RPC server that the Tauri Rust shell
// spawns and talks to. Methods are registered in `methods/` and dispatched
// here.
//
// Wire format (newline-delimited JSON over stdin/stdout):
//   request:  {"jsonrpc":"2.0","id":N,"method":"foo","params":{...}}
//   response: {"jsonrpc":"2.0","id":N,"result":...}
//             {"jsonrpc":"2.0","id":N,"error":{"code":N,"message":"..."}}
//
// As main-process services get lifted from src/main into this sidecar, they
// register handlers via `registerMethod`. We start with `ping` to validate the
// pipe end-to-end.

import { createInterface } from "node:readline";
import { dispatch, registerMethod } from "./rpc.js";

// Built-in: pipe smoke test.
registerMethod("ping", async () => ({
  ok: true,
  pid: process.pid,
  node: process.version,
  ts: new Date().toISOString(),
}));

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

// Stage-2 lifts will register additional methods here. Examples (TBD):
//   registerMethod("mail.list", listMail);
//   registerMethod("mail.send", sendMail);
//   registerMethod("agent.draft", draftReply);
//   registerMethod("settings.get", getSettings);
