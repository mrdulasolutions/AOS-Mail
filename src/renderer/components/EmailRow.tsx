import { memo } from "react";
import type { InboxDensity, SnoozedEmail } from "../../shared/types";
import type { EmailThread } from "../store";
import { formatSnoozeTime } from "./SnoozeMenu";

interface EmailRowProps {
  thread: EmailThread;
  isSelected: boolean;
  isChecked: boolean;
  isMultiSelectActive: boolean;
  density: InboxDensity;
  onClick: (e: React.MouseEvent) => void;
  onCheckboxChange: () => void;
  snoozeInfo?: SnoozedEmail;
  returnTime?: number; // Unsnooze return time — shown instead of last message time
}

// Density-specific style maps
const densityStyles = {
  default: {
    row: "h-10 px-4 gap-2 text-sm",
    senderWidth: "w-32",
    priorityBadge: "text-[10px] px-1.5 py-0.5",
    time: "w-10 text-xs",
    threadBadge: "text-[10px] w-5 h-5",
    unreadDot: "w-1.5 h-1.5",
  },
  compact: {
    row: "h-8 px-3 gap-1.5 text-xs",
    senderWidth: "w-28",
    priorityBadge: "text-[9px] px-1 py-px",
    time: "w-9 text-[10px]",
    threadBadge: "text-[9px] w-4 h-4",
    unreadDot: "w-1.5 h-1.5",
  },
} as const;

