// Morning Briefing — Tier-1 "wake up to a finished inbox" panel.
//
// Renders as a take-over view (in place of the inbox) on the first open
// of the day, when the user has a current account selected and there's
// either a cached briefing or one we can generate. The briefing itself
// is a 3-paragraph plain-English narrative produced by Claude in the
// sidecar (services/morning-briefing.ts); above it sit four stat cards
// driven by the sidecar's row.stats; below sits a "Got it — open inbox"
// button that dismisses for the day.
//
// Data flow:
//   - On mount, fire `briefing.getOrGenerate(accountId)` via React Query.
//     The sidecar returns the cached row or generates a new one. We
//     intentionally don't show a spinner on the cached path — the row
//     comes back in <50ms.
//   - The "Got it" button calls `briefing.dismiss(accountId, date)` and
//     immediately invalidates the query so the parent unmounts us.
//   - The action-item row is a quick "jump to thread" link (sets
//     selectedEmailId in the store).
//
// No internal state — everything derives from the briefing row + store.

import { useMemo } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useAppStore } from "../store";
import type { IpcResponse } from "../../shared/types";
import type { DailyBriefing } from "../../shared/sidecar-contract";

interface MorningBriefingProps {
  /** Called once dismissed so the parent can swap back to the inbox. */
  onDismissed?: () => void;
}

