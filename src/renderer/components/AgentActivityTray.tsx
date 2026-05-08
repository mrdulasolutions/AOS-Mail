// Agent Activity tray — top-right titlebar popover surfacing recent LLM
// calls.
//
// Why this exists:
//   AOS Mail's V1 inbox agent silently triages, drafts, summarizes, and
//   looks up senders. The user has no view into what the agent did or
//   what it cost. The sidecar already records every Anthropic / OpenRouter
//   call into `llm_calls`; this tray surfaces the last ~15 calls, plus a
//   "today" badge, so the work is visible without leaving the inbox.
//
// Data flow:
//   - On mount, `usage.getStatsToday` fetches today's call count for the
//     badge. This refreshes every 60s so the count stays accurate without
//     hammering SQLite.
//   - When the popover opens, `usage.getHistoryWithSubjects(15)` fetches
//     the last 15 calls joined to email subjects. Refresh every 15s while
//     open (per the task brief).
//   - Outside-click closes the popover.
//
// What the tray does NOT do:
//   - No filtering / search — that lives in the Settings → Agent Tools →
//     Agent Activity sub-tab where we render the last 200 calls with the
//     full filter UI.
//   - No row expansion — the tray is a quick glance, not the full audit.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IpcResponse } from "../../shared/types";
import type {
  LlmCallRowWithSubject,
  UsageWindowStats,
} from "../../shared/sidecar-contract";

const TRAY_HISTORY_LIMIT = 15;
// Refresh while open. The sidebar polls llm_calls — cheap query but we
// don't want to thrash SQLite if a user leaves the popover open.
const TRAY_REFRESH_MS = 15_000;
// Badge refresh while closed. The badge is just a count; updating it
// every minute is plenty responsive.
const BADGE_REFRESH_MS = 60_000;

function formatTimeAgo(createdAt: string): string {
  // SQLite's `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" in UTC. We
  // explicitly tag it as UTC; otherwise the browser would parse it as
  // local time and the diffs would all be off by the user's TZ offset.
  const ts = new Date(createdAt.replace(" ", "T") + "Z").getTime();
  if (!Number.isFinite(ts)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatCostCents(cents: number): string {
  if (cents < 1) return `${(cents * 10).toFixed(1)}m¢`;
  return `${cents.toFixed(1)}¢`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function AgentActivityTray() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // "Today" badge — keeps polling at a low cadence even when the tray is
  // closed so the count is always reasonably fresh when the user glances.
  const { data: todayResult } = useQuery({
    queryKey: ["agent-activity", "stats-today"],
    queryFn: () =>
      window.api.usage.getStatsToday() as Promise<IpcResponse<UsageWindowStats>>,
    refetchInterval: BADGE_REFRESH_MS,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  // History — only fetch + poll while the tray is open. When closed, the
  // last data sticks around but isn't refreshed; on the next open the
  // first refetch happens immediately because of `staleTime: 0`.
  const { data: historyResult } = useQuery({
    queryKey: ["agent-activity", "tray-history"],
    queryFn: () =>
      window.api.usage.getCallHistoryWithSubjects(TRAY_HISTORY_LIMIT) as Promise<
        IpcResponse<LlmCallRowWithSubject[]>
      >,
    enabled: open,
    refetchInterval: open ? TRAY_REFRESH_MS : false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const todayStats =
    todayResult && todayResult.success ? todayResult.data : null;
  const history = useMemo<LlmCallRowWithSubject[]>(() => {
    if (!historyResult || !historyResult.success) return [];
    return historyResult.data;
  }, [historyResult]);

  // Outside-click handler — close on any pointerdown that isn't inside
  // our wrapper. Using `pointerdown` (not `click`) so the close fires
  // before any inner click on a button could re-open it through some
  // accident.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!wrapperRef.current || !target) return;
      if (!wrapperRef.current.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Esc closes too — basic keyboard nav.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const todayCount = todayStats?.totalCalls ?? 0;
  const todayCostCents = todayStats?.totalCostCents ?? 0;

  return (
    <div ref={wrapperRef} className="titlebar-no-drag relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 transition-colors"
        title={`Agent activity — ${todayCount} call${todayCount === 1 ? "" : "s"} today`}
        aria-label={`Agent activity — ${todayCount} calls today`}
        aria-expanded={open}
      >
        {/* Lightning-bolt glyph — communicates "agent ran something" */}
        <svg
          className="w-4 h-4 text-amber-500"
          fill="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
        <span className="text-xs font-medium tabular-nums">{todayCount}</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-96 max-w-[calc(100vw-2rem)] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg dark:shadow-black/40 z-50">
          <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Agent activity
            </h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {todayCount} today · {formatCostCents(todayCostCents)}
            </span>
          </div>

          {history.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
              No agent calls yet. The agent runs in the background as new
              email arrives.
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700/50">
              {history.map((row) => (
                <TrayRow key={row.id} row={row} />
              ))}
            </div>
          )}

          <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700 text-[11px] text-gray-500 dark:text-gray-400">
            Open Settings → Agent Tools → Agent Activity for the full log.
          </div>
        </div>
      )}
    </div>
  );
}

function TrayRow({ row }: { row: LlmCallRowWithSubject }) {
  const subject =
    row.email_subject?.trim() ||
    (row.email_id ? row.email_id : null) ||
    null;
  const success = row.success === 1;
  return (
    <div className="px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {row.caller}
            </span>
            <span
              className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                success ? "bg-green-500" : "bg-red-500"
              }`}
              title={success ? "Success" : "Failed"}
              aria-label={success ? "Success" : "Failed"}
            />
          </div>
          {subject && (
            <div
              className="text-xs text-gray-600 dark:text-gray-300 truncate mt-0.5"
              title={subject}
            >
              {subject}
            </div>
          )}
          <div className="text-[11px] text-gray-500 dark:text-gray-400 font-mono truncate mt-0.5">
            {row.model}
          </div>
        </div>
        <div className="flex-shrink-0 text-right tabular-nums">
          <div className="text-xs text-gray-700 dark:text-gray-300">
            {formatCostCents(row.cost_cents)}
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">
            {formatDuration(row.duration_ms)}
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">
            {formatTimeAgo(row.created_at)}
          </div>
        </div>
      </div>
    </div>
  );
}
