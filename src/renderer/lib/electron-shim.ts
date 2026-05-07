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
    anthropicPing: async (): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("anthropic.ping", {});
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    anthropicHasApiKey: async (): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("anthropic.hasApiKey", {});
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    anthropicSetApiKey: async (apiKey: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("anthropic.setApiKey", { apiKey });
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

  // accounts — multi-account management. Mostly DB CRUD; `add` wraps the
  // gmail OAuth flow.
  type AccountRecord = {
    id: string;
    email: string;
    displayName?: string;
    isPrimary: boolean;
    addedAt: number;
  };
  real.accounts = {
    list: async (): Promise<IpcResponse<AccountRecord[]>> => {
      try {
        const data = (await bridge.call("accounts.list", {})) as AccountRecord[];
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    add: async (_accountId?: string): Promise<IpcResponse<unknown>> => {
      try {
        // Sidecar's accounts.add returns immediately with the OAuth URL but
        // the underlying promise resolves when the user completes auth in
        // the system browser. Open the URL via Tauri shell so the same
        // call delivers the same end-to-end behavior the Electron version
        // had.
        const { url } = (await bridge.call("accounts.add", {})) as { url: string };
        if (bridge.isTauri) {
          const mod = await import("@tauri-apps/plugin-shell");
          await mod.open(url);
        } else {
          window.open(url, "_blank");
        }
        const account = await new Promise<unknown>((resolve, reject) => {
          const cleanups: Array<() => void> = [];
          const finish = (fn: () => void) => {
            for (const c of cleanups) c();
            fn();
          };
          bridge
            .listen("auth:gmail-connected", (payload) => finish(() => resolve(payload)))
            .then((un) => cleanups.push(un));
          bridge
            .listen<{ error: string }>("auth:gmail-failed", (p) =>
              finish(() => reject(new Error(p.error))),
            )
            .then((un) => cleanups.push(un));
        });
        return { success: true, data: account };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    remove: async (accountId: string): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("accounts.remove", { accountId });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    setPrimary: async (accountId: string): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("accounts.setPrimary", { accountId });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    cancelAdd: async (): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("accounts.cancelAdd", {});
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onAddProgress: (_callback: (data: { phase: string }) => void): (() => void) => {
      // The Electron version emitted progress phases mid-OAuth ("Authorizing...",
      // "Connecting account..."). The sidecar OAuth flow is single-step from the
      // renderer's perspective — it returns when complete. No-op for now.
      return () => {};
    },
  };

  // drafts — Claude-powered reply drafting + DB-backed save.
  real.drafts = {
    save: async (
      emailId: string,
      body: string,
      composeMode?: string,
      to?: string[],
      cc?: string[],
      bcc?: string[],
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("drafts.save", {
          emailId,
          body,
          composeMode,
          to,
          cc,
          bcc,
        });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    refine: async (
      emailId: string,
      currentDraft: string,
      critique: string,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("drafts.refine", {
          emailId,
          currentDraft,
          critique,
        });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    rerunAgent: async (emailId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("drafts.rerunAgent", { emailId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    rerunAllAgents: async (): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("drafts.rerunAllAgents", {});
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // analysis — Claude-powered triage. Each call hits the Anthropic API
  // through the lifted anthropic-service. Renderer triggers analysis on
  // each new email; result lands in the analyses table and bubbles up
  // to the priority badge.
  real.analysis = {
    analyze: async (emailId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("analysis.analyze", { emailId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    analyzeBatch: async (emailIds: string[]): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("analysis.analyzeBatch", { emailIds });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    overridePriority: async (
      emailId: string,
      newNeedsReply: boolean,
      newPriority: string | null,
      reason?: string,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("analysis.overridePriority", {
          emailId,
          newNeedsReply,
          newPriority,
          reason,
        });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // archiveReady — Claude-powered thread completion detector. Mirrors
  // the analysis namespace's shape: analyze / analyzeBatch / list /
  // override. Renderer triggers analysis on threads in the inbox; the
  // result lands in the archive_ready table and surfaces the thread in
  // the "Archive Ready" tab.
  real.archiveReady = {
    analyze: async (
      threadId: string,
      accountId: string,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("archiveReady.analyze", { threadId, accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    analyzeBatch: async (
      threadIds: string[],
      accountId: string,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("archiveReady.analyzeBatch", {
          threadIds,
          accountId,
        });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    list: async (
      accountId?: string,
      limit?: number,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("archiveReady.list", { accountId, limit });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    override: async (
      threadId: string,
      accountId: string,
      isReady: boolean,
      reason?: string,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("archiveReady.override", {
          threadId,
          accountId,
          isReady,
          reason,
        });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // emails — inbox management verbs (archive, trash, star, read).
  // For IMAP these proxy through the sidecar to flag/move on the
  // server, then update the local store. Gmail provider paths in
  // emails.* arrive when gmail-client lifts.
  real.emails = {
    archive: async (emailId: string, accountId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("emails.archive", { emailId, accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    batchArchive: async (
      emailIds: string[],
      accountId: string,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("emails.batchArchive", { emailIds, accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    archiveThread: async (
      threadId: string,
      accountId: string,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("emails.archiveThread", { threadId, accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    trash: async (emailId: string, accountId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("emails.trash", { emailId, accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    batchTrash: async (
      emailIds: string[],
      accountId: string,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("emails.batchTrash", { emailIds, accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    setStarred: async (
      emailId: string,
      _accountId: string,
      starred: boolean,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("emails.setStarred", { emailId, starred });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    setRead: async (
      emailId: string,
      _accountId: string,
      read: boolean,
    ): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("emails.setRead", { emailId, read });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // compose — V1 wraps the sidecar's IMAP/SMTP send. Gmail send
  // arrives when the gmail-client code lifts.
  type ComposeSendInput = {
    accountId: string;
    from?: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyText?: string;
    bodyHtml?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    recipientNames?: Record<string, string>;
    attachments?: Array<{
      filename: string;
      path?: string;
      content?: string;
      mimeType: string;
      size?: number;
    }>;
  };
  real.compose = {
    send: async (options: ComposeSendInput): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call(
          "compose.send",
          options as unknown as Record<string, unknown>,
        );
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    listLocalDrafts: async (): Promise<IpcResponse<unknown[]>> => {
      try {
        const result = (await bridge.call("compose.listLocalDrafts", {})) as {
          success?: boolean;
          data?: unknown[];
        };
        return { success: true, data: Array.isArray(result?.data) ? result.data : [] };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    getSendAsAliases: async (
      _accountId: string,
    ): Promise<IpcResponse<{ aliases: unknown[] }>> => {
      try {
        const data = (await bridge.call("compose.getSendAsAliases", {
          accountId: _accountId,
        })) as { aliases: unknown[] };
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // sync — V1 surface that lets the renderer's existing initializeSync
  // flow work against the sidecar. Most methods proxy 1:1; status/setInterval/
  // start/stop are accepted-but-no-op for V1 (no background loop yet).
  type SyncStatusEvent = { accountId: string; status: "idle" | "syncing" | "error" };
  const syncUnlisteners: Array<() => void> = [];
  real.sync = {
    init: async (): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("sync.init", {});
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    now: async (accountId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("sync.now", { accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    start: async (accountId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("sync.start", { accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    stop: async (accountId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("sync.stop", { accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    setInterval: async (intervalMs: number): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("sync.setInterval", { intervalMs });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    status: async (accountId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("sync.status", { accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    getEmails: async (accountId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("sync.getEmails", { accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    getSentEmails: async (accountId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("sync.getSentEmails", { accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    prefetchBodies: async (_ids: string[]): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("sync.prefetchBodies", { ids: _ids });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onNewEmails: (
      cb: (data: { accountId: string; emails: unknown[] }) => void,
    ): void => {
      bridge
        .listen<{ accountId: string; emails: unknown[] }>("sync:new-emails", (p) => cb(p))
        .then((un) => syncUnlisteners.push(un));
    },
    // Renderer calls this `onStatusChange` (not onSyncStatusChange).
    onStatusChange: (cb: (data: SyncStatusEvent) => void): void => {
      bridge
        .listen<SyncStatusEvent>("sync:status-change", (p) => cb(p))
        .then((un) => syncUnlisteners.push(un));
    },
    // The remaining listener methods (onNewSentEmails / onEmailsRemoved /
    // onEmailsUpdated / onDraftsRemoved / onActionFailed / onActionSucceeded)
    // fall through to the auto-stub for now — events never fire because the
    // sidecar doesn't emit them yet, and the stubs return noop unsubscribes
    // so the renderer's cleanup paths stay valid.
    removeAllListeners: (): void => {
      while (syncUnlisteners.length) {
        const un = syncUnlisteners.pop();
        try {
          un?.();
        } catch {
          // best-effort
        }
      }
    },
  };

  // imap — full IMAP/SMTP provider surface for non-Gmail accounts.
  // The renderer's wizard / settings UI calls testConnection before
  // addAccount so the user gets an informative error before we persist
  // anything.
  type ImapPreset = {
    id: string;
    label: string;
    hint: string;
    domains?: string[];
    imap: { host: string; port: number; tls: true };
    smtp: { host: string; port: number; tls: true };
    appPasswordRequired?: boolean;
    appPasswordHelp?: string;
  };
  type ImapAddInput = {
    email: string;
    password: string;
    displayName?: string;
    imapHost: string;
    imapPort: number;
    imapUsername?: string;
    smtpHost: string;
    smtpPort: number;
    tls?: boolean;
  };
  real.imap = {
    presets: async (): Promise<IpcResponse<{ presets: ImapPreset[] }>> => {
      try {
        const data = (await bridge.call("imap.presets", {})) as { presets: ImapPreset[] };
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    suggestForEmail: async (
      email: string,
    ): Promise<IpcResponse<{ preset: ImapPreset | null }>> => {
      try {
        const data = (await bridge.call("imap.suggestForEmail", { email })) as {
          preset: ImapPreset | null;
        };
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    testConnection: async (input: ImapAddInput): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("imap.testConnection", input as Record<string, unknown>);
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    addAccount: async (input: ImapAddInput): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("imap.addAccount", input as Record<string, unknown>);
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    listFolders: async (accountId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("imap.listFolders", { accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    disconnect: async (accountId: string): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("imap.disconnect", { accountId });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // gmail — auth-side methods only (OAuth flow). API ops (fetch, send, etc.)
  // lift later as gmail-client gets ported.
  type AuthSuccess = { accountId: string; email: string; displayName: string | null };
  const gmailAuthListeners: Array<() => void> = [];
  real.gmail = {
    // Provider-agnostic body fetch.
    getEmail: async (emailId: string): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("sync.fetchBody", { emailId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    // Provider-agnostic inbox listing. The renderer uses gmail.fetchUnread
    // as its bootstrap fetch (via React Query in App.tsx); we route to
    // sync.getEmails so the same call path serves IMAP accounts. Without
    // this routing the auto-stub throws → React Query retries → the
    // inbox is stuck on "Loading..." forever even though the DB has rows.
    fetchUnread: async (
      _maxResults?: number,
      accountId?: string,
    ): Promise<IpcResponse<unknown>> => {
      try {
        if (!accountId) {
          return { success: true, data: [] };
        }
        const data = await bridge.call("sync.getEmails", { accountId });
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    saveCredentials: async (
      clientId: string,
      clientSecret: string,
    ): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("gmail.saveCredentials", { clientId, clientSecret });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    checkAuth: async (): Promise<IpcResponse<unknown>> => {
      try {
        const data = await bridge.call("gmail.checkAuth", {});
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    startOAuth: async (): Promise<IpcResponse<AuthSuccess>> => {
      try {
        // Sidecar starts the loopback server + returns the OAuth URL.
        const { url } = (await bridge.call("gmail.startOAuth", {})) as { url: string };
        // Open the URL in the system browser via Tauri shell plugin. Under
        // Electron the host preload would have done this; under Tauri the
        // renderer drives it.
        if (bridge.isTauri) {
          const mod = await import("@tauri-apps/plugin-shell");
          await mod.open(url);
        } else {
          // Best-effort fallback for the Electron parity path.
          window.open(url, "_blank");
        }
        // Wait for the success or failure event the sidecar will emit when
        // the OAuth callback fires. Match the Electron API which resolved
        // when OAuth completed.
        const account = await new Promise<AuthSuccess>((resolve, reject) => {
          const cleanups: Array<() => void> = [];
          const finish = (fn: () => void) => {
            for (const c of cleanups) c();
            fn();
          };
          bridge
            .listen<AuthSuccess>("auth:gmail-connected", (payload) =>
              finish(() => resolve(payload)),
            )
            .then((un) => cleanups.push(un));
          bridge
            .listen<{ error: string }>("auth:gmail-failed", (payload) =>
              finish(() => reject(new Error(payload.error))),
            )
            .then((un) => cleanups.push(un));
        });
        return { success: true, data: account };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    cancelOAuth: async (): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("gmail.cancelOAuth", {});
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    // Gmail API ops (fetchUnread / createDraft / getEmail) require the
    // gmail-client port — until then they auto-stub. Removed from the real
    // namespace so window.api.gmail.fetchUnread() still goes through the
    // not-yet-wired error path.
  };
  // Enrich the auto-stub-fallback's window.api.gmail with method mixin: the
  // Proxy returns whichever real fields we set above and stubs the rest.
  // (No additional code needed — installRealNamespaces() does this.)
  void gmailAuthListeners; // reserved for future event subscriptions

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

  // memory — agent persistent-memory CRUD + Claude-powered scope classify.
  // Mirrors the Electron preload contract (src/preload/index.ts:memory).
  // The two learned-event listeners (onDraftEditLearned /
  // onAnalysisOverrideLearned) are wired to bridge events; they will fire
  // once the consolidate-memory-scopes pipeline is lifted, but no-op
  // gracefully until then.
  type Memory = Record<string, unknown> & { id: string };
  type DraftMemory = Record<string, unknown> & { id: string };
  type LearnedPromotion = {
    id: string;
    content: string;
    scope: string;
    scopeValue: string | null;
  };
  type DraftEditLearned = {
    promoted: LearnedPromotion[];
    draftMemoriesCreated: number;
    draftMemoryIds: string[];
  };
  type AnalysisOverrideLearned = {
    promoted: LearnedPromotion[];
    draftMemoriesCreated: number;
  };

  real.memory = {
    list: async (accountId: string): Promise<IpcResponse<Memory[]>> => {
      try {
        const data = (await bridge.call("memory.list", { accountId })) as Memory[];
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    getForEmail: async (
      senderEmail: string,
      accountId: string,
    ): Promise<IpcResponse<Memory[]>> => {
      try {
        const data = (await bridge.call("memory.getForEmail", {
          senderEmail,
          accountId,
        })) as Memory[];
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    save: async (params: {
      accountId: string;
      scope: string;
      scopeValue?: string | null;
      content: string;
      source?: string;
      sourceEmailId?: string;
    }): Promise<IpcResponse<Memory>> => {
      try {
        const data = (await bridge.call("memory.save", params)) as Memory;
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    update: async (
      id: string,
      updates: {
        content?: string;
        enabled?: boolean;
        scope?: string;
        scopeValue?: string | null;
      },
    ): Promise<IpcResponse<Memory | null>> => {
      try {
        const data = (await bridge.call("memory.update", { id, updates })) as Memory | null;
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    delete: async (id: string): Promise<IpcResponse<null>> => {
      try {
        await bridge.call("memory.delete", { id });
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    categories: async (accountId: string): Promise<IpcResponse<string[]>> => {
      try {
        const data = (await bridge.call("memory.categories", { accountId })) as string[];
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    classify: async (params: {
      content: string;
      senderEmail: string;
      senderDomain: string;
    }): Promise<
      IpcResponse<{ scope: string; scopeValue: string | null; content: string }>
    > => {
      try {
        const data = (await bridge.call("memory.classify", params)) as {
          scope: string;
          scopeValue: string | null;
          content: string;
        };
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onDraftEditLearned: (callback: (data: DraftEditLearned) => void): (() => void) => {
      let unsub: (() => void) | null = null;
      bridge
        .listen<DraftEditLearned>("draft-edit:learned", (payload) => callback(payload))
        .then((un) => {
          unsub = un;
        });
      return () => {
        try {
          unsub?.();
        } catch {
          // best-effort
        }
      };
    },
    onAnalysisOverrideLearned: (
      callback: (data: AnalysisOverrideLearned) => void,
    ): (() => void) => {
      let unsub: (() => void) | null = null;
      bridge
        .listen<AnalysisOverrideLearned>("analysis-override:learned", (payload) =>
          callback(payload),
        )
        .then((un) => {
          unsub = un;
        });
      return () => {
        try {
          unsub?.();
        } catch {
          // best-effort
        }
      };
    },
    draftMemories: {
      list: async (accountId: string): Promise<IpcResponse<DraftMemory[]>> => {
        try {
          const data = (await bridge.call("draftMemory.list", { accountId })) as DraftMemory[];
          return { success: true, data };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      promote: async (_id: string, _accountId: string): Promise<IpcResponse<null>> => ({
        success: false,
        error: "draftMemory.promote: not yet wired in sidecar",
      }),
      delete: async (id: string): Promise<IpcResponse<null>> => {
        try {
          await bridge.call("draftMemory.delete", { id });
          return { success: true, data: null };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
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

  // find — page text search. The Electron version drove
  // webContents.findInPage() from the main process; under Tauri there is no
  // such IPC. Instead we use the standard browser `window.find()` API which
  // works in WKWebView and selects the next match in the DOM directly. The
  // existing FindBar UI is unchanged — it still subscribes via
  // window.api.find.onResult() to a `find:result` event.
  //
  // window.find() doesn't report total match counts, so we emit a partial
  // result: matches=1 / ordinal=1 on hit, matches=0 on miss. The FindBar's
  // counter UI degrades gracefully ("No matches" / "1 of 1" / blank).
  type FindResult = { activeMatchOrdinal: number; matches: number };
  type FindWindow = Window & {
    find?: (
      text: string,
      caseSensitive?: boolean,
      backwards?: boolean,
      wrapAround?: boolean,
      wholeWord?: boolean,
      searchInFrames?: boolean,
      showDialog?: boolean,
    ) => boolean;
  };
  let findResultCb: ((r: FindResult) => void) | null = null;
  const findOpenListeners: Array<() => void> = [];
  if (typeof window !== "undefined") {
    // Cmd+F surfaces from the native menu via the menu-bridge as an
    // `aos-mail:find` CustomEvent. Routing it here matches the Electron-era
    // `find:open` IPC that was dispatched from window.ts.
    window.addEventListener("aos-mail:find", () => {
      findOpenListeners.forEach((cb) => {
        try {
          cb();
        } catch {
          // best-effort
        }
      });
    });
  }
  real.find = {
    find: (text: string, options?: { forward?: boolean; findNext?: boolean }): void => {
      if (typeof window === "undefined" || !text) return;
      const w = window as FindWindow;
      let matched = false;
      try {
        // Per the spec template — third arg of window.find is `backwards`.
        matched = w.find?.(text, false, !!options?.forward, true, false, false, false) ?? false;
      } catch {
        matched = false;
      }
      const result: FindResult = matched
        ? { activeMatchOrdinal: 1, matches: 1 }
        : { activeMatchOrdinal: 0, matches: 0 };
      // Dispatch a window CustomEvent so any direct DOM listeners stay
      // compatible alongside the API-style onResult callback.
      window.dispatchEvent(new CustomEvent("find:result", { detail: result }));
      findResultCb?.(result);
    },
    stop: (): void => {
      if (typeof window === "undefined") return;
      window.getSelection()?.removeAllRanges();
    },
    onResult: (callback: (result: FindResult) => void): void => {
      findResultCb = callback;
    },
    removeResultListener: (): void => {
      findResultCb = null;
    },
    onOpen: (callback: () => void): void => {
      // Replace any previous registration to mirror the Electron preload
      // behavior of removeAllListeners + on.
      findOpenListeners.length = 0;
      findOpenListeners.push(callback);
    },
    removeOpenListener: (): void => {
      findOpenListeners.length = 0;
    },
  };

  // updates — auto-update via tauri-plugin-updater. The Electron version
  // was driven by electron-updater + the auto-updater service; under Tauri
  // the renderer talks to the plugin directly. The endpoint is currently
  // disabled (active=false in tauri.conf.json) so check() is a no-op until
  // signing keys land in Phase 5. Surface is wired so the UI renders the
  // moment the feature is activated.
  type UpdateStatus =
    | { state: "idle" }
    | { state: "checking" }
    | { state: "available"; version: string }
    | { state: "downloading"; progress: number }
    | { state: "downloaded"; version: string }
    | { state: "error"; message: string };
  let updateStatus: UpdateStatus = { state: "idle" };
  const updateStatusListeners: Array<(s: UpdateStatus) => void> = [];
  const setUpdateStatus = (s: UpdateStatus): void => {
    updateStatus = s;
    updateStatusListeners.forEach((cb) => {
      try {
        cb(s);
      } catch {
        // best-effort
      }
    });
  };
  // The pending update object returned by plugin-updater's check() exposes
  // version + downloadAndInstall. We hold onto it so the UI's separate
  // download click can use it; matches the electron-updater flow.
  type PendingUpdate = {
    version: string;
    downloadAndInstall: (cb: (e: unknown) => void) => Promise<void>;
  };
  let pendingUpdate: PendingUpdate | null = null;
  real.updates = {
    getStatus: async (): Promise<IpcResponse<UpdateStatus>> => {
      return { success: true, data: updateStatus };
    },
    getVersion: async (): Promise<IpcResponse<string>> => {
      try {
        if (!bridge.isTauri) return { success: true, data: "0.0.0" };
        const mod = await import("@tauri-apps/api/app");
        const v = await mod.getVersion();
        return { success: true, data: v };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    check: async (): Promise<IpcResponse<UpdateStatus>> => {
      if (!bridge.isTauri) {
        return { success: false, error: "updates.check: only available under Tauri" };
      }
      try {
        setUpdateStatus({ state: "checking" });
        const mod = await import("@tauri-apps/plugin-updater");
        const update = await mod.check();
        if (update) {
          pendingUpdate = update as unknown as PendingUpdate;
          const version = (update as { version?: string }).version ?? "unknown";
          setUpdateStatus({ state: "available", version });
        } else {
          setUpdateStatus({ state: "idle" });
        }
        return { success: true, data: updateStatus };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setUpdateStatus({ state: "error", message: msg });
        return { success: false, error: msg };
      }
    },
    download: async (): Promise<IpcResponse<null>> => {
      if (!bridge.isTauri || !pendingUpdate) {
        return {
          success: false,
          error: "updates.download: no pending update (call check() first)",
        };
      }
      try {
        const version = pendingUpdate.version;
        setUpdateStatus({ state: "downloading", progress: 0 });
        let totalBytes = 0;
        let downloaded = 0;
        await pendingUpdate.downloadAndInstall((event) => {
          // Tauri updater emits {event: 'Started'|'Progress'|'Finished',
          // data: {...}} — see plugin-updater docs.
          const ev = event as {
            event?: string;
            data?: { contentLength?: number; chunkLength?: number };
          };
          if (ev.event === "Started") {
            totalBytes = ev.data?.contentLength ?? 0;
            downloaded = 0;
          } else if (ev.event === "Progress") {
            downloaded += ev.data?.chunkLength ?? 0;
            const progress = totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0;
            setUpdateStatus({ state: "downloading", progress });
          } else if (ev.event === "Finished") {
            setUpdateStatus({ state: "downloaded", version });
          }
        });
        // downloadAndInstall both downloads and installs. By the time it
        // resolves the install is staged; mark downloaded so the UI offers
        // the restart prompt — install() relaunches via plugin-process.
        if (updateStatus.state !== "downloaded") {
          setUpdateStatus({ state: "downloaded", version });
        }
        return { success: true, data: null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setUpdateStatus({ state: "error", message: msg });
        return { success: false, error: msg };
      }
    },
    install: async (): Promise<IpcResponse<null>> => {
      // tauri-plugin-updater's downloadAndInstall already installs in
      // place; this just relaunches via plugin-process.
      if (!bridge.isTauri) {
        return { success: false, error: "updates.install: only available under Tauri" };
      }
      try {
        const mod = await import("@tauri-apps/plugin-process");
        await mod.relaunch();
        return { success: true, data: null };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onStatusChanged: (callback: (status: UpdateStatus) => void): (() => void) => {
      updateStatusListeners.push(callback);
      return () => {
        const idx = updateStatusListeners.indexOf(callback);
        if (idx >= 0) updateStatusListeners.splice(idx, 1);
      };
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

  // For each real namespace, wrap it in a Proxy that falls through to the
  // auto-stub for any method we haven't lifted yet. Lets a partially-lifted
  // namespace coexist with the rest of the auto-stubbed surface — e.g.
  // `gmail.startOAuth` is real, `gmail.fetchUnread` falls back to the
  // "not wired through Tauri yet" stub instead of throwing TypeError.
  function mergedNamespace(ns: string, realNs: Record<string, unknown>): unknown {
    const stub = namespaceProxy(ns) as Record<string, unknown>;
    return new Proxy(realNs, {
      get(target, method) {
        if (typeof method !== "string") return undefined;
        if (method in target) return target[method];
        return stub[method];
      },
    });
  }

  const wrappedReal: Record<string, unknown> = {};
  for (const ns of Object.keys(real)) {
    wrappedReal[ns] = mergedNamespace(ns, real[ns] as Record<string, unknown>);
  }

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
        if (prop in wrappedReal) return wrappedReal[prop];
        return namespaceProxy(prop);
      },
    },
  );

  // eslint-disable-next-line no-console
  console.info("[bridge] installed Tauri-era window.api shim");
}
