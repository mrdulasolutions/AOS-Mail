// Permissions tray — top-right titlebar dropdown listing agent activity
// awaiting the user's approval.
//
// Why this exists:
//   The Tier-1 "wake up to a finished inbox" feature relies on the agent
//   pre-staging actions (drafts, archives) but stopping short of pushing
//   the button. The tray is where the user batches through "yes / yes /
//   no / yes" without opening every thread. It's a sibling to
//   AgentActivityTray, not a replacement — that one shows what the agent
//   *did*; this one shows what it's *queued up*.
//
// Data flow:
//   - On mount, fetch `permissions.list(currentAccountId)`. Polls every
//     30s while open, every 60s while closed (much like AgentActivityTray's
//     today badge).
//   - Approve / Skip dispatch through the existing namespaces:
//       * draft kind: Approve = compose.send + drafts.save status='created';
//                     Skip   = drafts.save body='' (deletes the draft row).
//       * archive kind: Approve = emails.archiveThread + archiveReady.dismiss;
//                       Skip   = archiveReady.dismiss only.
//   - After Approve/Skip we mark the row as locally-handled (a Set in
//     state) so it disappears immediately even before the next poll
//     refreshes the source-of-truth.
//
// Skipped items just hide for the session (the underlying drafts/archive
// suggestions remain). Approved items are committed.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store";
import type { IpcResponse } from "../../shared/types";
import type { PermissionItem, PermissionsListResult } from "../../shared/sidecar-contract";

const POLL_OPEN_MS = 30_000;
const POLL_CLOSED_MS = 60_000;

