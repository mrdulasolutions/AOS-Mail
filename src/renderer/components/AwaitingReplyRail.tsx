// Awaiting Reply rail entry — sibling above the FolderRail.
//
// Shows a single "Awaiting Reply" row with a count badge. Clicking it
// flips the store into the "awaiting-reply" view mode which mounts the
// AwaitingReplyView component in the main pane.
//
// The badge polls the same sidecar method as the view, but at a slower
// cadence (5 minutes) and per current account only. We live with a
// possible stale count between polls — accuracy isn't load-bearing for
// a left-rail badge.

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store";
import type { AwaitingReplyThreadRow } from "../../shared/sidecar-contract";

type IpcShape<T> = { success: true; data: T } | { success: false; error: string };

const POLL_INTERVAL_MS = 5 * 60 * 1000;

export function AwaitingReplyRail() {
  const accounts = useAppStore((s) => s.accounts);
  const currentAccountId = useAppStore((s) => s.currentAccountId);
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);

  const [count, setCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!currentAccountId) {
      setCount(null);
      return;
    }
    try {
      const api = (
        window.api as {
          awaitingReply: {
            list: (accountId: string) => Promise<IpcShape<AwaitingReplyThreadRow[]>>;
          };
        }
      ).awaitingReply;
      const result = await api.list(currentAccountId);
      if (result.success) {
        setCount(result.data.length);
      }
    } catch {
      // Silent — the rail badge isn't worth surfacing an error for.
    }
  }, [currentAccountId]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (accounts.length === 0) return null;

  const isActive = viewMode === "awaiting-reply";
  const badge = count !== null && count > 0 ? count : null;

  return (
    <button
      type="button"
      onClick={() => setViewMode("awaiting-reply")}
      data-testid="awaiting-reply-rail-entry"
      className={`w-full text-left text-sm pl-3 pr-2 py-1.5 mb-1 flex items-center gap-2 transition-colors ${
        isActive
          ? "bg-aos-bg-sunk text-aos-text font-medium"
          : "text-aos-text-soft hover:bg-aos-bg-sunk hover:text-aos-text"
      }`}
    >
      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <span className="flex-1 truncate">Awaiting Reply</span>
      {badge !== null && (
        <span
          className={`text-xs px-1.5 py-0.5 rounded ${
            isActive ? "bg-aos-bg text-aos-text" : "bg-aos-bg-soft text-aos-text-soft"
          }`}
          data-testid="awaiting-reply-count"
        >
          {badge}
        </span>
      )}
    </button>
  );
}
