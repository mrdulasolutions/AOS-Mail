// Renderer <-> backend bridge.
//
// During the Electron era, `window.api.*` was injected by the preload script
// (src/preload/index.ts) and forwarded to the Electron main process via IPC.
// We are migrating to Tauri 2 + Node sidecar:
//
//     renderer  --invoke('sidecar_request', method, params)-->  Tauri (Rust)
//     Tauri     --NDJSON over stdio-->                          Node sidecar
//     sidecar   --NDJSON response-->                            Tauri
//     Tauri     --invoke result-->                              renderer
//
// This module is the renderer-side surface for that pipeline. It exports a
// `bridge.call(method, params)` helper plus typed namespaces (mail, agent,
// settings, etc.) that mirror the shape the existing components expect.
//
// During the migration, when running under Electron, we fall back to the old
// `window.api` so existing components keep working without modification.

type JSONValue =
  | null
  | string
  | number
  | boolean
  | JSONValue[]
  | { [k: string]: JSONValue };

let invokeImpl: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function loadInvoke() {
  if (invokeImpl) return invokeImpl;
  if (!isTauriEnv()) return null;
  // Lazy import so non-Tauri builds don't pull in the @tauri-apps/api code.
  const { invoke } = await import("@tauri-apps/api/core");
  invokeImpl = invoke;
  return invokeImpl;
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
  // Electron fallback during migration.
  // Existing renderer components dispatch to `window.api.<ns>.<fn>(args)`
  // directly. Callers who use `bridge.call()` instead must pass a method name
  // that maps to a hand-written shim here. We start empty; expand as services
  // get lifted into the sidecar.
  throw new Error(
    `bridge.call(${method}) — not running under Tauri and no Electron shim registered`,
  );
}

export const bridge = {
  call,
  isTauri: isTauriEnv(),
  /** Smoke test that the Rust shell is reachable. */
  async ping(): Promise<string> {
    const invoke = await loadInvoke();
    if (!invoke) return "electron";
    return (await invoke("ping")) as string;
  },
};

export default bridge;
