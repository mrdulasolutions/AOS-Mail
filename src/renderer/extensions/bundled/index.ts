/**
 * Bundled extension registration (V1).
 *
 * One bundled extension today: sender-profile. Registers the panel
 * component and the extension itself with the host. The host is the source
 * of truth for what panels show in the right sidebar; ExtensionPanelSlot's
 * legacy registry is kept in sync (registerBundledExtension also writes
 * there) so existing JSX that consumes panels by id keeps working.
 *
 * The Calendar panel and any private extensions still register through
 * the legacy registerPanelComponent path — we don't take a hard dependency
 * on the host for non-V1 panels, which keeps the calendar agent's worktree
 * decoupled.
 */
import { registerPanelComponent } from "../ExtensionPanelSlot";
import { registerBundledExtension, hydrateEnabledStates } from "../host";
import { senderProfileExtension } from "./sender-profile";
import { CalendarPanel } from "../../../extensions/mail-ext-calendar/src/renderer/CalendarPanel";
import { registerPrivateExtensions } from "../private-extensions";
import { loadInstalledExtensionPanels } from "../installed-extensions";

/**
 * Register all bundled extension panel components.
 * Called during app initialization.
 */
export function registerBundledExtensions(): void {
  // V1 host registration (also calls registerPanelComponent under the hood).
  registerBundledExtension(senderProfileExtension);

  // Calendar agent's panel still uses the legacy direct-registration path.
  registerPanelComponent("calendar", "day-view", CalendarPanel);

  // Private extension panels (loaded from extensions-private/).
  registerPrivateExtensions();

  // Hydrate enabled-state from the sidecar so the host's getPanelsFor
  // filter reflects user toggles. Failure is non-fatal — defaults to
  // enabled.
  void hydrateEnabledStatesFromSidecar();

  // Load installed extension panels asynchronously (runtime discovery).
  loadInstalledExtensionPanels().catch((err) => {
    console.warn("[Extensions] Failed to load installed extension panels:", err);
  });

  console.log("[Extensions] Registered bundled extension components");
}

async function hydrateEnabledStatesFromSidecar(): Promise<void> {
  try {
    const result = await window.api.extensions.list();
    if (
      result &&
      typeof result === "object" &&
      "success" in result &&
      result.success &&
      Array.isArray((result as { data?: unknown }).data)
    ) {
      const data = (result as { data: Array<{ id?: string; enabled?: boolean }> }).data;
      const states = data
        .filter((m) => typeof m.id === "string" && typeof m.enabled === "boolean")
        .map((m) => ({ id: m.id as string, enabled: m.enabled as boolean }));
      hydrateEnabledStates(states);
    }
  } catch (err) {
    console.warn("[Extensions] Failed to hydrate enabled states:", err);
  }
}
