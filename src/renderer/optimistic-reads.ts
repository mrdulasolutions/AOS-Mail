/**
 * Optimistic mark-as-read guard.
 *
 * Tracks email IDs that were optimistically marked as read but haven't been
 * confirmed by a sync round-trip yet. Any store mutation that writes emails
 * (setEmails, addEmails, sync buffer flush) must call applyOptimisticReads()
 * so stale data from the DB or sync events can't revert the optimistic update.
 *
 * Lives in its own module to avoid circular dependencies between store/ and hooks/.
 */

import type { DashboardEmail } from "../shared/types";

const optimisticReadIds = new Set<string>();

/** Strip UNREAD from emails that were optimistically marked as read.
 *
 *  Performance: this is called on EVERY setEmails / addEmails / sync flush,
 *  so cheap no-op short-circuiting matters. With 2500+ emails in the store,
 *  the previous always-allocate `.map()` was forcing useThreadedEmails to
 *  recompute groupByThread for nothing every time the optimistic-read set
 *  was non-empty (which is most of the time after the user starts reading
 *  mail). Now we scan first and only allocate when at least one email
 *  actually needs stripping. */
export function applyOptimisticReads(emails: DashboardEmail[]): DashboardEmail[] {
  if (optimisticReadIds.size === 0) return emails;
  const needsStripping = emails.some(
    (e) => optimisticReadIds.has(e.id) && e.labelIds?.includes("UNREAD"),
  );
  if (!needsStripping) return emails;
  return emails.map((e) =>
    optimisticReadIds.has(e.id) && e.labelIds?.includes("UNREAD")
      ? { ...e, labelIds: e.labelIds.filter((l) => l !== "UNREAD") }
      : e,
  );
}

/** Register email IDs as optimistically read. Persists until explicitly
 *  confirmed via confirmOptimisticReads (when sync delivers updated labels). */
export function addOptimisticReads(ids: Iterable<string>): void {
  for (const id of ids) optimisticReadIds.add(id);
}

/** Remove confirmed-read IDs from the optimistic set (called when sync
 *  delivers label updates that no longer include UNREAD). */
export function confirmOptimisticReads(ids: Iterable<string>): void {
  for (const id of ids) optimisticReadIds.delete(id);
}
