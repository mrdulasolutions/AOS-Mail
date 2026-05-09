// Open a URL in the user's default browser.
//
// Tauri's webview blocks `<a target="_blank">` clicks — they no-op silently.
// External URLs have to be launched via `tauri-plugin-shell.open()` so macOS
// hands them off to Safari / Chrome / whatever the user's default is.
//
// Outside Tauri (dev shim, jsdom tests), falls back to window.open. Either
// way the call is fire-and-forget; we don't surface load errors because the
// browser owns the URL once it's opened.

export async function openExternalUrl(url: string): Promise<void> {
  try {
    // Lazy-import so non-Tauri callers don't bundle the plugin.
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }
}
