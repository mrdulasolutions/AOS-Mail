// Helpers for queuing common undo toasts. Wraps the optimistic-update +
// commit-on-expire + revert-on-undo pattern so call sites don't have to
// re-spell `pushToast({kind:"undo", ... batchArchive(...) ... })` by hand.
//
// Each helper:
//   1. Captures the data needed to revert (the full email rows for archive,
//      previous label arrays for star/mark-unread, thread ids for snooze).
//   2. Builds an undo toast spec with `undoable` (revert in store) +
//      `onExpire` (commit to gmail) + `suppressEmailIds` (so sync doesn't
//      resurrect the email mid-undo-window).
//
// Call sites still do the optimistic update themselves before calling here
// — that mirrors the legacy contract and avoids surprising store mutations
// inside a "queue toast" call.

import type { ComposeMode, DashboardEmail } from "../../shared/types";
import type { ComposeSendInput } from "../../shared/window-api";
import { useAppStore } from "../store";
import { useToastStore } from "./toast-store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = () => (window as any).api;

const UNDO_DELAY_MS = 5_000;

function pluralThreadCount(n: number): string {
  return n === 1 ? "Thread" : `${n} threads`;
}

/**
 * Build a label like "Thread archived." / "3 threads deleted." matching the
 * legacy UndoActionToast wording. Exported because the smart-action key
 * narration ("Archived — Cmd+Z to undo") tweaks it slightly.
 */
export function describeUndoAction(
  type: "archive" | "trash" | "mark-unread" | "star" | "unstar" | "snooze",
  threadCount: number,
): string {
  const noun = pluralThreadCount(threadCount);
  switch (type) {
    case "archive":
      return `${noun} archived.`;
    case "trash":
      return `${noun} deleted.`;
    case "mark-unread":
      return `${noun} marked unread.`;
    case "star":
      return `${noun} starred.`;
    case "unstar":
      return `${noun} unstarred.`;
    case "snooze":
      return `${noun} snoozed.`;
  }
}

interface ArchiveOpts {
  emails: DashboardEmail[];
  accountId: string;
  threadCount: number;
  // Archive-ready view: thread ids to dismiss from the archive-ready set
  // when the commit succeeds.
  archiveReadyThreadIds?: string[];
  // Override the default "Thread archived." narration. Used by the smart-
  // action key path which says "Archived — Cmd+Z to undo".
  text?: string;
}

/**
 * Push an undo toast for an archive action. Caller has already done the
 * optimistic `removeEmails` / `removeEmailsAndAdvance`. Returns the toast
 * id so the smart-action picker can correlate (e.g. dismiss the toast on
 * success of the linked action — though in practice nothing does today).
 */