export function MorningBriefing({ onDismissed }: MorningBriefingProps) {
  const currentAccountId = useAppStore((s) => s.currentAccountId);
  const currentAccount = useAppStore((s) => s.accounts.find((a) => a.id === s.currentAccountId));
  const setSelectedEmailId = useAppStore((s) => s.setSelectedEmailId);
  const setSelectedThreadId = useAppStore((s) => s.setSelectedThreadId);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const setCurrentSplitId = useAppStore((s) => s.setCurrentSplitId);
  const queryClient = useQueryClient();

  const { data: briefingResult, isLoading } = useQuery({
    queryKey: ["briefing", currentAccountId],
    queryFn: async (): Promise<IpcResponse<DailyBriefing>> => {
      if (!currentAccountId) return { success: false, error: "no account selected" };
      const raw = await window.api.briefing.getOrGenerate(currentAccountId);
      return raw as IpcResponse<DailyBriefing>;
    },
    enabled: !!currentAccountId,
    staleTime: 60 * 60 * 1000, // 1 hour — briefings don't change throughout the day
    refetchOnWindowFocus: false,
  });

  const briefing = briefingResult && briefingResult.success ? briefingResult.data : null;

  const dismissMutation = useMutation({
    mutationFn: async () => {
      if (!currentAccountId || !briefing) return;
      await window.api.briefing.dismiss(currentAccountId, briefing.date);
    },
    onSuccess: () => {
      // Invalidate BOTH our local query AND the parent App.tsx's gate query
      // (`["briefing-gate", ...]`). Without invalidating the gate the
      // parent's `showMorningBriefing` flag stays true and the dismiss
      // button appears to do nothing. The two queries hit the same RPC
      // (briefing.getOrGenerate) but were keyed differently for caching
      // independence — invalidate both so dismiss propagates.
      queryClient.invalidateQueries({ queryKey: ["briefing", currentAccountId] });
      queryClient.invalidateQueries({ queryKey: ["briefing-gate", currentAccountId] });
      // Land the user on Priority — the briefing summarised exactly the
      // threads that live in the Priority bucket (analysis.needsReply=true).
      // Without this, dismiss leaves the user on whatever split was active
      // before (default "__other__"), which is structurally `chronological
      // MINUS priority` — i.e. the *complement* of what was just briefed.
      // Reads as a blank/empty inbox for any user whose action items
      // dominate. See store/index.ts:2032 for the Other filter.
      setCurrentSplitId("__priority__");
      onDismissed?.();
    },
  });

  // Format the 3 paragraphs from the LLM. The prompt requires \n\n
  // separators; we split, trim, and render each in its own <p>.
  const paragraphs = useMemo(() => {
    if (!briefing) return [];
    return briefing.briefingText
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }, [briefing]);

  const handleJumpToThread = (item: DailyBriefing["actionItems"][number]) => {
    // Switching to "full" view + selecting the email opens the thread.
    setSelectedThreadId(item.threadId);
    setSelectedEmailId(item.emailId);
    setViewMode("full");
    // Auto-dismiss the briefing — clicking through implies we're done
    // reading it. The user can always scroll back via list().
    dismissMutation.mutate();
  };

  if (!currentAccountId) {
    return null;
  }

  if (isLoading || !briefing) {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center bg-white dark:bg-gray-900">
        <div className="flex flex-col items-center gap-3 text-gray-500 dark:text-gray-400">
          <svg className="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden>
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
          <span className="text-sm">Putting together your morning briefing…</span>
        </div>
      </div>
    );
  }

  // Friendly greeting + visual theme based on local time-of-day. The
  // briefing panel changes colors and label so the morning version feels
  // sunrise-warm and the evening version feels twilight-cool.
  const hour = new Date().getHours();
  const timeOfDay: "early" | "morning" | "afternoon" | "evening" =
    hour < 5 ? "early" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const greeting = {
    early: "Late night",
    morning: "Good morning",
    afternoon: "Good afternoon",
    evening: "Good evening",
  }[timeOfDay];
  // Per-time gradient + accent. Morning = sunrise amber. Afternoon = mid-day
  // sky. Evening = twilight indigo. Late night = deep ink. Each tone has
  // both light + dark variants tuned so the underlying card chrome reads.
  const themeBg = {
    early:
      "bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 dark:from-slate-900 dark:via-slate-950 dark:to-slate-950",
    morning:
      "bg-gradient-to-b from-amber-50 via-white to-white dark:from-amber-950/30 dark:via-gray-900 dark:to-gray-900",
    afternoon:
      "bg-gradient-to-b from-sky-50 via-white to-white dark:from-sky-950/30 dark:via-gray-900 dark:to-gray-900",
    evening:
      "bg-gradient-to-b from-indigo-100 via-purple-50 to-white dark:from-indigo-950 dark:via-purple-950/40 dark:to-gray-900",
  }[timeOfDay];
  const accentText = {
    early: "text-slate-300",
    morning: "text-amber-700 dark:text-amber-400",
    afternoon: "text-sky-700 dark:text-sky-400",
    evening: "text-indigo-600 dark:text-indigo-300",
  }[timeOfDay];
  const headingText = {
    early: "text-slate-100",
    morning: "text-gray-900 dark:text-gray-100",
    afternoon: "text-gray-900 dark:text-gray-100",
    evening: "text-gray-900 dark:text-gray-100",
  }[timeOfDay];
  const eyebrowLabel = {
    early: "Late-night briefing",
    morning: "Morning briefing",
    afternoon: "Afternoon briefing",
    evening: "Evening briefing",
  }[timeOfDay];
  const accountLabel = currentAccount?.email ?? "";

  return (
    <div className={`flex-1 min-w-0 overflow-y-auto ${themeBg}`} data-testid="morning-briefing">
      <div className="max-w-3xl mx-auto px-8 py-12">
        {/* Header */}
        <div className="mb-8">
          <div className={`flex items-center gap-2 text-sm ${accentText} mb-2`}>
            {timeOfDay === "morning" || timeOfDay === "afternoon" ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path d="M12 1.5a.75.75 0 01.75.75V4.5a.75.75 0 01-1.5 0V2.25A.75.75 0 0112 1.5zM5.636 4.575a.75.75 0 011.06 0l1.591 1.59a.75.75 0 11-1.06 1.061L5.636 5.636a.75.75 0 010-1.061zm12.728 0a.75.75 0 010 1.061l-1.591 1.59a.75.75 0 01-1.06-1.06l1.59-1.591a.75.75 0 011.061 0zM12 6a6 6 0 100 12 6 6 0 000-12zm-9.75 6a.75.75 0 01.75-.75H4.5a.75.75 0 010 1.5H3a.75.75 0 01-.75-.75zM18.75 12a.75.75 0 01.75-.75H21a.75.75 0 010 1.5h-1.5a.75.75 0 01-.75-.75zM5.636 18.364a.75.75 0 010-1.061l1.59-1.59a.75.75 0 011.061 1.06l-1.59 1.591a.75.75 0 01-1.061 0zm12.728 0a.75.75 0 01-1.061 0l-1.59-1.59a.75.75 0 011.06-1.061l1.591 1.59a.75.75 0 010 1.061zM12 19.5a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0V20.25a.75.75 0 01.75-.75z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path d="M21.752 15.002A9.72 9.72 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
              </svg>
            )}
            <span className="font-medium uppercase tracking-wider text-xs">{eyebrowLabel}</span>
          </div>
          <h1 className={`text-3xl font-semibold ${headingText}`}>{greeting}.</h1>
          {accountLabel && (
            <p
              className={
                timeOfDay === "early"
                  ? "text-sm text-slate-400 mt-1"
                  : "text-sm text-gray-500 dark:text-gray-400 mt-1"
              }
            >
              {accountLabel} · {formatPrettyDate(briefing.date)}
            </p>
          )}
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <StatCard label="Need your reply" value={briefing.stats.needsReplyCount} tone="urgent" />
          <StatCard label="Auto-handled" value={briefing.stats.autoHandledCount} tone="success" />
          <StatCard label="Drafts ready" value={briefing.stats.draftsReadyCount} tone="info" />
          <StatCard label="Snoozed" value={briefing.stats.snoozedCount} tone="muted" />
        </div>

        {/* The briefing itself */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm p-7 mb-6">
          <div className="prose prose-sm max-w-none dark:prose-invert">
            {paragraphs.length === 0 ? (
              <p className="text-gray-700 dark:text-gray-200 leading-relaxed">
                {briefing.briefingText}
              </p>
            ) : (
              paragraphs.map((p, i) => (
                <p
                  key={i}
                  className="text-gray-700 dark:text-gray-200 leading-relaxed mb-4 last:mb-0"
                >
                  {p}
                </p>
              ))
            )}
          </div>
        </div>

        {/* Action items — clickable links to the underlying threads. */}
        {briefing.actionItems.length > 0 && (
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm p-5 mb-6">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wider mb-3">
              Threads waiting on you
            </h2>
            <ul className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {briefing.actionItems.slice(0, 6).map((item) => (
                <li key={item.emailId}>
                  <button
                    onClick={() => handleJumpToThread(item)}
                    className="w-full text-left py-2.5 group hover:bg-gray-50 dark:hover:bg-gray-700/50 -mx-2 px-2 rounded transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <PriorityDot priority={item.priority} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {item.subject}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                          {item.fromName ?? item.fromEmail} · {item.reason}
                        </div>
                      </div>
                      <svg
                        className="w-4 h-4 text-gray-300 group-hover:text-gray-500 dark:group-hover:text-gray-300 mt-0.5 flex-shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5l7 7-7 7"
                        />
                      </svg>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Dismiss CTA */}
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={() => dismissMutation.mutate()}
            disabled={dismissMutation.isPending}
            className="px-5 py-2.5 bg-gray-900 dark:bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {dismissMutation.isPending ? "…" : "Got it — open inbox"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "urgent" | "success" | "info" | "muted";
}) {
  const toneClasses = {
    urgent:
      "bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800/50 text-rose-900 dark:text-rose-200",
    success:
      "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/50 text-emerald-900 dark:text-emerald-200",
    info: "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/50 text-blue-900 dark:text-blue-200",
    muted:
      "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300",
  }[tone];
  return (
    <div className={`rounded-lg border p-4 ${toneClasses}`}>
      <div className="text-2xl font-semibold tabular-nums leading-none">{value}</div>
      <div className="text-xs mt-1.5 opacity-80">{label}</div>
    </div>
  );
}

function PriorityDot({ priority }: { priority: "high" | "medium" | "low" }) {
  const cls = {
    high: "bg-rose-500",
    medium: "bg-amber-500",
    low: "bg-gray-400",
  }[priority];
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${cls}`}
      aria-label={`${priority} priority`}
      title={`${priority} priority`}
    />
  );
}

function formatPrettyDate(iso: string): string {
  // "2026-05-08" → "Friday, May 8"
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
