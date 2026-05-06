// Tiny JSON-RPC 2.0 dispatcher for the sidecar.
//
// Designed for the Tauri shell's request/response pattern. Notifications
// (no `id`) are accepted but produce no response.

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

type Handler = (params: Json) => Promise<Json> | Json;

const methods = new Map<string, Handler>();

export function registerMethod(name: string, handler: Handler): void {
  if (methods.has(name)) {
    throw new Error(`RPC method already registered: ${name}`);
  }
  methods.set(name, handler);
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