export function pushArchiveUndo(opts: ArchiveOpts): string {
  const { emails, accountId, threadCount, archiveReadyThreadIds, text } = opts;
  const emailIds = emails.map((e) => e.id);
  return useToastStore.getState().pushToast({
    kind: "undo",
    text: text ?? describeUndoAction("archive", threadCount),
    expiresAt: Date.now() + UNDO_DELAY_MS,
    suppressEmailIds: emailIds,
    // Same account + same kind → merge so rapid-fire archives roll up into
    // one row. Different accounts stay separate.
    mergeKey: `archive:${accountId}`,
    mergeUpdate: (prior, incoming) => {
      const mergedIds = [...(prior.suppressEmailIds ?? []), ...(incoming.suppressEmailIds ?? [])];
      // Re-derive the count from the email-id list. Cheap and avoids
      // having to thread threadCount through the merge type.
      const total = mergedIds.length;
      // Approximate thread count as id count — close enough for the toast
      // copy, and matches how the legacy code summed `threadCount` directly.
      const totalThreads = total;
      return {
        text: describeUndoAction("archive", totalThreads),
        suppressEmailIds: mergedIds,
      };
    },
    undoable: () => {
      // Restore the optimistically-removed emails.
      useAppStore.getState().addEmails(emails);
    },
    onExpire: async () => {
      // For archive, only call the API on INBOX-labeled emails (archiving
      // SENT/other emails is a no-op). Treat null/undefined labelIds as
      // INBOX (matches server-side getInboxEmails query).
      const emailsToExecute = emails.filter((e) => !e.labelIds || e.labelIds.includes("INBOX"));
      const idsToExecute = emailsToExecute.map((e) => e.id);
      if (idsToExecute.length === 0) {
        // Nothing to commit (e.g. all SENT). Still dismiss archive-ready.
      } else {
        try {
          const result = (await api().emails.batchArchive(idsToExecute, accountId)) as {
            success: boolean;
            error?: string;
            failedIds?: string[];
          };
          if (!result.success) {
            // Restore failed emails so they reappear in the inbox.
            const failedIdSet = result.failedIds
              ? new Set(result.failedIds)
              : new Set(idsToExecute);
            const failed = emailsToExecute.filter((e) => failedIdSet.has(e.id));
            if (failed.length > 0) {
              console.error(
                `[Archive] Batch archive failed, restoring ${failed.length} emails:`,
                result.error,
              );
              useAppStore.getState().addEmails(failed);
            }
          }
        } catch (err) {
          console.error("[Archive] batchArchive rejected:", err);
          useAppStore.getState().addEmails(emailsToExecute);
        }
      }
      // Archive-ready cleanup: only dismiss threads whose emails all
      // succeeded. We can't tell from here without re-running the result
      // matching, so be conservative and dismiss all on success path —
      // the legacy code did the same.
      if (archiveReadyThreadIds && archiveReadyThreadIds.length > 0) {
        const store = useAppStore.getState();
        for (const threadId of archiveReadyThreadIds) {
          store.removeArchiveReadyThread(threadId);
          api()
            .archiveReady.dismiss(threadId, accountId)
            .catch((err: unknown) => console.error("Failed to dismiss archive-ready thread:", err));
        }
      }
    },
  });
}

interface TrashOpts {
  emails: DashboardEmail[];
  accountId: string;
  threadCount: number;
}

export function pushTrashUndo(opts: TrashOpts): string {
  const { emails, accountId, threadCount } = opts;
  const emailIds = emails.map((e) => e.id);
  return useToastStore.getState().pushToast({
    kind: "undo",
    text: describeUndoAction("trash", threadCount),
    expiresAt: Date.now() + UNDO_DELAY_MS,
    suppressEmailIds: emailIds,
    mergeKey: `trash:${accountId}`,
    mergeUpdate: (prior, incoming) => {
      const mergedIds = [...(prior.suppressEmailIds ?? []), ...(incoming.suppressEmailIds ?? [])];
      return {
        text: describeUndoAction("trash", mergedIds.length),
        suppressEmailIds: mergedIds,
      };
    },
    undoable: () => {
      useAppStore.getState().addEmails(emails);
    },
    onExpire: async () => {
      try {
        const result = (await api().emails.batchTrash(emailIds, accountId)) as {
          success: boolean;
          error?: string;
          failedIds?: string[];
        };
        if (!result.success) {
          const failedIdSet = result.failedIds ? new Set(result.failedIds) : new Set(emailIds);
          const failed = emails.filter((e) => failedIdSet.has(e.id));
          if (failed.length > 0) {
            console.error(
              `[Trash] Batch trash failed, restoring ${failed.length} emails:`,
              result.error,
            );
            useAppStore.getState().addEmails(failed);
          }
        }
      } catch (err) {
        console.error("[Trash] batchTrash rejected:", err);
        useAppStore.getState().addEmails(emails);
      }
    },
  });
}

interface MarkUnreadOpts {
  emails: DashboardEmail[];
  accountId: string;
  threadCount: number;
  previousLabels: Record<string, string[]>;
}

