// Native macOS notifications for new mail.
//
// Backed by our own Tauri commands (notify_*) which talk to
// UNUserNotificationCenter directly. We replaced `@tauri-apps/plugin-
// notification` because its underlying notify-rust → mac-notification-sys
// chain still uses NSUserNotificationCenter (deprecated since macOS 10.14),
// which on Sequoia delivers to Notification Center but doesn't pop banners.
//
// Same public surface as before:
//   - initNotifications()    — one-time permission probe at boot
//   - notifyNewEmails(emails) — fire (or coalesce) notifications for a batch
//   - testNotification()      — Settings panel "fire a sample"
//
// What's deliberately simpler than the previous plugin-based version:
//   - No actionTypeId / no per-notification routing. Tap on a notification
//     brings the app forward (macOS handles that without a delegate). We
//     don't yet route to a specific thread on click — the Rust side
//     would need a UNUserNotificationCenterDelegate that emits Tauri
//     events; that's a follow-up.
//   - No `onAction` handler. The user just sees the notification, clicks
//     it, app comes forward.

import bridge from "../lib/bridge";
import { useAppStore } from "../store";
import type { DashboardEmail } from "../../shared/types";

type AuthState = "not_determined" | "denied" | "authorized" | "provisional" | "ephemeral";

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

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!bridge.isTauri) return null;
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return (await tauriInvoke(cmd, args)) as T;
}

/** "authorized" and "provisional" both let notifications fire; the rest do not. */
function stateAllowsDelivery(state: AuthState | null): boolean {
  return state === "authorized" || state === "provisional";
}

/**
 * One-time setup: probe (and request) notification permission. Idempotent —
 * safe to call from React effects that may fire twice in StrictMode.
 */
export async function initNotifications(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (!bridge.isTauri) {
    // Browser-only build (Storybook, tests). Nothing to do.
    return;
  }

  try {
    const live = await invokeCmd<AuthState>("notify_permission_state");
    if (stateAllowsDelivery(live)) {
      permissionGranted = true;
      return;
    }
    if (live === "denied") {
      permissionGranted = false;
      return;
    }
    // not_determined — prompt the user.
    const requested = await invokeCmd<AuthState>("notify_request_permission");
    permissionGranted = stateAllowsDelivery(requested);
  } catch (err) {
    console.warn("[notifications] permission probe failed:", err);
    permissionGranted = false;
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
 * notifications in Settings. Filters out sent-only items.
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
    // One summary instead of N popups.
    await invokeCmd("notify_send", {
      title: `${incoming.length} new messages`,
      body: "Open AOS Mail to triage your inbox.",
    });
    return;
  }

  for (const email of incoming) {
    const subject = email.subject || "(no subject)";
    const snippet = email.snippet ?? "";
    const body = snippet ? `${subject} — ${snippet}` : subject;
    await invokeCmd("notify_send", {
      title: senderName(email.from),
      body: truncate(body, 80),
    });
  }
}

/**
 * Fire a sample notification so the user can verify their permission/toggle
 * wiring without waiting for real mail.
 *
 * Returns a structured outcome so the Settings panel can surface a useful
 * error — three failure modes are distinct:
 *   - "browser":  not running under Tauri (e.g. Storybook). Nothing to do.
 *   - "denied":   macOS denied permission and there's no path to re-prompt
 *                 from JS. Caller can deep-link to System Settings.
 *   - "disabled": user has the toggle turned off; we honor that and don't
 *                 fire a "test" notification either.
 *
 * On the happy path we re-probe permission first — handles the case where
 * the user denied at boot, then granted permission via System Settings
 * without restarting the app.
 */
export async function testNotification(): Promise<
  { ok: true } | { ok: false; reason: "browser" | "denied" | "disabled" }
> {
  if (!bridge.isTauri) return { ok: false, reason: "browser" };
  if (!notificationsEnabled()) return { ok: false, reason: "disabled" };

  // Re-probe permission. The cached `permissionGranted` may be stale if the
  // user changed System Settings since the last initNotifications call.
  try {
    const live = await invokeCmd<AuthState>("notify_permission_state");
    if (stateAllowsDelivery(live)) {
      permissionGranted = true;
    } else if (live === "not_determined") {
      const requested = await invokeCmd<AuthState>("notify_request_permission");
      permissionGranted = stateAllowsDelivery(requested);
    } else {
      permissionGranted = false;
    }
  } catch (err) {
    console.warn("[notifications] permission probe failed:", err);
    permissionGranted = false;
  }
  if (!permissionGranted) return { ok: false, reason: "denied" };

  await invokeCmd("notify_send", {
    title: "AOS Mail",
    body: "This is what new mail will look like.",
  });
  return { ok: true };
}

/**
 * Public state probe — used by SetupWizard to display the permission badge
 * and decide whether to render the "Allow notifications" button.
 */
export async function getNotificationPermission(): Promise<AuthState> {
  if (!bridge.isTauri) return "denied";
  const live = await invokeCmd<AuthState>("notify_permission_state");
  return live ?? "not_determined";
}

/**
 * Trigger the OS permission prompt. Idempotent on macOS — after the first
 * grant/deny, the OS just returns the cached decision instead of prompting
 * again. Returns the resolved state.
 */
export async function requestNotificationPermission(): Promise<AuthState> {
  if (!bridge.isTauri) return "denied";
  const requested = await invokeCmd<AuthState>("notify_request_permission");
  if (requested && stateAllowsDelivery(requested)) {
    permissionGranted = true;
  } else if (requested === "denied") {
    permissionGranted = false;
  }
  return requested ?? "not_determined";
}
