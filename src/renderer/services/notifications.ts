// Native macOS notifications for new mail.
//
// Wraps `@tauri-apps/plugin-notification` with the project-specific behaviors:
//   - permission gating (request once, remember the answer)
//   - settings gating (`notificationsEnabled` honored on every fire)
//   - coalescing: 5+ emails in one batch collapse into a single summary
//   - click routing: tapping the notification focuses the window AND (when
//     the user clicks within ~10 seconds) selects the corresponding thread.
//
// Click-routing on macOS is best-effort. The Tauri notification plugin uses
// `notify_rust` under the hood, which doesn't expose a per-notification
// click event without registering custom action types up front. We register
// a single "open" action type at startup so clicks deliver via the
// `onAction` event channel; for notifications fired before the action types
// land we fall back to relying on macOS's native foregrounding behavior
// (clicking the notification activates the app, which brings the window
// forward via our menu/dock state).

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  onAction,
  registerActionTypes,
} from "@tauri-apps/plugin-notification";
import bridge from "../lib/bridge";
import { focusMainWindow } from "../lib/mac-polish";
import { useAppStore } from "../store";
import type { DashboardEmail } from "../../shared/types";

const NEW_MAIL_ACTION_TYPE = "aos-mail.new-mail";

let initialized = false;
let permissionGranted: boolean | null = null;

/** When more than this many emails arrive in one tick, coalesce them. */
const COALESCE_THRESHOLD = 5;

/** Truncates a string to roughly fit a notification body. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

/** Best-effort sender display name from a "Name <email@...>" header. */
function senderName(from: string): string {
  if (!from) return "(no sender)";
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<.+?>\s*$/);
  if (match && match[1].trim()) return match[1].trim();
  // Fall back to bare email addr; strip any angle brackets.
  return from.replace(/[<>]/g, "").trim() || "(no sender)";
}

/**
 * One-time setup: probe (and request) notification permission, register the
 * click handler. Idempotent — safe to call from React effects that may fire
 * twice in StrictMode.
 */
export async function initNotifications(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (!bridge.isTauri) {
    // Browser-only build (Storybook, tests). Nothing to do.
    return;
  }

  try {
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const requested = await requestPermission();
      permissionGranted = requested === "granted";
    }
  } catch (err) {
    console.warn("[notifications] permission probe failed:", err);
    permissionGranted = false;
  }

  // Register a single "Open" action so notifications deliver clicks through
  // `onAction`. Without this, plain notifications on macOS fire only the
  // implicit close — we wouldn't know which thread to route to.
  try {
    await registerActionTypes([
      {
        id: NEW_MAIL_ACTION_TYPE,
        actions: [{ id: "open", title: "Open" }],
      },
    ]);
  } catch (err) {
    // Non-fatal: clicking the notification will still bring the app forward
    // via macOS's native foregrounding; the user just won't auto-jump to the
    // specific thread.
    console.warn("[notifications] action-type registration failed:", err);
  }

  // One global click handler. Tauri delivers `extra` back unchanged from the
  // sendNotification call site — we use that to route to the right thread.
  try {
    await onAction((evt) => {
      const extra = (evt.extra ?? {}) as Record<string, unknown>;
      const emailId = typeof extra.emailId === "string" ? extra.emailId : null;
      void focusMainWindow();
      if (emailId) {
        useAppStore.getState().setSelectedEmailId(emailId);
      }
    });
  } catch (err) {
    console.warn("[notifications] click handler attach failed:", err);
  }
}

/** Reads the current toggle from the persisted settings via the store. */
function notificationsEnabled(): boolean {
  // The store mirrors the persisted settings; default true matches the schema.
  return useAppStore.getState().notificationsEnabled !== false;
}

/**
 * Surface a notification (or coalesced summary) for a batch of new emails.
 * Skips silently when permission is missing or the user has disabled
 * notifications in Settings. Filters out sent-only items (the user already
 * sent those; nothing to be notified about).
 */
export async function notifyNewEmails(emails: DashboardEmail[]): Promise<void> {
  if (!bridge.isTauri) return;
  if (!permissionGranted) return;
  if (!notificationsEnabled()) return;

  // Drop user's own sent copies — the App.tsx caller already filters most of
  // these but defense in depth keeps stray notifications out.
  const incoming = emails.filter((e) => !e.labelIds?.includes("SENT"));
  if (incoming.length === 0) return;

  if (incoming.length >= COALESCE_THRESHOLD) {
    // One summary instead of N popups; tapping it focuses the window without
    // a thread selection (no single thread to route to).
    sendNotification({
      title: `${incoming.length} new messages`,
      body: "Open AOS Mail to triage your inbox.",
      actionTypeId: NEW_MAIL_ACTION_TYPE,
      extra: { kind: "summary" },
    });
    return;
  }

  for (const email of incoming) {
    const subject = email.subject || "(no subject)";
    const snippet = email.snippet ?? "";
    const body = snippet ? `${subject} — ${snippet}` : subject;
    sendNotification({
      title: senderName(email.from),
      body: truncate(body, 80),
      actionTypeId: NEW_MAIL_ACTION_TYPE,
      extra: {
        kind: "email",
        emailId: email.id,
        threadId: email.threadId,
        accountId: email.accountId ?? "",
      },
    });
  }
}
