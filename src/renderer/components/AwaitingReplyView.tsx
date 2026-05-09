// Awaiting Reply view — smart inbox of threads where the user sent the
// latest message and is still waiting on a response.
//
// Each row shows: subject, recipients, days-since-sent, and a "Draft a
// nudge" button. Clicking the button asks the sidecar for a Claude-
// composed follow-up, then opens the inline-reply composer in the
// thread with the draft prefilled.
//
// The list refreshes when the view mounts and every 5 minutes while
// open. We deliberately do NOT poll while hidden — the rail badge
// fetches its own count separately.

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store";
import { draftBodyToHtml } from "../../shared/draft-utils";
import type { AwaitingReplyThreadRow } from "../../shared/sidecar-contract";

type IpcShape<T> = { success: true; data: T } | { success: false; error: string };

// How often to refresh the list while the view is mounted. 5 minutes
// matches the spec; the user can also force a refresh with the button.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface AwaitingReplyApi {
  list: (
    accountId: string,
    opts?: { thresholdDays?: number },
  ) => Promise<IpcShape<AwaitingReplyThreadRow[]>>;
  draftNudge: (threadId: string, accountId: string) => Promise<IpcShape<{ body: string }>>;
}

function getApi(): AwaitingReplyApi {
  // window.api is typed as `any` (see types/window-api.ts) — the shim
  // routes the call through the bridge; the contract pins the shape.
  return (window.api as { awaitingReply: AwaitingReplyApi }).awaitingReply;
}

/**
 * Format a recipient list for display. Strips display-name fragments
 * (already done by the detector) and joins with commas. Long lists fall
 * back to "first, +N" so the row stays single-line.
 */
function formatRecipients(emails: string[]): string {
  if (emails.length === 0) return "(no recipient)";
  if (emails.length <= 2) return emails.join(", ");
  return `${emails[0]}, +${emails.length - 1}`;
}

function formatDaysSince(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

interface RowProps {
  row: AwaitingReplyThreadRow;
  onDrafted: (row: AwaitingReplyThreadRow, body: string) => void;
}

function AwaitingReplyRow({ row, onDrafted }: RowProps) {
  const [isDrafting, setIsDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDraft = useCallback(async () => {
    setIsDrafting(true);
    setError(null);
    try {
      const result = await getApi().draftNudge(row.threadId, row.accountId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      try {
        onDrafted(row, result.data.body);
      } catch (err) {
        // handleDrafted throws when the thread isn't loaded into the store
        // yet — surface that locally so the user sees what to do.
        setError(err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDrafting(false);
    }
  }, [row, onDrafted]);

  return (
    <li
      className="flex items-center gap-3 px-4 py-3 border-b border-aos-line hover:bg-aos-bg-sunk transition-colors"
      data-testid="awaiting-reply-row"
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-aos-text truncate" title={row.subject}>
          {row.subject || "(no subject)"}
        </div>
        <div className="text-xs text-aos-text-soft mt-0.5 truncate">
          To {formatRecipients(row.recipientEmails)} · sent {formatDaysSince(row.daysSince)}
        </div>
        {error && (
          <div className="text-xs text-red-500 mt-1" title={error}>
            {error}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleDraft}
        disabled={isDrafting}
        className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-md bg-aos-bg-soft border border-aos-line hover:bg-aos-bg-sunk text-aos-text disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isDrafting ? "Drafting…" : "Draft a nudge"}
      </button>
    </li>
  );
}

export function AwaitingReplyView() {
  const currentAccountId = useAppStore((s) => s.currentAccountId);
  const setSelectedThreadId = useAppStore((s) => s.setSelectedThreadId);
  const setSelectedEmailId = useAppStore((s) => s.setSelectedEmailId);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const openCompose = useAppStore((s) => s.openCompose);

  const [rows, setRows] = useState<AwaitingReplyThreadRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentAccountId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getApi().list(currentAccountId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      setRows(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [currentAccountId]);

  // Refresh on mount and on account switch.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Periodic background refresh — only while this view is mounted.
  useEffect(() => {
    const id = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const handleDrafted = useCallback(
    (row: AwaitingReplyThreadRow, body: string) => {
      // Pivot the user back into the thread with the inline-reply composer
      // open and the nudge prefilled. The trick is `openCompose("reply",
      // undefined, ...)` doesn't actually work — EmailDetail's compose
      // useEffect calls `compose.getReplyInfo(replyToEmailId, ...)` which
      // errors on undefined and then RESETS the composer back to null,
      // making the prefilled body flash and disappear. So we need a real
      // replyToEmailId. Pull the latest sent message in this thread from
      // the store — the detector already proved one exists, and the
      // store is populated from the same sync.getEmails the inbox uses.
      const state = useAppStore.getState();
      // Look in BOTH inbox and sent caches. Previously this only filtered
      // `state.emails` (inbox) for SENT-labeled rows — which works for
      // Gmail but misses IMAP accounts where sent messages live in a
      // separate store list (`sentEmails`). Without the sent message in
      // the search the function threw "Couldn't find the original
      // message…" even though the thread was visible — the user reported
      // exactly this with a draft created but no navigation.
      const inboxInThread = state.emails.filter((e) => e.threadId === row.threadId);
      const sentInThread = state.sentEmails.filter((e) => e.threadId === row.threadId);
      const sentByLabel = inboxInThread.filter((e) => e.labelIds?.includes("SENT"));
      // Combined candidate list — sent-folder messages first, then any
      // inbox row that the provider tagged with the SENT label, then the
      // newest message in the thread overall as a last-resort fallback so
      // the composer always has SOMETHING to attach to.
      const candidates = [...sentInThread, ...sentByLabel];
      const latestSent = candidates.sort((a, b) => b.date.localeCompare(a.date))[0];
      const lastResort = inboxInThread.sort((a, b) => b.date.localeCompare(a.date))[0];
      const replyAnchor = latestSent ?? lastResort;

      setSelectedThreadId(row.threadId);
      setSelectedEmailId(replyAnchor?.id ?? null);
      setViewMode("full");

      if (!replyAnchor) {
        // Genuine fallback: thread isn't in either store (user opened
        // nudge view before any sync finished). Surface a clear error so
        // the row's caller can render it inline.
        throw new Error(
          "Couldn't find the original message in your inbox. Refresh and try again.",
        );
      }

      openCompose("reply", replyAnchor.id, {
        bodyHtml: draftBodyToHtml(body),
        bodyText: body,
        skipAutoFocus: false,
      });
    },
    [setSelectedThreadId, setSelectedEmailId, setViewMode, openCompose],
  );

  return (
    <div
      className="flex-1 flex flex-col bg-aos-bg overflow-hidden"
      data-testid="awaiting-reply-view"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-aos-line">
        <div>
          <h2 className="text-sm font-semibold text-aos-text">Awaiting Reply</h2>
          <p className="text-xs text-aos-text-soft mt-0.5">
            Threads where you sent the last message and haven&apos;t heard back.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="px-3 py-1 text-xs font-medium rounded-md hover:bg-aos-bg-sunk text-aos-text-soft disabled:opacity-50 transition-colors"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="px-4 py-3 text-sm text-red-500 border-b border-aos-line" title={error}>
            Failed to load: {error}
          </div>
        )}
        {!loading && !error && rows.length === 0 && (
          <div className="px-4 py-8 text-sm text-aos-text-soft text-center">
            No threads waiting on a reply.
          </div>
        )}
        <ul>
          {rows.map((row) => (
            <AwaitingReplyRow key={row.threadId} row={row} onDrafted={handleDrafted} />
          ))}
        </ul>
      </div>
    </div>
  );
}
