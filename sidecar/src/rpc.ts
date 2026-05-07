// Tiny JSON-RPC 2.0 dispatcher for the sidecar.
//
// Two flavors of message:
//   - REQUEST  (has `id`)            → response goes back with the same id
//   - RESPONSE (we send back)        → matched on the Rust side by id
//   - NOTIFICATION (no `id`)         → server-sent event; the Rust shell
//                                      forwards it to the renderer as a
//                                      Tauri event named after `method`.
//
// Designed for the Tauri shell's request/response pattern plus push-style
// updates. Callers use `registerMethod` for handlers, `emit(channel, payload)`
// for notifications.
//
// `registerMethod` is overloaded against SidecarMethods (the shared contract
// in src/shared/sidecar-contract.ts). Methods listed there get a typed
// handler signature; anything else falls through to the loose `Json -> Json`
// form. New methods should be added to the contract first, so the renderer's
// bridge.call sites stay typed end-to-end.

import type {
  SidecarMethodName,
  SidecarMethodParams,
  SidecarMethodResult,
} from "../../src/shared/sidecar-contract.js";

type Json = unknown;

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: Json;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Json;
  error?: { code: number; message: string; data?: Json };
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Json;
}

type Handler = (params: Json) => Promise<Json> | Json;

const methods = new Map<string, Handler>();

// Typed overload: methods listed in SidecarMethods get a signature pinned
// to the contract — handler must accept the contract's params type and
// return the contract's result type. Anything else falls through to the
// loose Handler form so methods that haven't been added to the contract
// keep working.
export function registerMethod<K extends SidecarMethodName>(
  name: K,
  handler: (
    params: SidecarMethodParams<K>,
  ) => SidecarMethodResult<K> | Promise<SidecarMethodResult<K>>,
): void;
export function registerMethod(name: string, handler: Handler): void;
export function registerMethod(name: string, handler: Handler): void {
  if (methods.has(name)) {
    throw new Error(`RPC method already registered: ${name}`);
  }
  methods.set(name, handler);
}

/**
 * Push a server-sent event up to the Tauri shell, which forwards it to the
 * renderer as a Tauri event. `channel` is the event name (e.g.
 * "network:online"). Notifications have no id so the Rust side knows it's
 * not a response to any pending request.
 */
export function emit(channel: string, payload: Json = null): void {
  const notification: RpcNotification = {
    jsonrpc: "2.0",
    method: channel,
    params: payload,
  };
  process.stdout.write(JSON.stringify(notification) + "\n");
}

export async function dispatch(rawLine: string): Promise<string | null> {
  let req: RpcRequest;
  try {
    req = JSON.parse(rawLine) as RpcRequest;
  } catch {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    } satisfies RpcResponse);
  }

  const id = req.id ?? null;
  const handler = methods.get(req.method);
  if (!handler) {
    if (id === null) return null;
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    } satisfies RpcResponse);
  }

  try {
    const result = await handler(req.params);
    if (id === null) return null;
    return JSON.stringify({ jsonrpc: "2.0", id, result } satisfies RpcResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (id === null) return null;
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message },
    } satisfies RpcResponse);
  }
}

export function listMethods(): string[] {
  return [...methods.keys()].sort();
}
