// `extensions` IPC namespace — V1 framework dispatcher.
//
// V1 only ships a single bundled extension: `sender-profile`. The renderer
// owns the panel UI and registry; the sidecar owns the *enrichment* —
// the side-effecting work an extension does (calling Claude, hitting the
// network, etc) that needs to be recorded against `llm_calls`.
//
// Two methods today:
//   - `extensions.list` — manifests for everything the sidecar can dispatch.
//      Renderer cross-references this with its in-renderer panel registry.
//      The user-facing enabled/disabled toggle lives in preferences.json
//      (`extensions.<id>.enabled`); list() reflects that state.
//   - `extensions.getEnrichment` — dispatch to a registered enrichment fn.
//      Today the only one is `sender-profile` → `sender-lookup`. New
//      extensions add an entry to ENRICHMENT_DISPATCH below.
//
// The renderer-side host (src/renderer/extensions/host.ts) speaks this
// surface through the `window.api.extensions` shim namespace.

import { registerMethod } from "../rpc.js";
import { lookupSender } from "../services/sender-lookup.js";
import { getPreferences } from "../lib/preferences.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("extensions");

export interface ExtensionManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  panels: Array<{
    id: string;
    scope: "sender" | "email";
    title: string;
  }>;
}

interface EnrichmentRequest {
  extensionId: string;
  accountId?: string;
  email: string; // sender email address
  name?: string; // sender display name, if available
}

type EnrichmentDispatcher = (req: EnrichmentRequest) => Promise<unknown>;

/**
 * Map of extensionId → enrichment fn. Today there's exactly one entry —
 * the sender-profile extension routes to the sender-lookup service. Adding
 * a new bundled extension means adding a new dispatcher here; the renderer
 * never calls these directly.
 */
const ENRICHMENT_DISPATCH: Record<string, EnrichmentDispatcher> = {
  "sender-profile": async (req) => {
    return await lookupSender({
      email: req.email,
      name: req.name,
      accountId: req.accountId,
    });
  },
};

/**
 * Static manifests for every bundled extension. The renderer uses this for
 * the Settings → Extensions list. Order matches the order new extensions
 * get added to ENRICHMENT_DISPATCH; the renderer sorts/filters as it likes.
 */
const BUNDLED_MANIFESTS: ReadonlyArray<Omit<ExtensionManifest, "enabled">> = [
  {
    id: "sender-profile",
    name: "Sender Profile",
    description:
      "Looks up the sender's profile via Claude web search. Adds a panel to the right-sidebar's Sender tab.",
    version: "1.0.0",
    panels: [
      {
        id: "sender-card",
        scope: "sender",
        title: "Sender",
      },
    ],
  },
];

/**
 * Extension on/off lives in preferences.json under
 *   extensions: { "<id>": { enabled: boolean } }
 * Default is enabled so the user gets the panel out of the box.
 */
function isEnabled(id: string): boolean {
  const prefs = getPreferences() as {
    extensions?: Record<string, { enabled?: boolean } | undefined>;
  };
  const entry = prefs.extensions?.[id];
  if (!entry || typeof entry.enabled !== "boolean") return true;
  return entry.enabled;
}

export function registerExtensionsMethods(): void {
  registerMethod("extensions.list", () => {
    return BUNDLED_MANIFESTS.map((m) => ({ ...m, enabled: isEnabled(m.id) }));
  });

  registerMethod("extensions.getEnrichment", async (params) => {
    const req = (params ?? {}) as Partial<EnrichmentRequest>;
    if (!req.extensionId) {
      throw new Error("extensions.getEnrichment: requires { extensionId }");
    }
    if (!req.email) {
      throw new Error("extensions.getEnrichment: requires { email }");
    }

    if (!isEnabled(req.extensionId)) {
      log.info("extension disabled, skipping enrichment", { id: req.extensionId });
      return null;
    }

    const dispatcher = ENRICHMENT_DISPATCH[req.extensionId];
    if (!dispatcher) {
      throw new Error(`extensions.getEnrichment: no dispatcher for "${req.extensionId}"`);
    }

    const result = await dispatcher({
      extensionId: req.extensionId,
      accountId: req.accountId,
      email: req.email,
      name: req.name,
    });
    // Dispatchers return arbitrary shapes; the contract widens to
    // Record<string, unknown> | null. Real-world dispatchers either return
    // a plain object (sender-lookup → SenderProfile) or null. The cast
    // keeps the contract surface narrow without forcing every dispatcher
    // signature to know about the contract.
    return (result as Record<string, unknown> | null) ?? null;
  });
}
