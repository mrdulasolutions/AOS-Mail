# Typed bridge

This document describes how `window.api.*` (the renderer's idiomatic
RPC call surface) is typed end-to-end against the sidecar contract.

## Why

Before this migration, `window.api` was typed as `any`. Every call site
cast manually:

```ts
const result = (await window.api.calendar.getCalendars()) as IpcResponse<{
  success: boolean;
  calendars?: CalendarRow[];
  ...
}>;
```

The cast was the load-bearing assumption — if the sidecar's response
shape changed, only runtime code caught the mismatch. Every renderer
file had its own ad-hoc IpcResponse-shaped declarations, often slightly
different from what the sidecar actually returned.

## Architecture

Three files anchor the typed surface:

```
┌───────────────────────────┐
│ src/shared/                │
│   sidecar-contract.ts      │  ← single source of truth
│     (SidecarMethods map)   │
└──────────┬─────────────────┘
           │ feeds method-result types
           ▼
┌───────────────────────────┐
│ src/shared/window-api.ts   │
│   (WindowApi interface)    │  ← typed namespace surface
│     IpcResponse<T> wraps   │
│     SidecarMethodResult    │
└──────────┬─────────────────┘
           │ shim satisfies
           ▼
┌───────────────────────────┐
│ src/renderer/lib/          │
│   electron-shim.ts         │  ← runtime forwarder
│     installRealNamespaces  │
│     return ... satisfies   │
│       WindowApi            │
└────────────────────────────┘
```

### `src/shared/sidecar-contract.ts`

The `SidecarMethods` map is the single source of truth:

```ts
export interface SidecarMethods {
  ping: { params: void; result: SidecarPing };
  "sync.now": { params: { accountId: string }; result: SyncResultLite };
  // ... ~130 entries
}
```

Each entry pins a method's params + result shape. The sidecar's
`registerMethod<K>` is typed against this contract, so handlers must
return exactly what the contract says. The renderer's `bridge.call<K>`
returns the typed result.

### `src/shared/window-api.ts`

The renderer's `window.api.*` surface. Each namespace is an explicit
interface whose method signatures pull return types from the contract:

```ts
import type { SidecarMethodResult } from "./sidecar-contract";

type R<K extends SidecarMethodName> = SidecarMethodResult<K>;

export interface CalendarApi {
  getCalendars: () => Promise<CalendarGetCalendarsResult>;
  setVisibility: (
    accountId: string,
    calendarId: string,
    visible: boolean,
  ) => Promise<IpcResponse<null>>;
  getEvents: (
    params?: { accountId?: string; calendarId?: string },
  ) => Promise<IpcResponse<R<"calendar.getEvents">>>;
  // ...
}
```

Two important deviations from a pure `SidecarMethods`-derived type:

1. **Positional args**, not the contract's object params. Every shim
   forwarder takes positional args (`setVisibility(accountId, calendarId,
   visible)`) because that's what the renderer call sites are written
   against. The window-api signatures match those args. The shim is
   the boundary that packs them into the contract's object form.

2. **`IpcResponse<T>` wrap**. The shim catches errors from `bridge.call`
   and surfaces them as `{ success: false, error }`. Renderer call
   sites never see thrown rejections — they branch on `result.success`.
   The window-api's return type is `Promise<IpcResponse<T>>`, where T
   is `SidecarMethodResult<K>` for in-contract methods.

`LocalWindowApiExtras` covers what isn't in the contract:
- Event-subscription methods (`onXyz` / `removeAllListeners`) that the
  sidecar emits via `bridge.listen` rather than RPC.
- Tauri-direct surfaces (`updates.*`, `defaultMailApp.*`, `find.*`).
- Auto-stub methods awaiting a contract entry.

Generic event handlers use `<T = unknown>` so renderer call sites can
narrow without a cast:

```ts
onProgress: <T = unknown>(cb: (data: T) => void) => () => void;
```

The renderer can pass `(progress: PrefetchProgress) => void` and TS will
infer `T = PrefetchProgress`.

### `src/renderer/lib/electron-shim.ts`

Builds `window.api` at runtime. Each namespace is assembled into a
loose `Record<string, unknown>`, then a satisfies-checked object literal
at the end enforces that every key in `WindowApi` has been wired:

```ts
function installRealNamespaces(): WindowApi {
  const real: Record<string, unknown> = {};
  // real.calendar = { ... }
  // real.sync = { ... }
  // ... ~38 namespaces

  // Compile-time enforcement: every namespace must appear here.
  const _coverage = {
    diagnostics: true,
    calendar: true,
    // ...
  } satisfies Record<keyof Omit<WindowApi, "_debugLog">, boolean>;
  void _coverage;

  return real as unknown as WindowApi;
}
```

Each individual forwarder doesn't have an explicit return type — TS
infers `Promise<{ success: true; data: T } | { success: false; error: string }>`
from the shim body. The renderer-side WindowApi's IpcResponse<T> is
structurally compatible.

## Adding a new RPC method

Three files to touch, in this order:

1. **`src/shared/sidecar-contract.ts`** — add the entry to
   `SidecarMethods`:

   ```ts
   "calendar.archiveCalendar": {
     params: { calendarId: string };
     result: { ok: true; archived: number };
   };
   ```

2. **`sidecar/src/methods/calendar.ts`** — register the handler:

   ```ts
   registerMethod("calendar.archiveCalendar", async (params) => {
     // params is typed as { calendarId: string }
     // return value must match { ok: true; archived: number }
   });
   ```

3. **`src/renderer/lib/electron-shim.ts`** — add a forwarder under
   `real.calendar`:

   ```ts
   archiveCalendar: async (calendarId: string) => {
     try {
       const data = await bridge.call("calendar.archiveCalendar", { calendarId });
       return { success: true as const, data };
     } catch (err) {
       return { success: false as const, error: err instanceof Error ? err.message : String(err) };
     }
   },
   ```

4. **`src/shared/window-api.ts`** — add the method to `CalendarApi`:

   ```ts
   archiveCalendar: (
     calendarId: string,
   ) => Promise<IpcResponse<R<"calendar.archiveCalendar">>>;
   ```

5. **Renderer call sites** — call without casts:

   ```ts
   const result = await window.api.calendar.archiveCalendar(id);
   if (result.success) {
     console.log(`archived ${result.data.archived}`);
   } else {
     console.error(result.error);
   }
   ```

## Adding a non-RPC surface

For event subscriptions or Tauri-direct commands, skip the contract.
Just add the method directly to the relevant namespace interface in
`window-api.ts`:

```ts
// In CalendarApi:
onCalendarUpdated: <T = unknown>(cb: (data: T) => void) => () => void;
```

Then wire the shim's `real.calendar` to dispatch via `bridge.listen`
or whatever the underlying surface is.

## Casting around mismatches

A handful of call sites still use `as unknown as IpcResponse<...>`
because the contract's result shape doesn't match what the renderer
expects. These are real shape-mismatch bugs flagged with TODO comments
— the type system can't resolve them without a follow-up PR that
either reshapes the contract or the call site. Search for
`TODO(typed-bridge)` to find them.

## Why we don't auto-derive WindowApi from SidecarMethods

A pure mapped-type derivation would require shim signatures to match
the contract's object-param form exactly. The shim instead exposes
positional args (`emails.archive(emailId, accountId)` vs. contract's
`{ emailId, accountId }`) because that's what every renderer call site
already used. Auto-deriving would have churned 240+ call sites for no
runtime benefit. The hand-written interfaces use the contract's result
types (via `SidecarMethodResult<K>`) so a contract change still flows
through to call sites; only the function signature stays positional.