// Format relative date compactly
function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatSnoozeCountdown(snoozeUntil: number): string {
  const diffMs = snoozeUntil - Date.now();
  if (diffMs <= 0) return "now";
  const diffMins = Math.ceil(diffMs / 60000);
  const diffHours = Math.ceil(diffMs / 3600000);
  const diffDays = Math.ceil(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(snoozeUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Extract sender name from email address
function extractSenderName(from: string): string {
  const match = from.match(/^([^<]+)/);
  return match ? match[1].trim() : from;
}

// Decode HTML entities (Gmail API returns snippets/subjects with entities like &#39;)
function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

// Get priority label info — uses the .priority-* classes from index.css
// so the palette is centralized.
function getPriorityLabel(thread: EmailThread): { text: string; className: string } | null {
  if (thread.draft?.status === "created") {
    return { text: "Done", className: "priority-done" };
  }
  if (!thread.analysis) return null; // Unanalyzed - no label
  if (!thread.analysis.needsReply || thread.userReplied) {
    return { text: "Skip", className: "priority-skipped" };
  }
  const priority = thread.analysis.priority || "medium";
  const className =
    priority === "high"
      ? "priority-high"
      : priority === "low"
        ? "priority-low"
        : "priority-medium";
  return {
    text: priority.charAt(0).toUpperCase() + priority.slice(1),
    className,
  };
}

// Memoized so that j/k navigation only re-renders the two rows whose
// isSelected changed, not every row in the list.  The custom comparator
// skips onClick/onCheckboxChange (always new arrow functions from the parent).
export const EmailRow = memo(
  function EmailRow({
    thread,
    isSelected,
    isChecked,
    isMultiSelectActive,
    density,
    onClick,
    onCheckboxChange,
    snoozeInfo,
    returnTime,
  }: EmailRowProps) {
    const senderName = extractSenderName(thread.displaySender);
    const time = returnTime
      ? formatRelativeDate(new Date(returnTime).toISOString())
      : formatRelativeDate(thread.latestReceivedEmail.date);
    const rawSnippet = thread.latestEmail.snippet || "";
    const snippet = decodeHtmlEntities(rawSnippet);
    const priorityLabel = getPriorityLabel(thread);
    // Fallback to "default" if stored density is unrecognized (e.g. removed "comfortable")
    const ds = densityStyles[density] ?? densityStyles.default;

    const isUnread = thread.isUnread;
    const isRecentlyUnsnoozed = returnTime !== undefined;
    // Unsnoozed emails appear bold like unread emails (without marking unread in Gmail)
    const isVisuallyUnread = isUnread || isRecentlyUnsnoozed;

    const showChecked = isChecked || isMultiSelectActive;

    // Three visual states: selected (filled black), checked (subtle tint),
    // default (white with hover). Black-on-white selection keeps brand
    // discipline; the previous blue-on-white fought the AOS palette.
    const rowState =
      isSelected && !isChecked
        ? "bg-aos-text text-white"
        : isChecked
          ? "bg-aos-bg-sunk text-aos-text"
          : "hover:bg-aos-bg-soft text-aos-text";
    const senderColor =
      isSelected && !isChecked
        ? "text-white"
        : isVisuallyUnread
          ? "text-aos-text"
          : "text-aos-text-muted";
    const subjectColor =
      isSelected && !isChecked
        ? "text-white"
        : isVisuallyUnread
          ? "text-aos-text"
          : "text-aos-text-soft";
    const snippetColor = isSelected && !isChecked ? "text-white/70" : "text-aos-text-muted";
    const dashColor =
      isSelected && !isChecked ? "text-white/40" : "text-aos-line-strong";
    const timeColor =
      isSelected && !isChecked
        ? "text-white/60"
        : snoozeInfo
          ? "text-aos-warning"
          : "text-aos-text-muted";

    return (
      <div
        data-thread-id={thread.threadId}
        data-selected={isSelected ? "true" : undefined}
        className={`w-full ${ds.row} flex items-center text-left border-b border-aos-line/60 transition-colors group ${rowState}`}
      >
        {/* Checkbox / Unread indicator area */}
        <div className="w-5 flex-shrink-0 flex items-center justify-center">
          {showChecked ? (
            <input
              type="checkbox"
              checked={isChecked}
              onChange={(e) => {
                e.stopPropagation();
                onCheckboxChange();
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-3.5 h-3.5 rounded border-aos-line-strong text-aos-text focus:ring-aos-text cursor-pointer"
              data-testid="thread-checkbox"
            />
          ) : (
            <div className="w-2 flex items-center justify-center">
              {isRecentlyUnsnoozed ? (
                <div
                  className={`${ds.unreadDot} rounded-full ${
                    isSelected && !isChecked ? "bg-white" : "bg-aos-info"
                  }`}
                  title="Recently unsnoozed"
                />
              ) : isUnread ? (
                <div
                  className={`${ds.unreadDot} rounded-full ${
                    isSelected && !isChecked ? "bg-white" : "bg-aos-text"
                  }`}
                  title="Unread"
                />
              ) : null}
            </div>
          )}
        </div>

        {/* Clickable area for opening the thread */}
        <button
          onClick={onClick}
          className="flex-1 flex items-center gap-2 min-w-0 h-full text-left"
        >
          {/* Sender name */}
          <div
            className={`${ds.senderWidth} truncate font-medium flex-shrink-0 ${senderColor}`}
          >
            {senderName}
          </div>

          {/* Priority label */}
          {priorityLabel && (
            <span
              className={`${ds.priorityBadge} rounded flex-shrink-0 uppercase font-medium tracking-wide ${
                isSelected && !isChecked ? "bg-white/15 text-white" : priorityLabel.className
              }`}
            >
              {priorityLabel.text}
            </span>
          )}

          {/* Subject + Snippet (combined to use available space) */}
          <div
            className={`flex-1 min-w-0 flex items-center ${density === "compact" ? "gap-1.5" : "gap-2"}`}
          >
            <span
              className={`font-medium truncate flex-shrink-0 max-w-[85%] ${subjectColor}`}
            >
              {decodeHtmlEntities(thread.subject)}
            </span>
            <span className={`flex-shrink ${dashColor}`}>—</span>
            {thread.draft ? (
              <>
                <span
                  className={`flex-shrink-0 inline-flex items-center gap-1 ${
                    isSelected && !isChecked ? "text-white" : "text-aos-success"
                  }`}
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                  <span>Draft</span>
                </span>
                <span className={`truncate min-w-0 ${snippetColor}`}>
                  {(thread.draft.body ?? "")
                    .replace(/<[^>]*>/g, "")
                    .replace(/\n/g, " ")
                    .substring(0, 100)}
                </span>
              </>
            ) : (
              <span className={`truncate min-w-0 ${snippetColor}`}>{snippet}</span>
            )}
          </div>

          {/* Snooze indicator */}
          {snoozeInfo && (
            <span
              className={`flex items-center gap-0.5 flex-shrink-0 ${
                isSelected && !isChecked ? "text-white/70" : "text-aos-warning"
              }`}
              title={`Snoozed until ${formatSnoozeTime(snoozeInfo.snoozeUntil)}`}
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </span>
          )}

          {/* Time */}
          <span
            className={`${ds.time} text-right flex-shrink-0 tabular-nums ${timeColor}`}
          >
            {snoozeInfo ? formatSnoozeCountdown(snoozeInfo.snoozeUntil) : time}
          </span>

          {/* Thread count badge */}
          {thread.hasMultipleEmails && (
            <span
              className={`${ds.threadBadge} rounded-full flex items-center justify-center flex-shrink-0 ${
                isSelected && !isChecked
                  ? "bg-white/15 text-white"
                  : "bg-aos-bg-sunk text-aos-text-muted"
              }`}
            >
              {thread.emails.length}
            </span>
          )}
        </button>
      </div>
    );
  },
  (prev, next) =>
    prev.thread === next.thread &&
    prev.isSelected === next.isSelected &&
    prev.isChecked === next.isChecked &&
    prev.isMultiSelectActive === next.isMultiSelectActive &&
    prev.density === next.density &&
    prev.snoozeInfo === next.snoozeInfo &&
    prev.returnTime === next.returnTime,
  // onClick / onCheckboxChange intentionally omitted — they are stable in behavior
  // but are new arrow function references on each parent render.
);
