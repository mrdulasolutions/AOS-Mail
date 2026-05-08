import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { triggerUndoForActionId } from "./UndoActionToast";

/**
 * Surface for the Space-bar smart action key. Mirrors UndoActionToast's
 * styling so the bottom-left toast stack stays visually consistent, but
 * narrates the picked smart action ("Archived — Cmd+Z to undo",
 * "Draft opened", etc.) instead of the generic "Thread archived."
 *
 * Why a separate toast vs. reusing UndoActionToast directly:
 *   - Some smart actions (open-draft, generate-draft) are *not* undoable
 *     — they belong on the toast surface but not on the undo queue.
 *   - The narration is action-specific ("Draft opened" makes no sense
 *     coming from an undo entry).
 *
 * The 5s self-dismiss timer is independent of the linked UndoActionItem
 * timer (when there is one). When the smart toast is linked to an undo
 * action, clicking Undo calls back into UndoActionToast's shared
 * cancelHandlers via triggerUndoForActionId — the heavy lifting of
 * restoring optimistic state still lives there.
 *
 * Cmd+Z while this toast is on screen is handled by UndoActionToast's
 * existing keyboard listener (since the linked undo item is in the queue);
 * we don't need a redundant listener here.
 */
export function SmartActionToast() {
  const toast = useAppStore((s) => s.smartActionToast);
  const setSmartActionToast = useAppStore((s) => s.setSmartActionToast);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Self-dismiss after delayMs. Re-runs whenever a new toast lands (id +
  // scheduledAt change together) so back-to-back actions cleanly restart
  // the timer. We list every dependency the effect reads — depending on
  // toast?.id alone causes the lint to flag the field accesses below.
  useEffect(() => {
    if (!toast) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const remaining = Math.max(0, toast.scheduledAt + toast.delayMs - Date.now());
    timerRef.current = setTimeout(() => {
      setSmartActionToast(null);
    }, remaining);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast, setSmartActionToast]);

  if (!toast) return null;

  const isUndoable = Boolean(toast.undoActionId);
  const undoLabel = navigator.platform.includes("Mac") ? "Cmd+Z" : "Ctrl+Z";

  const handleUndo = () => {
    if (!toast.undoActionId) return;
    const ok = triggerUndoForActionId(toast.undoActionId);
    if (ok) {
      // Match the user's mental model: undoing also dismisses the toast.
      setSmartActionToast(null);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-gray-900 dark:bg-gray-700 text-white rounded-lg shadow-lg flex items-center justify-between px-4 py-3 min-w-[280px]"
    >
      <span className="text-sm">
        {toast.message}
        {isUndoable ? <span className="text-gray-400 ml-2">— {undoLabel} to undo</span> : null}
      </span>
      {isUndoable && (
        <button
          onClick={handleUndo}
          aria-label={`Undo (${undoLabel})`}
          className="ml-4 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0"
          title={undoLabel}
        >
          Undo
        </button>
      )}
    </div>
  );
}
