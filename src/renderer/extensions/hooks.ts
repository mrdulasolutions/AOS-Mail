// V1 framework hook: surfaces extension panels for an email.
//
// Talks directly to the in-renderer host (not the shim). The host's
// `enrichForEmail` deduplicates concurrent calls and caches by
// extension-id-specific keys (sender-domain for sender-profile,
// email-id for everything else), so:
//   - Switching emails inside the same thread doesn't re-enrich the
//     sender-profile panel for the same domain.
//   - Mounting two panels for the same extension never fans out to
//     parallel sidecar calls.
//
// The legacy ExtensionPanelInfo / ExtensionEnrichmentResult types are
// reused so existing JSX that consumes <ExtensionPanelSlot> stays put.

import { useState, useEffect, useCallback, useRef, startTransition } from "react";
import type { DashboardEmail } from "../../shared/types";
import type { ExtensionPanelInfo, ExtensionEnrichmentResult } from "../../shared/extension-types";
import { useAppStore } from "../store";
import {
  getAllPanels,
  enrichForEmail,
  getCachedEnrichmentFor,
  onHostChange,
  type PanelDescriptor,
} from "./host";

export type ExtensionPanelData = {
  panelInfo: ExtensionPanelInfo;
  enrichment: ExtensionEnrichmentResult | null;
  isLoading: boolean;
};

function panelDescriptorToInfo(d: PanelDescriptor): ExtensionPanelInfo {
  return {
    id: d.panelId,
    extensionId: d.extensionId,
    title: d.title,
    priority: d.priority,
    scope: d.scope,
  };
}

/**
 * Hook to get extension panels with their enrichment data for an email.
 */
export function useExtensionPanels(
  email: DashboardEmail | null,
  threadEmails: DashboardEmail[],
): {
  panels: ExtensionPanelData[];
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  // Re-render when the host registry changes (e.g. on initial register, or
  // when the user toggles an extension).
  const [hostVersion, setHostVersion] = useState(0);
  useEffect(() => onHostChange(() => setHostVersion((v) => v + 1)), []);

  // accountId is needed by the sidecar's extensions.getEnrichment dispatcher
  // for cost attribution. Pull from the store so we don't have to thread it
  // through every component.
  const accountId = useAppStore((s) => s.currentAccountId);

  const [enrichments, setEnrichments] = useState<Map<string, ExtensionEnrichmentResult>>(new Map());
  const [loadingExtensions, setLoadingExtensions] = useState<Set<string>>(new Set());

  const currentEmailIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentEmailIdRef.current = email?.id ?? null;
  }, [email?.id]);

  // Recompute panels every time the host changes (re-derive from registry).
  // Doesn't allocate per-render — the list is small (1-2 panels in V1).
  const panelDescriptors = getAllPanels();
  const panels = panelDescriptors.map(panelDescriptorToInfo);

  // Trigger enrichment when email changes. We seed the cache map from the
  // host's session memo first so a re-mount renders synchronously, then
  // kick off any missing enrichments asynchronously.
  useEffect(() => {
    if (!email) {
      setEnrichments(new Map());
      setLoadingExtensions(new Set());
      return;
    }

    const emailId = email.id;
    const seed = new Map<string, ExtensionEnrichmentResult>();
    const needFetch: string[] = [];

    for (const desc of panelDescriptors) {
      const cached = getCachedEnrichmentFor(desc.extensionId, email);
      if (cached) {
        seed.set(`${desc.extensionId}:${desc.panelId}`, cached);
      } else {
        needFetch.push(desc.extensionId);
      }
    }
    setEnrichments(seed);

    if (needFetch.length === 0) {
      setLoadingExtensions(new Set());
      return;
    }

    // Mark exactly the panels that need fetching as loading.
    setLoadingExtensions(new Set(needFetch));

    // Stagger to avoid blocking j/k navigation. The hook's previous version
    // used a 150ms debounce — keep that behavior so rapid arrow-key
    // navigation doesn't spawn N web searches.
    const timeoutId = setTimeout(() => {
      void fanOutEnrichment(needFetch);
    }, 150);

    async function fanOutEnrichment(extensionIds: string[]): Promise<void> {
      for (const extId of extensionIds) {
        if (currentEmailIdRef.current !== emailId) return;
        try {
          const result = await enrichForEmail(extId, email!, threadEmails, accountId ?? undefined);
          if (currentEmailIdRef.current !== emailId) return;
          if (result) {
            startTransition(() => {
              setEnrichments((prev) => {
                const next = new Map(prev);
                next.set(`${result.extensionId}:${result.panelId}`, result);
                return next;
              });
            });
          }
        } catch (err) {
          console.warn(`[Extensions] enrichment failed for ${extId}:`, err);
        } finally {
          if (currentEmailIdRef.current === emailId) {
            startTransition(() => {
              setLoadingExtensions((prev) => {
                const next = new Set(prev);
                next.delete(extId);
                return next;
              });
            });
          }
        }
      }
    }

    return () => {
      clearTimeout(timeoutId);
    };
    // We deliberately leave panelDescriptors out of the dep array — it's a
    // fresh array every render. hostVersion bumps cover registry changes.
  }, [email?.id, hostVersion, accountId]);

  // Build the per-panel data array consumed by the sidebar.
  const panelData: ExtensionPanelData[] = panels.map((p) => {
    const key = `${p.extensionId}:${p.id}`;
    return {
      panelInfo: p,
      enrichment: enrichments.get(key) ?? null,
      isLoading: loadingExtensions.has(p.extensionId),
    };
  });

  const isLoading = loadingExtensions.size > 0;

  const refresh = useCallback(async () => {
    if (!email) return;
    const emailId = email.id;
    setLoadingExtensions(new Set(panelDescriptors.map((d) => d.extensionId)));
    try {
      for (const desc of panelDescriptors) {
        try {
          const result = await enrichForEmail(
            desc.extensionId,
            email,
            threadEmails,
            accountId ?? undefined,
          );
          if (currentEmailIdRef.current !== emailId) return;
          if (result) {
            setEnrichments((prev) => {
              const next = new Map(prev);
              next.set(`${result.extensionId}:${result.panelId}`, result);
              return next;
            });
          }
        } finally {
          setLoadingExtensions((prev) => {
            const next = new Set(prev);
            next.delete(desc.extensionId);
            return next;
          });
        }
      }
    } catch (err) {
      console.warn("[Extensions] refresh failed:", err);
    }
  }, [email?.id, threadEmails, accountId]);

  return {
    panels: panelData,
    isLoading,
    refresh,
  };
}

/**
 * Hook for badges (future use)
 */
export function useExtensionBadges(_email: DashboardEmail | null): {
  badges: Array<{ id: string; label: string; color?: string }>;
} {
  return { badges: [] };
}
