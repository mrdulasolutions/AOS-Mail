// Electron-API compatibility shim for the Tauri-era renderer.
//
// During the Electron->Tauri migration, components throughout src/renderer/
// still call `window.api.<namespace>.<method>(...)` — that surface was
// installed by src/preload/index.ts when running under Electron, but Tauri
// has no preload. Without a shim, the renderer crashes on the first call.
//
// This installs a Proxy-backed stub at window.api so the app boots and the
// shell renders. Every call resolves with an IpcResponse-shaped failure
// ({ success: false, error: "..." }), and event-subscription style methods
// (onXyz / listenToXyz / subscribe) return a noop unsubscribe.
//
// As individual IPC namespaces are lifted into the Node sidecar, the
// corresponding shim namespace gets replaced with a real bridge.call()
// forwarder in `installRealNamespaces()` below.
//
// Under Electron the preload runs first, so window.api already exists.
// We detect that and bail out — never overwriting the Electron surface.

import bridge from "./bridge";

type IpcResponse<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

const EVENT_SUBSCRIPTION_PREFIXES = ["on", "listenTo", "subscribe", "watch"];

function looksLikeEventSubscription(method: string): boolean {
  if (method === "subscribe") return true;
  return EVENT_SUBSCRIPTION_PREFIXES.some(
    (p) => method.startsWith(p) && /^[A-Z]/.test(method.slice(p.length, p.length + 1)),
  );
}

function stubMethod(ns: string, method: string) {
  if (looksLikeEventSubscription(method)) {
    // Return the unsubscribe pattern: caller invokes the returned fn to detach.
    return (..._args: unknown[]) => {
      return () => {};
    };
  }
  return async (..._args: unknown[]): Promise<IpcResponse<null>> => ({
    success: false,
    error: `window.api.${ns}.${method}: not wired through Tauri yet`,
  });
}

function namespaceProxy(ns: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, method) {
        if (typeof method !== "string") return undefined;
        // Avoid making the namespace itself look like a thenable.
        if (method === "then" || method === "toJSON") return undefined;
        return stubMethod(ns, method);
      },
    },
  );
}

/**
 * Hook for Phase 1b: as a sidecar method becomes available, register the
 * corresponding renderer-side namespace here so it talks through the bridge
 * instead of returning a stub failure.
 *
 * Each entry returns the namespace object that will be exposed at
 * window.api.<key>. Once a key is present here, it overrides the auto-stub.
 */
function installRealNamespaces(): Record<string, unknown> {
  const real: Record<string, unknown> = {};

  // Diagnostic: lets the renderer hit the sidecar even before any service is
  // lifted. Useful for the migration smoke test.
  real.diagnostics = {
    ping: async (): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("ping", {});
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    shellPing: async (): Promise<IpcResponse<string>> => {
      try {
        const data = await bridge.ping();
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    dbInfo: async (): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("db.info", {});
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    dbListAccounts: async (): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("db.listAccounts", {});
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // network — first lifted namespace. Mirrors the Electron `window.api.network`
  // surface (getStatus / updateStatus / onOnline / onOffline /
  // removeAllListeners) but routes through the sidecar + Tauri events.
  const networkUnlisteners: Array<() => void> = [];
  real.network = {
    getStatus: async (): Promise<IpcResponse<boolean>> => {
      try {
        const data = (await bridge.call("network.getStatus", {})) as { online: boolean };
        return { success: true, data: data.online };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    updateStatus: async (online: boolean): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("network.updateStatus", { online });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onOnline: (callback: () => void): void => {
      bridge
        .listen("network:online", () => callback())
        .then((unlisten) => networkUnlisteners.push(unlisten));
    },
    onOffline: (callback: () => void): void => {
      bridge
        .listen("network:offline", () => callback())
        .then((unlisten) => networkUnlisteners.push(unlisten));
    },
    removeAllListeners: (): void => {
      while (networkUnlisteners.length) {
        const unlisten = networkUnlisteners.pop();
        try {
          unlisten?.();
        } catch {
          // noop — best-effort cleanup
        }
      }
    },
  };

  return real;
}

export function installElectronShim(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { api?: unknown };
  if (w.api) return; // Electron preload already installed window.api — leave it.

  const real = installRealNamespaces();

  w.api = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "_debugLog") {
          return (msg: string) => {
            // eslint-disable-next-line no-console
            console.debug(`[bridge:debug] ${msg}`);
          };
        }
        if (prop in real) return real[prop];
        return namespaceProxy(prop);
      },
    },
  );

  // eslint-disable-next-line no-console
  console.info("[bridge] installed Tauri-era window.api shim");
}
