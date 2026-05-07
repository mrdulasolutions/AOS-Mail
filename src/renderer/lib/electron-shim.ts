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

  // theme — preference persistence in the sidecar; resolved value
  // (light|dark) computed in the renderer via prefers-color-scheme matchMedia
  // because only the renderer has the OS color signal. onChange combines
  // two sources so the API matches the Electron version exactly.
  type ThemePreference = "light" | "dark" | "system";
  type ThemeChange = { preference: ThemePreference; resolved: "light" | "dark" };
  const prefersDarkMql =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  const resolveTheme = (preference: ThemePreference): "light" | "dark" => {
    if (preference !== "system") return preference;
    return prefersDarkMql?.matches ? "dark" : "light";
  };
  const themeListeners: Array<(d: ThemeChange) => void> = [];
  let themeUnlistenSidecar: (() => void) | null = null;
  let themeMqlListener: ((e: MediaQueryListEvent) => void) | null = null;
  let themeCurrentPreference: ThemePreference = "system";

  // Cache the preference; sidecar push events update it.
  bridge
    .listen<{ preference: ThemePreference }>("theme:changed", ({ preference }) => {
      themeCurrentPreference = preference;
      const data: ThemeChange = { preference, resolved: resolveTheme(preference) };
      themeListeners.forEach((cb) => cb(data));
    })
    .then((un) => {
      themeUnlistenSidecar = un;
    });

  // OS theme flip while preference is "system" → fire onChange too.
  if (prefersDarkMql) {
    themeMqlListener = () => {
      if (themeCurrentPreference !== "system") return;
      const data: ThemeChange = {
        preference: "system",
        resolved: resolveTheme("system"),
      };
      themeListeners.forEach((cb) => cb(data));
    };
    prefersDarkMql.addEventListener("change", themeMqlListener);
  }

  real.theme = {
    get: async (): Promise<IpcResponse<ThemeChange>> => {
      try {
        const { preference } = (await bridge.call("theme.get", {})) as {
          preference: ThemePreference;
        };
        themeCurrentPreference = preference;
        return { success: true, data: { preference, resolved: resolveTheme(preference) } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    set: async (theme: ThemePreference): Promise<IpcResponse<{ resolved: "light" | "dark" }>> => {
      try {
        const { preference } = (await bridge.call("theme.set", { theme })) as {
          preference: ThemePreference;
        };
        themeCurrentPreference = preference;
        return { success: true, data: { resolved: resolveTheme(preference) } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onChange: (callback: (data: ThemeChange) => void): void => {
      themeListeners.push(callback);
    },
    removeAllListeners: (): void => {
      themeListeners.length = 0;
      // Sidecar + MQL subscriptions are kept alive — they're cheap and the
      // listener array is the actual fan-out. This matches the Electron
      // version's behavior of `ipcRenderer.removeAllListeners` clearing
      // user callbacks but leaving the underlying channel intact.
    },
  };

  // snippets — canned-response store. CRUD against a sidecar-backed JSON
  // file (replaces electron-store from the Electron path). Two Superhuman
  // import methods are sidecar-stubbed until superhuman-import lifts.
  type Snippet = Record<string, unknown> & {
    id: string;
    name: string;
    body: string;
    createdAt: number;
    updatedAt: number;
  };
  real.snippets = {
    getAll: async (): Promise<IpcResponse<Snippet[]>> => {
      try {
        const data = (await bridge.call("snippets.getAll", {})) as Snippet[];
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    save: async (snippets: Snippet[]): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("snippets.save", { snippets });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    create: async (snippet: Partial<Snippet>): Promise<IpcResponse<Snippet>> => {
      try {
        const data = (await bridge.call("snippets.create", { snippet })) as Snippet;
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    update: async (
      id: string,
      updates: Partial<Snippet>,
    ): Promise<IpcResponse<Snippet>> => {
      try {
        const data = (await bridge.call("snippets.update", { id, updates })) as Snippet;
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    delete: async (id: string): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("snippets.delete", { id });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    discoverSuperhuman: async (): Promise<IpcResponse<unknown>> => ({
      success: false,
      error: "snippets.discoverSuperhuman: not yet lifted into sidecar",
    }),
    importSuperhuman: async (): Promise<IpcResponse<unknown>> => ({
      success: false,
      error: "snippets.importSuperhuman: not yet lifted into sidecar",
    }),
  };

  // search + contacts — local FTS5 search + contact autocomplete.
  type SearchResult = Record<string, unknown> & { id: string; threadId: string };
  type ContactSuggestion = { email: string; name: string; frequency: number };
  real.search = {
    query: async (
      query: string,
      options?: { accountId?: string; limit?: number; offset?: number },
    ): Promise<IpcResponse<SearchResult[]>> => {
      try {
        const data = (await bridge.call("search.query", { query, options })) as SearchResult[];
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    suggestions: async (query: string, limit?: number): Promise<IpcResponse<string[]>> => {
      try {
        const data = (await bridge.call("search.suggestions", { query, limit })) as string[];
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    rebuildIndex: async (): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("search.rebuildIndex", {});
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
  real.contacts = {
    suggest: async (
      query: string,
      limit?: number,
    ): Promise<IpcResponse<ContactSuggestion[]>> => {
      try {
        const data = (await bridge.call("contacts.suggest", {
          query,
          limit,
        })) as ContactSuggestion[];
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // sender — sender profile lookup. V1 hits the legacy sender_profiles
  // table only; extension-enrichment cache integration arrives with the
  // extensions namespace lift.
  type SenderProfile = {
    email: string;
    name: string | null;
    summary: string;
    linkedinUrl: string | null;
    company: string | null;
    title: string | null;
    lookupAt: number;
  };
  real.sender = {
    getProfile: async (email: string): Promise<IpcResponse<SenderProfile | null>> => {
      try {
        const data = (await bridge.call("sender.getProfile", { email })) as
          | SenderProfile
          | null;
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    lookup: async (
      from: string,
      email: string,
    ): Promise<IpcResponse<SenderProfile | null>> => {
      try {
        const data = (await bridge.call("sender.lookup", { from, email })) as
          | SenderProfile
          | null;
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // snooze — local thread snoozing. The sidecar's auto-unsnooze timer
  // emits snooze:unsnoozed events; manual operations emit snoozed /
  // manually-unsnoozed.
  type SnoozedEmail = {
    id: string;
    emailId: string;
    threadId: string;
    accountId: string;
    snoozeUntil: number;
    snoozedAt: number;
  };
  const snoozeUnlisteners: Array<() => void> = [];
  real.snooze = {
    snooze: async (
      emailId: string,
      threadId: string,
      accountId: string,
      snoozeUntil: number,
    ): Promise<IpcResponse<SnoozedEmail>> => {
      try {
        const data = (await bridge.call("snooze.snooze", {
          emailId,
          threadId,
          accountId,
          snoozeUntil,
        })) as SnoozedEmail;
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    unsnooze: async (threadId: string, accountId: string): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("snooze.unsnooze", { threadId, accountId });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    list: async (
      accountId: string,
    ): Promise<IpcResponse<SnoozedEmail[]> & { expired?: SnoozedEmail[] }> => {
      try {
        const result = (await bridge.call("snooze.list", { accountId })) as {
          data: SnoozedEmail[];
          expired: SnoozedEmail[];
        };
        return { success: true, data: result.data, expired: result.expired };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    get: async (
      threadId: string,
      accountId: string,
    ): Promise<IpcResponse<SnoozedEmail | null>> => {
      try {
        const data = (await bridge.call("snooze.get", {
          threadId,
          accountId,
        })) as SnoozedEmail | null;
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onSnoozed: (callback: (data: { snoozedEmail: SnoozedEmail }) => void): void => {
      bridge
        .listen<{ snoozedEmail: SnoozedEmail }>("snooze:snoozed", (payload) => callback(payload))
        .then((un) => snoozeUnlisteners.push(un));
    },
    onUnsnoozed: (callback: (data: { emails: SnoozedEmail[] }) => void): void => {
      bridge
        .listen<{ emails: SnoozedEmail[] }>("snooze:unsnoozed", (payload) => callback(payload))
        .then((un) => snoozeUnlisteners.push(un));
    },
    onManuallyUnsnoozed: (
      callback: (data: { threadId: string; accountId: string; snoozeUntil: number }) => void,
    ): void => {
      bridge
        .listen<{ threadId: string; accountId: string; snoozeUntil: number }>(
          "snooze:manually-unsnoozed",
          (payload) => callback(payload),
        )
        .then((un) => snoozeUnlisteners.push(un));
    },
    removeAllListeners: (): void => {
      while (snoozeUnlisteners.length) {
        const un = snoozeUnlisteners.pop();
        try {
          un?.();
        } catch {
          // best-effort
        }
      }
    },
  };

  // splits — user-defined inbox splits / smart folders. CRUD against
  // splits.json; Superhuman import stubbed (same as snippets).
  type Split = Record<string, unknown> & { id: string; accountId: string; name: string };
  real.splits = {
    getAll: async (): Promise<IpcResponse<Split[]>> => {
      try {
        return { success: true, data: (await bridge.call("splits.getAll", {})) as Split[] };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    save: async (splits: Split[]): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("splits.save", { splits });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    create: async (split: Partial<Split>): Promise<IpcResponse<Split>> => {
      try {
        return { success: true, data: (await bridge.call("splits.create", { split })) as Split };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    update: async (id: string, updates: Partial<Split>): Promise<IpcResponse<Split>> => {
      try {
        return {
          success: true,
          data: (await bridge.call("splits.update", { id, updates })) as Split,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    delete: async (id: string): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("splits.delete", { id });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    discoverSuperhuman: async (): Promise<IpcResponse<unknown>> => ({
      success: false,
      error: "splits.discoverSuperhuman: not yet lifted",
    }),
    importSuperhuman: async (): Promise<IpcResponse<unknown>> => ({
      success: false,
      error: "splits.importSuperhuman: not yet lifted",
    }),
  };

  // auth — pure event-listening surface. The two events (token-expired,
  // extension-auth-required) get emitted by gmail-client and the extension
  // host respectively; both are services that haven't been lifted yet, so
  // the listeners are wired but won't fire until those lift. The two
  // methods (reauth, cancelReauth) require OAuth-in-Tauri and stay
  // auto-stubbed for now — they'll move here once OAuth lands.
  type AuthTokenExpired = { accountId: string; email: string; source: string };
  type AuthExtensionRequired = {
    extensionId: string;
    displayName: string;
    message?: string;
  };
  const authUnlisteners: Array<() => void> = [];
  real.auth = {
    onTokenExpired: (callback: (data: AuthTokenExpired) => void): void => {
      bridge
        .listen<AuthTokenExpired>("auth:token-expired", (payload) => callback(payload))
        .then((un) => authUnlisteners.push(un));
    },
    onExtensionAuthRequired: (callback: (data: AuthExtensionRequired) => void): void => {
      bridge
        .listen<AuthExtensionRequired>("auth:extension-auth-required", (payload) =>
          callback(payload),
        )
        .then((un) => authUnlisteners.push(un));
    },
    reauth: async (_accountId: string): Promise<IpcResponse<null>> => ({
      success: false,
      error: "auth.reauth: blocked on Tauri OAuth flow (see TAURI_MIGRATION.md)",
    }),
    cancelReauth: async (): Promise<IpcResponse<null>> => ({
      success: false,
      error: "auth.cancelReauth: blocked on Tauri OAuth flow",
    }),
    removeAllListeners: (): void => {
      while (authUnlisteners.length) {
        const un = authUnlisteners.pop();
        try {
          un?.();
        } catch {
          // best-effort
        }
      }
    },
  };

  // usage — Claude API cost + call history visibility.
  real.usage = {
    getStats: async (): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("usage.getStats", {});
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    getCallHistory: async (limit?: number): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("usage.getHistory", { limit });
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