export function pushMarkUnreadUndo(opts: MarkUnreadOpts): string {
  const { emails, accountId, threadCount, previousLabels } = opts;
  return useToastStore.getState().pushToast({
    kind: "undo",
    text: describeUndoAction("mark-unread", threadCount),
    expiresAt: Date.now() + UNDO_DELAY_MS,
    undoable: () => {
      const store = useAppStore.getState();
      for (const e of emails) {
        const prev = previousLabels[e.id];
        if (prev) store.updateEmail(e.id, { labelIds: prev });
      }
    },
    onExpire: async () => {
      const results = await Promise.allSettled(
        emails.map((e) => api().emails.setRead(e.id, accountId, false)),
      );
      const store = useAppStore.getState();
      for (let i = 0; i < emails.length; i++) {
        const r = results[i];
        const failed =
          r.status === "rejected" ||
          (r.status === "fulfilled" &&
            !(r as PromiseFulfilledResult<{ success: boolean }>).value?.success);
        if (failed) {
          const prev = previousLabels[emails[i].id];
          if (prev) store.updateEmail(emails[i].id, { labelIds: prev });
        }
      }
    },
  });
}

interface StarOpts {
  emails: DashboardEmail[];
  accountId: string;
  threadCount: number;
  previousLabels: Record<string, string[]>;
  starred: boolean;
}

export function pushStarUndo(opts: StarOpts): string {
  const { emails, accountId, threadCount, previousLabels, starred } = opts;
  return useToastStore.getState().pushToast({
    kind: "undo",
    text: describeUndoAction(starred ? "star" : "unstar", threadCount),
    expiresAt: Date.now() + UNDO_DELAY_MS,
    undoable: () => {
      const store = useAppStore.getState();
      for (const e of emails) {
        const prev = previousLabels[e.id];
        if (prev) store.updateEmail(e.id, { labelIds: prev });
      }
    },
    onExpire: async () => {
      const results = await Promise.allSettled(
        emails.map((e) => api().emails.setStarred(e.id, accountId, starred)),
      );
      const store = useAppStore.getState();
      for (let i = 0; i < emails.length; i++) {
        const r = results[i];
        const failed =
          r.status === "rejected" ||
          (r.status === "fulfilled" &&
            !(r as PromiseFulfilledResult<{ success: boolean }>).value?.success);
        if (failed) {
          const prev = previousLabels[emails[i].id];
          if (prev) store.updateEmail(emails[i].id, { labelIds: prev });
        }
      }
    },
  });
}

// ---- Undo send ----

export interface SendComposeContext {
  mode: ComposeMode;
  replyToEmailId?: string;
  threadId?: string;
  bodyHtml: string;
  bodyText: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  // Optimistic email id removed from store on undo (so the user's "Sent"
  // copy disappears from the thread when they reopen compose to edit).
  optimisticEmailId?: string;
}

interface SendUndoOpts {
  sendOptions: ComposeSendInput;
  delayMs: number;
  composeContext?: SendComposeContext;
}

/**
 * Push an "Message sent." undo toast that delays the actual send by
 * `delayMs`. On undo: reopens the compose pane with the original draft
 * content. On expire: calls compose.send() and patches the optimistic
 * email id with the real Gmail id (so background sync doesn't dupe).
 *
 * Errors during the deferred send open a separate `error` toast with a
 * Retry button — clicking retry re-attempts the same send.
 */
