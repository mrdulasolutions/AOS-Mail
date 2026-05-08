import { useAppStore } from "../store";

/**
 * Tiny toast surfaced while triage.analyzeBatch is in flight.
 *
 * Two entry points push state here:
 *   1. Auto catch-up at boot — once the first sync pass settles, App.tsx
 *      sweeps any unanalyzed inbox emails into a single batch and surfaces
 *      "Triaging N emails…" until the call resolves.
 *   2. Manual "Triage All" button on the inbox toolbar (EmailList.tsx)
 *      uses the same surface with `source: "manual"`.
 *
 * The toast is intentionally read-only — there's nothing to undo. It clears
 * itself when triageStatus goes back to null. Sits in the same fixed
 * bottom-left stack as the other toasts in App.tsx.
 */
export function TriageStatusToast() {
  const triageStatus = useAppStore((s) => s.triageStatus);
  if (!triageStatus) return null;

  const { count } = triageStatus;
  const label = count === 1 ? "Triaging 1 email…" : `Triaging ${count.toLocaleString()} emails…`;

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
      <span className="text-sm">{label}</span>
    </div>
  );
}
