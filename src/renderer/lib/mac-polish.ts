// Mac polish: dock badge, native notifications, mailto:// URL handling.
//
// Three thin wrappers around Tauri commands defined in src-tauri/src/lib.rs.
// We use direct invokes (not sidecar JSON-RPC) because these are pure OS
// surface — no need to round-trip through the Node sidecar to set a badge.
//
// In a non-Tauri runtime (the dev shim or unit tests) every function falls
// back to a no-op so callers don't have to feature-detect.
//
// The mailto handler is the asymmetric one: macOS hands us URLs at runtime
// via `RunEvent::Opened`, which the Rust shell forwards as a Tauri event
// named `mailto:open`. We expose a subscribe API plus a "drain pending"
// helper for the cold-start race.

import bridge from "./bridge";

export interface MailtoPayload {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!bridge.isTauri) return null;
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return (await tauriInvoke(cmd, args)) as T;
}

/**
 * Sets the macOS dock-tile badge. Pass 0 to clear. The Rust side caps the
 * value at i64; counts above that are clamped on the platform side.
 */
export async function setDockBadge(count: number): Promise<void> {
  // Defensive: never let a negative count make it across the bridge.
  const safe = Math.max(0, Math.floor(count));
  await invoke<void>("set_dock_badge", { count: safe });
}

/**
 * Brings the main window forward and gives it focus. Used by notification
 * click handlers so opening a notification yields a foregrounded app.
 */
export async function focusMainWindow(): Promise<void> {
  await invoke<void>("focus_main_window");
}

/**
 * Registers (or unregisters) AOS Mail as the system default for mailto:// URLs.
 * Returns true iff the OS confirms the desired state on round-trip.
 */
export async function setDefaultMailApp(makeDefault: boolean): Promise<boolean> {
  if (!bridge.isTauri) return false;
  const result = await invoke<boolean>("set_default_mail_app", {
    makeDefault,
  });
  return result === true;
}

/** Reports whether macOS currently routes mailto:// to AOS Mail. */
export async function isDefaultMailApp(): Promise<boolean> {
  const result = await invoke<boolean>("is_default_mail_app");
  return result === true;
}

/**
 * Cold-start drain: at app boot, the renderer mounts a listener for
 * `mailto:open` events — but if macOS handed us a URL before the listener
 * attached, the event is lost. The Rust shell caches the most recent URL in
 * a per-process queue; this call retrieves and consumes it.
 */
export async function getPendingMailto(): Promise<MailtoPayload | null> {
  const result = await invoke<MailtoPayload | null>("get_pending_mailto");
  return result ?? null;
}

/**
 * Subscribe to live mailto:// URL deliveries. The unlisten function detaches
 * the listener; outside Tauri returns a noop.
 */
export async function onMailtoOpen(cb: (payload: MailtoPayload) => void): Promise<() => void> {
  return await bridge.listen<MailtoPayload>("mailto:open", cb);
}