export function pushSendUndo(opts: SendUndoOpts): string {
  const { sendOptions, delayMs, composeContext } = opts;
  const expiresAt = Date.now() + delayMs;

  const doSend = async (): Promise<void> => {
    try {
      const response = await window.api.compose.send(sendOptions);
      if (!response.success) {
        useToastStore.getState().pushToast({
          kind: "error",
          text: "Failed to send.",
          detail: response.error,
          action: {
            label: "Retry",
            onClick: () => doSend(),
          },
        });
        return;
      }
      // Replace the optimistic "pending-*" email with the real Gmail ID so
      // background sync won't dupe when it discovers the same message.
      // Atomic setState — see UndoSendToast.tsx history for the rationale
      // about not unmounting attached InlineReply editors.
      const ctx = composeContext;
      if (ctx?.optimisticEmailId && response.data?.id && !response.data.queued) {
        const state = useAppStore.getState();
        const optimistic = state.emails.find((e) => e.id === ctx.optimisticEmailId);
        if (optimistic) {
          useAppStore.setState((s) => ({
            emails: [
              ...s.emails.filter((e) => e.id !== ctx.optimisticEmailId),
              { ...optimistic, id: response.data!.id },
            ],
            ...(s.focusedThreadEmailId === ctx.optimisticEmailId
              ? { focusedThreadEmailId: response.data!.id }
              : {}),
            ...(s.inlineReplyToEmailId === ctx.optimisticEmailId
              ? { inlineReplyToEmailId: response.data!.id }
              : {}),
          }));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send";
      useToastStore.getState().pushToast({
        kind: "error",
        text: message,
        action: {
          label: "Retry",
          onClick: () => doSend(),
        },
      });
    }
  };

  return useToastStore.getState().pushToast({
    kind: "undo",
    text: "Message sent.",
    expiresAt,
    undoable: () => {
      // Reopen compose with the draft content so the user can edit and
      // re-send. Mirrors the legacy UndoSendToast.handleUndo path.
      const ctx = composeContext;
      if (!ctx) return;
      const store = useAppStore.getState();
      if (ctx.optimisticEmailId) {
        store.removeEmails([ctx.optimisticEmailId]);
      }
      if (ctx.threadId) {
        store.setSelectedThreadId(ctx.threadId);
      }
      if (ctx.replyToEmailId) {
        store.setSelectedEmailId(ctx.replyToEmailId);
      }
      store.setViewMode("full");
      store.openCompose(ctx.mode, ctx.replyToEmailId, {
        bodyHtml: ctx.bodyHtml,
        bodyText: ctx.bodyText,
        to: ctx.to,
        cc: ctx.cc,
        bcc: ctx.bcc,
        subject: ctx.subject,
      });
    },
    onExpire: () => doSend(),
  });
}

// ---- Info (non-undoable smart-action narration) ----

/**
 * Short-lived info toast (auto-dismiss after 5s). Used by smart-action key
 * paths that don't have an undo affordance — e.g. "Draft opened",
 * "Generating draft…". Returns the id so the caller can update the text
 * if a follow-on event lands (e.g. "Couldn't generate draft").
 */
export function pushSmartActionInfo(text: string): string {
  return useToastStore.getState().pushToast({
    kind: "info",
    text,
    expiresAt: Date.now() + 5_000,
  });
}

// ---- Progress (triage catch-up) ----

/**
 * Push a "Triaging N emails…" progress toast. Returns the toast id so the
 * caller dismisses it on completion. Mirrors the legacy TriageStatusToast
 * surface — read-only with a spinner, no undo.
 */
export function pushTriageProgress(count: number): string {
  const label = count === 1 ? "Triaging 1 email…" : `Triaging ${count.toLocaleString()} emails…`;
  return useToastStore.getState().pushToast({
    kind: "progress",
    text: label,
  });
}

interface SnoozeOpts {
  accountId: string;
  threadCount: number;
  snoozedThreadIds: string[];
}

export function pushSnoozeUndo(opts: SnoozeOpts): string {
  const { accountId, threadCount, snoozedThreadIds } = opts;
  return useToastStore.getState().pushToast({
    kind: "undo",
    text: describeUndoAction("snooze", threadCount),
    expiresAt: Date.now() + UNDO_DELAY_MS,
    // No suppressEmailIds — snoozed emails don't get optimistically removed
    // from `emails`; they're filtered out via snoozedThreadIds.
    undoable: () => {
      const store = useAppStore.getState();
      for (const threadId of snoozedThreadIds) {
        store.removeSnoozedThread(threadId);
        api()
          .snooze.unsnooze(threadId, accountId)
          .catch((err: unknown) => {
            console.error("Failed to unsnooze:", err);
          });
      }
    },
    // No onExpire — the snooze API was already called immediately by the
    // snooze flow; the timer is set server-side.
  });
}
