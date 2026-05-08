// Window drag bridge.
//
// Tauri 2 doesn't honor Electron's `-webkit-app-region: drag` CSS property,
// so on Tauri the existing `.titlebar-drag` class alone wouldn't make the
// title bar drag the window. The recommended Tauri approach is the
// `data-tauri-drag-region` HTML attribute, but rather than litter the JSX
// with attributes that need careful no-drag opt-outs on every interactive
// child, we install a single document-level handler that:
//
//   1. On mousedown inside `.titlebar-drag`, ask Tauri to start dragging.
//   2. Skip the call when the event originated inside a `.titlebar-no-drag`
//      region OR on an interactive element (button, input, select, link,
//      textarea, contenteditable). This keeps clicks on the account picker,
//      Compose, the gear, ActivityTray, etc. from getting eaten by the drag
//      handler.
//   3. On double-click inside `.titlebar-drag`, toggle maximize — matches
//      native macOS title bar behavior.
//
// The class-based selector lets us keep the existing CSS classes that the
// codebase already uses (titlebar-drag / titlebar-no-drag) as the source of
// truth, so no JSX changes are needed.
//
// Outside Tauri (Electron, jsdom tests, dev shim) this is a no-op — Electron
// already drives drag via the CSS property.

import bridge from "./bridge";

const INTERACTIVE_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A", "LABEL"]);

function isInteractive(el: Element | null): boolean {
  if (!el) return false;
  if (INTERACTIVE_TAGS.has(el.tagName)) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (el.getAttribute("role") === "button") return true;
  return false;
}

/**
 * Walks up from `start` toward the document root, returning true if we
 * encounter a `.titlebar-no-drag` region (or interactive element) before
 * we hit a `.titlebar-drag` region. The closest match wins, mimicking
 * Tauri's own attribute-based traversal.
 */
function shouldStartDrag(start: Element | null): boolean {
  let node: Element | null = start;
  while (node && node !== document.body) {
    if (isInteractive(node)) return false;
    if (node.classList.contains("titlebar-no-drag")) return false;
    if (node.classList.contains("titlebar-drag")) return true;
    node = node.parentElement;
  }
  return false;
}

export function installDragBridge(): void {
  if (!bridge.isTauri) return;

  // Lazy-load the window API on first use; cache it for subsequent calls.
  let getWindowPromise: Promise<{
    startDragging: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
  }> | null = null;

  async function loadWindow() {
    if (!getWindowPromise) {
      getWindowPromise = import("@tauri-apps/api/window").then((m) => m.getCurrentWindow());
    }
    return getWindowPromise;
  }

  document.addEventListener(
    "mousedown",
    (e) => {
      // Left button only — right/middle clicks shouldn't drag.
      if (e.button !== 0) return;
      if (!shouldStartDrag(e.target as Element | null)) return;
      void loadWindow().then((w) => w.startDragging());
    },
    // Capture phase so we run before child handlers; we still bail out if
    // the chain shows a no-drag/interactive element so this doesn't
    // hijack clicks.
    true,
  );

  document.addEventListener(
    "dblclick",
    (e) => {
      if (e.button !== 0) return;
      if (!shouldStartDrag(e.target as Element | null)) return;
      void loadWindow().then((w) => w.toggleMaximize());
    },
    true,
  );
}
