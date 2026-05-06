// Renderer <-> backend bridge.
//
// During the Electron era, `window.api.*` was injected by the preload script
// (src/preload/index.ts) and forwarded to the Electron main process via IPC.
// Under Tauri 2 + Node sidecar:
//
//     renderer  --invoke('sidecar_request', method, params)-->  Tauri (Rust)
//     Tauri     --NDJSON over stdio-->                          Node sidecar
//     sidecar   --NDJSON response-->                            Tauri
//     Tauri     --invoke result-->                              renderer
//
// And for server-sent updates:
//
//     sidecar   --notification (no id)-->                       Tauri
//     Tauri     --emit(channel, payload)-->                     renderer
//     renderer  listen(channel, cb)
//
// This module is the renderer-side surface for both directions. It exports a
// `bridge.call(method, params)` request/response helper and `bridge.listen(
// channel, cb)` for server-sent events.
//
// Lazy imports keep non-Tauri builds from pulling in @tauri-apps/api code.

type JSONValue =
  | null
  | string
  | number
  | boolean
  | JSONValue[]
  | { [k: string]: JSONValue };

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = <T>(channel: string, cb: (event: { payload: T }) => void) => Promise<() => void>;

let invokeImpl: Invoke | null = null;
let listenImpl: Listen | null = null;

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function loadInvoke(): Promise<Invoke | null> {
  if (invokeImpl) return invokeImpl;
  if (!isTauriEnv()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  invokeImpl = invoke;
  return invokeImpl;
}

async function loadListen(): Promise<Listen | null> {
  if (listenImpl) return listenImpl;
  if (!isTauriEnv()) return null;
  const { listen } = await import("@tauri-apps/api/event");
  // Adapter: keep our `{ payload: T }` shape stable regardless of @tauri-apps
  // internals. Tauri's listen returns an unlisten function.
  const adapted: Listen = async (channel, cb) =>
    await listen(channel, (e) => cb({ payload: e.payload as never }));
  listenImpl = adapted;
  return listenImpl;
}

export async function call<T = JSONValue>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const invoke = await loadInvoke();
  if (invoke) {
    const result = await invoke("sidecar_request", { method, params });
    return result as T;
  }
  throw new Error(
    `bridge.call(${method}) — not running under Tauri and no Electron shim registered`,
  );
}

/**
 * Subscribe to a server-sent event from the sidecar. The promise resolves to
 * an unsubscribe function. Outside Tauri, returns a noop unsubscribe so the
 * caller's cleanup code stays uniform.
 */
export async function listen<T = JSONValue>(
  channel: string,
  cb: (payload: T) => void,
): Promise<() => void> {
  const listenFn = await loadListen();
  if (!listenFn) return () => {};
  return await listenFn<T>(channel, ({ payload }) => cb(payload));
}

export const bridge = {
  call,
  listen,
  isTauri: isTauriEnv(),
  /** Smoke test that the Rust shell is reachable. */
  async ping(): Promise<string> {
    const invoke = await loadInvoke();
    if (!invoke) return "electron";
    return (await invoke("ping")) as string;
  },
};

export default bridge;
