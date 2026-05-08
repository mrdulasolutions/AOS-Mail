// Unified toast surface — one store, one container, one Cmd+Z handler.
//
// Replaces four legacy per-feature toast components (UndoActionToast,
// UndoSendToast, SmartActionToast, TriageStatusToast) that each invented
// their own timer / cancellation / Cmd+Z bookkeeping and even cross-linked
// via a shared `cancelHandlers` map. See docs/POST-MORTEM-2026-05.md item #2.
//
// Design notes:
// - Each toast is a tagged union (`ToastSpec`) so the renderer can pick a
//   kind-specific layout without an `if (item.kind === "undo")` cascade.
// - `undo` toasts carry their own `undoable` callback (what the user wants
//   to revert) and an optional `onExpire` (what happens when the 5s timer
//   elapses without an undo — e.g. commit the gmail batchArchive call).
//   The toast component handles the timer dispatch + Cmd+Z surface.
// - Email-suppression (sync resurrecting an optimistically-removed thread)
//   is exposed via `getSuppressedEmailIds()` so the existing reducers in
//   the main app store can query it without depending on toast internals.
// - `mergeKey` lets a caller merge rapid-fire actions (e.g. five archives
//   in two seconds) into a single toast that says "5 threads archived"
//   instead of stacking five rows. The merge fires only while the existing
//   toast hasn't expired yet — once it has, we treat the new push as a
//   fresh action.

import { create } from "zustand";

export type ToastSpec =
  | { kind: "info"; text: string; expiresAt?: number }
  | { kind: "progress"; text: string; pct?: number }
  | {
      kind: "undo";
      text: string;
      // Runs when the user clicks Undo or presses Cmd+Z. Should restore
      // whatever optimistic update the caller did up-front. Synchronous
      // callers can return void; async callers (rare) get awaited so the
      // toast doesn't dismiss until the revert lands.
      undoable: () => void | Promise<void>;
      // Runs once when the timer elapses (i.e. user did NOT undo). This is
      // where the caller commits the action to the server (e.g. gmail
      // batchArchive). Optional because some legacy paths fire the IPC
      // immediately (snooze) and only need the undo affordance, not commit.
      onExpire?: () => void | Promise<void>;
      // Email IDs that should be suppressed from sync-driven re-adds while
      // this toast is on screen. Empty / undefined for label-only actions
      // (mark-unread, star, snooze) where the email stays in the inbox.
      suppressEmailIds?: string[];
      expiresAt: number;
      // Same merge key + same kind → merge the new push into the existing
      // toast, restarting its timer and concatenating semantic data via
      // `mergeUpdate`. Only set on undo toasts that the caller intentionally
      // wants to roll up (e.g. batched archives by account).
      mergeKey?: string;
      // Called when a same-mergeKey push arrives. Receives the prior toast's
      // patchable fields and returns the merged versions. Caller-defined so
      // the toast store stays domain-agnostic.
      mergeUpdate?: (
        prior: { text: string; suppressEmailIds?: string[] },
        incoming: { text: string; suppressEmailIds?: string[] },
      ) => { text: string; suppressEmailIds?: string[] };
    }
  | {
      kind: "error";
      text: string;
      detail?: string;
      expiresAt?: number;
      // Optional action button (e.g. "Retry"). Clicking it dismisses the
      // toast and runs `onClick`. Used by send-failure flow so the user
      // can re-attempt without re-opening the compose pane.
      action?: { label: string; onClick: () => void | Promise<void> };
    };

export type Toast = ToastSpec & { id: string };

type ToastUpdate = Partial<{
  text: string;
  pct: number;
  suppressEmailIds: string[];
  expiresAt: number;
  detail: string;
}>;

interface ToastStore {
  toasts: Toast[];
  pushToast: (spec: ToastSpec) => string;
  dismissToast: (id: string) => void;
  updateToast: (id: string, patch: ToastUpdate) => void;
  /**
   * Drop ALL toasts. Used by tests for isolation; renderer code should
   * dismiss specific ids instead.
   */
  _resetForTesting: () => void;
}

