import { useEffect, useRef, useState } from "react";
import { useToastStore, type Toast } from "../lib/toast-store";

// Single bottom-left toast container — the only place toasts render in the
// renderer. Mounts one Cmd+Z listener that walks the queue (most-recent
// first) to find the latest undoable toast and invoke it. Replaces four
// legacy components and their cross-linked `cancelHandlers` map. See
// docs/POST-MORTEM-2026-05.md item #2.

const UNDO_LABEL = navigator.platform.includes("Mac") ? "Cmd+Z" : "Ctrl+Z";

function ToastRow({ toast }: { toast: Toast }) {
  const dismissToast = useToastStore((s) => s.dismissToast);
  const expiredRef = useRef(false);
  const undoneRef = useRef(false);

  // Auto-dismiss timer for any kind with `expiresAt`. For `undo` kind we
  // also fire the `onExpire` callback before removing the row — that's
  // where the caller commits the action to the server.
  useEffect(() => {
    if (toast.kind === "progress") return; // progress toasts dismiss explicitly
    if (toast.kind === "info" && !toast.expiresAt) return;
    if (toast.kind === "error" && !toast.expiresAt) return;

    const expiresAt =
      toast.kind === "undo"
        ? toast.expiresAt
        : (toast.kind === "info" || toast.kind === "error") && toast.expiresAt
          ? toast.expiresAt
          : undefined;
    if (expiresAt === undefined) return;

    const remaining = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(() => {
      void (async () => {
        if (toast.kind === "undo" && !undoneRef.current && !expiredRef.current && toast.onExpire) {
          expiredRef.current = true;
          try {
            await toast.onExpire();
          } catch (err) {
            // Don't swallow silently — the legacy commit path also surfaced
            // these to the console for visibility while not crashing the UI.
            console.error("[Toast] onExpire failed:", err);
          }
        }
        dismissToast(toast.id);
      })();
    }, remaining);
    return () => clearTimeout(timer);
    // toast.id + expiresAt change together when a merge restarts the timer
    // (the merged toast's expiresAt advances), so depending on `toast` is
    // fine here — we want a fresh timer per identity-or-expiry change.
  }, [toast, dismissToast]);

  // Run the supersede-commit path: if a row unmounts while still pending
  // (queue replacement, account switch), commit the action so the user
  // doesn't lose data. Mirrors UndoActionToast's previous unmount cleanup.
  useEffect(() => {
    return () => {
      if (toast.kind !== "undo") return;
      if (undoneRef.current || expiredRef.current) return;
      // Guard: only commit if this id is no longer in the queue. React
      // StrictMode's simulated unmount would otherwise double-commit.
      const stillInQueue = useToastStore.getState().toasts.some((t) => t.id === toast.id);
      if (stillInQueue) return;
      if (toast.onExpire) {
        expiredRef.current = true;
        void Promise.resolve(toast.onExpire()).catch((err) => {
          console.error("[Toast] supersede commit failed:", err);
        });
      }
    };
    // Intentionally empty dep array: this effect only runs on real
    // unmount (component leaves the tree), not on toast field updates.
  }, []);

  const handleUndo = () => {
    if (toast.kind !== "undo") return;
    if (undoneRef.current || expiredRef.current) return;
    undoneRef.current = true;
    // Dismiss FIRST so suppressEmailIds is no longer in the queue when
    // `undoable` runs — otherwise addEmails(...) inside the callback would
    // be filtered out by the very toast we're undoing.
    dismissToast(toast.id);
    void Promise.resolve(toast.undoable()).catch((err) => {
      console.error("[Toast] undoable failed:", err);
    });
  };

  // ---- per-kind rendering ----

  if (toast.kind === "progress") {
    return (
      <div
        className="bg-gray-900 dark:bg-gray-700 text-white rounded-lg shadow-lg flex items-center gap-3 px-4 py-3 min-w-[260px]"
        role="status"
        aria-live="polite"
      >
        <svg className="w-3.5 h-3.5 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        <span className="text-sm">{toast.text}</span>
        {typeof toast.pct === "number" && (
          <span className="text-xs text-gray-400 ml-1">{Math.round(toast.pct)}%</span>
        )}
      </div>
    );
  }

  if (toast.kind === "error") {
    return (
      <div
        className="bg-gray-900 dark:bg-gray-700 text-white rounded-lg shadow-lg flex items-center justify-between px-4 py-3 min-w-[280px]"
        role="alert"
        aria-live="assertive"
      >
        <span className="text-sm">
          <span className="text-red-400">{toast.text}</span>
          {toast.detail && <span className="ml-2 text-gray-400 text-xs">{toast.detail}</span>}
        </span>
        {toast.action ? (
          <button
            onClick={() => {
              const { onClick, label: _label } = toast.action!;
              void Promise.resolve(onClick()).catch((err) => {
                console.error("[Toast] error action failed:", err);
              });
              dismissToast(toast.id);
            }}
            className="ml-4 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0"
          >
            {toast.action.label}
          </button>
        ) : (
          <button
            onClick={() => dismissToast(toast.id)}
            className="ml-4 text-sm font-medium text-gray-400 hover:text-white transition-colors flex-shrink-0"
          >
            Dismiss
          </button>
        )}
      </div>
    );
  }

  if (toast.kind === "info") {
    return (
      <div
        className="bg-gray-900 dark:bg-gray-700 text-white rounded-lg shadow-lg flex items-center justify-between px-4 py-3 min-w-[280px]"
        role="status"
        aria-live="polite"
      >
        <span className="text-sm">{toast.text}</span>
      </div>
    );
  }

  // toast.kind === "undo" — render with an Apple-Mail-style countdown
  // progress bar across the bottom of the row that drains as the undo
  // window expires. The bar makes the time-pressure visible instead of
  // forcing the user to guess how long they have to hit Undo.
  return <UndoToastRow toast={toast} onUndo={handleUndo} />;
}

