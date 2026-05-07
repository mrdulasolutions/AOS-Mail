import { useAppStore } from "../store";

export function OfflineBanner() {
  const { isOnline, outboxStats } = useAppStore();

  // Don't show if online
  if (isOnline) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="titlebar-drag border-b pl-20 pr-4 py-2 flex items-center justify-between"
      style={{
        background: "var(--aos-warning-soft)",
        borderColor: "#fde68a",
      }}
    >
      <div className="flex items-center gap-2 text-[#92400e]">
        <svg
          className="w-4 h-4 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414"
          />
        </svg>
        <span className="text-sm font-medium">You're offline</span>
        <span className="text-sm opacity-80">Messages will send when you reconnect.</span>
      </div>
      {outboxStats.pending > 0 && (
        <span className="text-sm font-medium text-[#92400e]">
          {outboxStats.pending} message{outboxStats.pending !== 1 ? "s" : ""} queued
        </span>
      )}
    </div>
  );
}
