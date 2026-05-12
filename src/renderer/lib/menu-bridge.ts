// Menu-event bridge.
//
// The Rust shell emits "menu:<id>" events when a native menu item is
// clicked (see src-tauri/src/menu.rs). The renderer listens for them
// here and re-dispatches as DOM CustomEvents on `window`, so any component
// can `window.addEventListener("aos-mail:menu", handler)` without
// pulling in @tauri-apps/api directly.
//
// Each event surfaces under its semantic name (e.g. "aos-mail:reply",
// "aos-mail:archive") AND under a single "aos-mail:menu" channel that
// carries the id in `event.detail.id` for components that prefer a
// switch-style handler.
//
// No-op outside Tauri. Under Electron the preload still drives keyboard
// shortcuts directly through ipcRenderer.

import bridge from "./bridge";

const KNOWN_MENU_IDS = [
  "settings",
  "new-message",
  "new-window",
  "save-draft",
  "find",
  "toggle-sidebar",
  "command-palette",
  "agent-palette",
  "get-new-mail",
  "reply",
  "reply-all",
  "forward",
  "archive",
  "trash",
  "snooze",
  "star",
  "mark-unread",
  "report-bug",
  "open-data-folder",
] as const;

export function installMenuBridge(): void {
  if (!bridge.isTauri) return;

  for (const id of KNOWN_MENU_IDS) {
    bridge
      .listen(`menu:${id}`, () => {
        // Per-id custom event for components that listen narrowly.
        window.dispatchEvent(new CustomEvent(`aos-mail:${id}`));
        // Aggregate event with the id in detail.
        window.dispatchEvent(new CustomEvent("aos-mail:menu", { detail: { id } }));
        // eslint-disable-next-line no-console
        console.debug(`[menu] ${id}`);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[menu] failed to subscribe to menu:${id}:`, err);
      });
  }
}
