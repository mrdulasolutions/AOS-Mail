// `theme` IPC namespace — lifted from src/main/ipc/settings.ipc.ts and
// src/main/index.ts (the nativeTheme listener).
//
// Architectural split from the Electron version:
//
//   Electron version: nativeTheme.shouldUseDarkColors lived in the main
//   process, so the resolved theme was computed there and broadcast on
//   the OS theme change.
//
//   Sidecar version: the sidecar has no native UI surface, so it can't
//   read the OS color scheme directly. The renderer is the source of
//   truth for "resolved" theme via window.matchMedia. The sidecar just
//   persists the preference and emits a notification when it flips.
//
// The renderer wires:
//   - theme:changed events from here (preference flipped via set())
//   - prefers-color-scheme matchMedia events (OS theme flipped while
//     preference is "system")
// into one combined onChange callback that mirrors the Electron API
// exactly.

import { emit, registerMethod } from "../rpc.js";
import { getPreferences, setPreference } from "../lib/preferences.js";

type ThemePreference = "light" | "dark" | "system";

function isThemePreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

function readThemePreference(): ThemePreference {
  const v = getPreferences().theme;
  return isThemePreference(v) ? v : "system";
}

export function registerThemeMethods(): void {
  registerMethod("theme.get", () => {
    return { preference: readThemePreference() };
  });

  registerMethod("theme.set", (params) => {
    const incoming = (params as { theme?: unknown })?.theme;
    if (!isThemePreference(incoming)) {
      throw new Error(`theme.set: invalid preference ${JSON.stringify(incoming)}`);
    }
    setPreference("theme", incoming);
    emit("theme:changed", { preference: incoming });
    return { preference: incoming };
  });
}
