// Sender Profile bundled extension (V1).
//
// Renderer-side manifest. Surfaces the existing SenderProfilePanel
// component; the actual enrichment (Claude + web_search) runs in the
// sidecar via extensions.getEnrichment → sender.lookup.
//
// No `enrich` fn here on purpose — leaving it undefined makes the host
// fall through to the sidecar dispatcher. That way the LLM call goes
// through the same `createMessage` recording path as analysis/drafts and
// shows up in the AI Models / cost-tracking dashboards.

import type { BundledExtension } from "../host";
import { SenderProfilePanel } from "./SenderProfilePanel";

export const senderProfileExtension: BundledExtension = {
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
      component: SenderProfilePanel,
      priority: 100,
    },
  ],
  // No enrich() — host falls through to sidecar's extensions.getEnrichment.
};