let nextId = 0;
function makeId(): string {
  // Stable, monotonic, no crypto dep — toasts live in-process only.
  nextId += 1;
  return `toast-${Date.now().toString(36)}-${nextId}`;
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  pushToast: (spec) => {
    // Merge path — only for undo kind with a mergeKey, and only when the
    // existing toast hasn't already expired (a stale entry is committing or
    // about to commit, so a fresh push should stack as a new toast).
    if (spec.kind === "undo" && spec.mergeKey) {
      const existing = get().toasts.find(
        (t): t is Toast & { kind: "undo"; mergeKey: string } =>
          t.kind === "undo" && t.mergeKey === spec.mergeKey && t.expiresAt > Date.now(),
      );
      if (existing) {
        // Compose the merge. Default merger concatenates suppressEmailIds
        // and prefers the new text — most callers want the latest count.
        const merged = spec.mergeUpdate?.(
          { text: existing.text, suppressEmailIds: existing.suppressEmailIds },
          { text: spec.text, suppressEmailIds: spec.suppressEmailIds },
        ) ?? {
          text: spec.text,
          suppressEmailIds: [
            ...(existing.suppressEmailIds ?? []),
            ...(spec.suppressEmailIds ?? []),
          ],
        };
        // Compose `undoable` so undo runs BOTH the existing revert and the
        // incoming one. `onExpire` likewise fires both — if the prior was a
        // batchArchive call and the new push adds more emails, we want both
        // batches committed when the timer eventually elapses.
        const composedUndo = async () => {
          await existing.undoable();
          await spec.undoable();
        };
        const composedExpire =
          existing.onExpire || spec.onExpire
            ? async () => {
                if (existing.onExpire) await existing.onExpire();
                if (spec.onExpire) await spec.onExpire();
              }
            : undefined;
        const updated: Toast = {
          ...existing,
          text: merged.text,
          suppressEmailIds: merged.suppressEmailIds,
          undoable: composedUndo,
          onExpire: composedExpire,
          expiresAt: spec.expiresAt,
        };
        set((s) => ({ toasts: s.toasts.map((t) => (t.id === existing.id ? updated : t)) }));
        return existing.id;
      }
    }

    const id = makeId();
    const toast: Toast = { ...spec, id };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    return id;
  },

  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  updateToast: (id, patch) => {
    set((s) => ({
      toasts: s.toasts.map((t) => {
        if (t.id !== id) return t;
        // Each kind admits a different patch surface; spread + cast is the
        // narrowest tool here. The TS structural type still rejects illegal
        // fields at the call site (the patch type is the intersection).
        return { ...t, ...patch } as Toast;
      }),
    }));
  },

  _resetForTesting: () => set({ toasts: [] }),
}));

/**
 * Returns email IDs that the renderer should suppress when sync delivers an
 * "addEmails" / "setEmails" call. Reads the live toast queue rather than a
 * cached set so the answer can never go stale.
 *
 * Intended for use in the main store's `addEmails` / `setEmails` reducers
 * and the sync flush in `useSyncBuffer`.
 */
export function getSuppressedEmailIds(): Set<string> {
  const out = new Set<string>();
  for (const t of useToastStore.getState().toasts) {
    if (t.kind === "undo" && t.suppressEmailIds) {
      for (const id of t.suppressEmailIds) out.add(id);
    }
  }
  return out;
}

/**
 * Returns the most-recent undo toast (last in the queue), or null. The
 * Cmd+Z handler dispatches to whichever this returns. Exported so other
 * modules can probe in the rare case they need to gate a different action
 * on a pending undo.
 */
export function peekLatestUndo(): Toast | null {
  const toasts = useToastStore.getState().toasts;
  for (let i = toasts.length - 1; i >= 0; i--) {
    if (toasts[i].kind === "undo") return toasts[i];
  }
  return null;
}