export function PermissionsTray() {
  const [open, setOpen] = useState(false);
  // Locally-acked items — once Approve/Skip dispatches, we hide the row
  // immediately and keep it hidden until the next poll confirms the
  // underlying state changed. Prevents flicker when the user batches.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const currentAccountId = useAppStore((s) => s.currentAccountId);

  const { data: result } = useQuery({
    queryKey: ["permissions", "list", currentAccountId],
    queryFn: async (): Promise<IpcResponse<PermissionsListResult>> => {
      const raw = await window.api.permissions.list(currentAccountId ?? undefined);
      return raw as IpcResponse<PermissionsListResult>;
    },
    enabled: !!currentAccountId,
    refetchInterval: open ? POLL_OPEN_MS : POLL_CLOSED_MS,
    refetchOnWindowFocus: true,
    staleTime: open ? 0 : POLL_CLOSED_MS / 2,
  });

  const items = useMemo<PermissionItem[]>(() => {
    if (!result || !result.success) return [];
    return result.data.items.filter((it) => !hiddenIds.has(it.id));
  }, [result, hiddenIds]);

  // Outside-click + Esc close.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!wrapperRef.current || !target) return;
      if (!wrapperRef.current.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onApprove = async (item: PermissionItem) => {
    setHiddenIds((prev) => new Set([...prev, item.id]));
    try {
      if (item.kind === "draft") {
        await approveDraft(item);
      } else if (item.kind === "archive") {
        await approveArchive(item);
      }
    } catch (err) {
      // Re-show on failure so the user can retry.
      console.warn("[PermissionsTray] approve failed", err);
      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const onSkip = async (item: PermissionItem) => {
    setHiddenIds((prev) => new Set([...prev, item.id]));
    try {
      if (item.kind === "draft" && item.emailId) {
        // Skipping a pending draft = remove it. The user can always
        // regenerate via the email-detail "regenerate draft" action.
        await window.api.drafts.save(item.emailId, "");
      } else if (item.kind === "archive" && item.threadId) {
        await window.api.archiveReady.dismiss(item.threadId, item.accountId);
      }
    } catch (err) {
      console.warn("[PermissionsTray] skip failed", err);
      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const total = items.length;

  return (
    <div ref={wrapperRef} className="titlebar-no-drag relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 transition-colors"
        title={`Awaiting your approval — ${total} item${total === 1 ? "" : "s"}`}
        aria-label={`Permissions tray — ${total} pending`}
        aria-expanded={open}
      >
        {/* Checkmark-with-clock glyph for "queued up, waiting on you" */}
        <svg
          className={`w-4 h-4 ${total > 0 ? "text-blue-500" : "text-gray-400"}`}
          fill="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            fillRule="evenodd"
            d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm13.36-1.814a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z"
            clipRule="evenodd"
          />
        </svg>
        <span className="text-xs font-medium tabular-nums">{total}</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-[28rem] max-w-[calc(100vw-2rem)] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg dark:shadow-black/40 z-50">
          <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Awaiting your approval
            </h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">{total} pending</span>
          </div>

          {total === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
              You're caught up. The agent will queue suggestions here as it processes new email.
            </div>
          ) : (
            <div className="max-h-[28rem] overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700/50">
              {items.map((item) => (
                <PermissionRow
                  key={item.id}
                  item={item}
                  onApprove={() => onApprove(item)}
                  onSkip={() => onSkip(item)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PermissionRow({
  item,
  onApprove,
  onSkip,
}: {
  item: PermissionItem;
  onApprove: () => void;
  onSkip: () => void;
}) {
  const kindBadge =
    item.kind === "draft"
      ? {
          label: "Draft",
          className: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300",
        }
      : {
          label: "Archive",
          className: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300",
        };
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-2 mb-2">
        <span
          className={`px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider rounded ${kindBadge.className}`}
        >
          {kindBadge.label}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {item.subject || "(no subject)"}
          </div>
          <div
            className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2"
            title={item.reason ?? ""}
          >
            {item.preview}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onSkip}
          className="px-3 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
        >
          Skip
        </button>
        <button
          onClick={onApprove}
          className={`px-3 py-1 text-xs font-medium text-white rounded transition-colors ${
            item.kind === "draft"
              ? "bg-blue-600 hover:bg-blue-500"
              : "bg-emerald-600 hover:bg-emerald-500"
          }`}
        >
          {item.kind === "draft" ? "Send" : "Archive"}
        </button>
      </div>
    </div>
  );
}

// ─── Approve dispatchers ───────────────────────────────────────────────

/**
 * Send a pending draft via compose.send. We pull the draft row + the
 * source email from the renderer's store cache where possible (cheap),
 * then build the ComposeSendInput. After the send succeeds we mark the
 * draft as 'created' so it doesn't reappear on the next poll.
 *
 * NOTE: this is the simple-send path. The richer compose flow with
 * attachments / signature insertion lives in ComposeEditor; for the
 * tray's "I trust the draft, send it" gesture we use the body verbatim.
 */
async function approveDraft(item: PermissionItem): Promise<void> {
  if (!item.emailId) throw new Error("draft permission item missing emailId");

  // Pull the email + draft so we know who to send to. The thread row in
  // the store already has the from/to/cc; we read it via the existing
  // sync.getEmails call's cache through React Query — but the simplest
  // contract is to ask the sidecar for the thread once.
  const threadResult = (await window.api.emails.getThread(
    item.threadId ?? item.emailId,
    item.accountId,
  )) as IpcResponse<unknown> | undefined;
  if (!threadResult || !threadResult.success) {
    throw new Error("failed to fetch thread for send");
  }
  const thread = threadResult.data as Array<{
    id: string;
    from: string;
    to: string;
    cc: string | null;
    subject: string;
    messageId: string | null;
    threadId: string;
    draft?: { body: string };
  }>;
  const sourceEmail = thread.find((e) => e.id === item.emailId) ?? thread[thread.length - 1];
  if (!sourceEmail) throw new Error("source email not found in thread");

  // Find the draft body. The thread row should carry it; if not, fall
  // back to fetching via emails namespace.
  const draftBody = sourceEmail.draft?.body ?? null;
  if (!draftBody) {
    // Defensive: skip this approval if the draft has gone missing —
    // common cause is a regen race. The UI marks it hidden; next poll
    // either re-surfaces it or it stays gone.
    throw new Error("draft body unavailable; regenerate first");
  }

  // Reply-to the source: To = original From, Subject prefixed with Re:
  // if not already.
  const recipient = extractEmail(sourceEmail.from);
  const subject = sourceEmail.subject.toLowerCase().startsWith("re:")
    ? sourceEmail.subject
    : `Re: ${sourceEmail.subject}`;

  const sendInput = {
    accountId: item.accountId,
    to: [recipient],
    subject,
    bodyText: draftBody,
    threadId: sourceEmail.threadId,
    inReplyTo: sourceEmail.messageId ?? undefined,
  };

  const sendResult = (await window.api.compose.send(sendInput)) as IpcResponse<unknown> | undefined;
  if (!sendResult || !sendResult.success) {
    throw new Error((sendResult as { error?: string } | undefined)?.error ?? "compose.send failed");
  }

  // Drop the draft row by saving an empty body (the existing drafts.save
  // contract: empty body = delete row).
  await window.api.drafts.save(item.emailId, "");
}

/**
 * Archive a thread: archives via the existing emails namespace, then
 * dismisses the archive_ready row so the same thread doesn't re-promote.
 */
async function approveArchive(item: PermissionItem): Promise<void> {
  if (!item.threadId) throw new Error("archive permission item missing threadId");
  const archResult = (await window.api.emails.archiveThread(item.threadId, item.accountId)) as
    | IpcResponse<unknown>
    | undefined;
  if (!archResult || !archResult.success) {
    throw new Error((archResult as { error?: string } | undefined)?.error ?? "archive failed");
  }
  await window.api.archiveReady.dismiss(item.threadId, item.accountId);
}

function extractEmail(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m?.[1] ?? raw).trim();
}