function UndoToastRow({ toast, onUndo }: { toast: Toast & { kind: "undo" }; onUndo: () => void }) {
  // Total duration is captured the first time we see this toast. If the
  // toast was merged (expiresAt extended), totalMs grows to match —
  // the bar always fills the new full window and drains again. Without
  // this re-base, a merged toast would render at 0% even though it has
  // a fresh window.
  const baselineRef = useRef<{ start: number; total: number; expires: number }>({
    start: Date.now(),
    expires: toast.expiresAt,
    total: Math.max(1, toast.expiresAt - Date.now()),
  });
  if (toast.expiresAt !== baselineRef.current.expires) {
    const now = Date.now();
    baselineRef.current = {
      start: now,
      expires: toast.expiresAt,
      total: Math.max(1, toast.expiresAt - now),
    };
  }
  const [, setTick] = useState(0);
  useEffect(() => {
    // 16ms tick = 60fps. Cheap; the only work in render is a div width.
    // Auto-stops when expired.
    let raf = 0;
    const loop = () => {
      const remaining = baselineRef.current.expires - Date.now();
      if (remaining <= 0) return;
      setTick((t) => (t + 1) % 1_000_000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [toast.id, toast.expiresAt]);

  const remaining = Math.max(0, baselineRef.current.expires - Date.now());
  const pctRemaining = Math.max(0, Math.min(100, (remaining / baselineRef.current.total) * 100));

  return (
    <div
      className="relative bg-gray-900 dark:bg-gray-700 text-white rounded-lg shadow-lg overflow-hidden min-w-[280px]"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm">{toast.text}</span>
        <button
          onClick={onUndo}
          aria-label={`Undo (${UNDO_LABEL})`}
          title={UNDO_LABEL}
          className="ml-4 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0"
        >
          Undo
        </button>
      </div>
      {/* Drain-style countdown bar. Pinned to the bottom edge of the row,
          drains right-to-left in real time. When it hits zero the timer
          in ToastRow's effect commits the action and dismisses the row. */}
      <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/10">
        <div
          className="h-full bg-blue-400/80 transition-[width] ease-linear"
          style={{ width: `${pctRemaining}%`, transitionDuration: "16ms" }}
          aria-hidden
        />
      </div>
    </div>
  );
}

export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);

  // Single global Cmd+Z / Ctrl+Z handler. Walks the queue most-recent-first
  // and invokes the latest undoable toast. The four legacy components each
  // had their own listener with priority overrides; this is the only one.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "z" || e.shiftKey) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const queue = useToastStore.getState().toasts;
      for (let i = queue.length - 1; i >= 0; i--) {
        const t = queue[i];
        if (t.kind !== "undo") continue;
        e.preventDefault();
        e.stopImmediatePropagation();
        // Dismiss BEFORE running undoable so suppressEmailIds drops out of
        // the queue and addEmails(...) inside the callback isn't filtered.
        useToastStore.getState().dismissToast(t.id);
        void Promise.resolve(t.undoable()).catch((err) => {
          console.error("[Toast] undoable (Cmd+Z) failed:", err);
        });
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  );
}
