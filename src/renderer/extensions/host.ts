// Renderer-side extension host (V1 framework).
//
// A bundled extension is just a JS module with a manifest. The host keeps an
// in-memory registry; nothing in this file talks to disk or the network.
//
//   - `registerBundledExtension(ext)` adds to the registry. Boot code in
//      `bundled/index.ts` imports each bundled extension and calls this for
//      each one.
//   - `getPanelsFor(scope, email)` returns the panel descriptors visible for
//      a given (scope, email). Filters by:
//        • scope match (panel.scope === scope)
//        • extension enabled (preferences.json)
//   - `getEnrichmentFor(extensionId, email)` returns the cached enrichment
//      (renderer-side memo + sidecar-side cache) without forcing a refresh.
//   - `enrichForEmail(extensionId, email, name?)` triggers the enrichment
//      via the sidecar (`extensions.getEnrichment`). The result lands in
//      the renderer cache so the next getEnrichmentFor returns instantly.
//
// The Electron-era extension host (which loaded extensions from disk and
// activated() them in a Node sandbox) is gone; bundled extensions in V1
// just declare static panel descriptors plus an optional async enrich fn.

import type { ExtensionEnrichmentResult } from "../../shared/extension-types";
import type { DashboardEmail } from "../../shared/types";
import { registerPanelComponent, type PanelComponentProps } from "./ExtensionPanelSlot";
import bridge from "../lib/bridge";

// ── Public types ────────────────────────────────────────────────────────

export type PanelScope = "sender" | "email";

export interface BundledPanel {
  id: string; // unique within an extension
  scope: PanelScope;
  title: string;
  component: React.ComponentType<PanelComponentProps>;
  priority?: number;
}

export interface BundledExtension {
  id: string;
  name: string;
  description: string;
  version: string;
  panels: BundledPanel[];
  /**
   * Optional enrichment fn. Called asynchronously when the user opens an
   * email; the result is handed to every panel of this extension via the
   * `enrichment` prop. If omitted, the panel renders without any external
   * data (useful for static/UI-only panels).
   *
   * `enrich` returns the data to show; the host wraps it in
   * ExtensionEnrichmentResult with the right extensionId/panelId/etc.
   */
  enrich?: (input: {
    email: DashboardEmail;
    threadEmails: DashboardEmail[];
    accountId?: string;
  }) => Promise<unknown>;
}

// ── Internal registry ───────────────────────────────────────────────────

type RegisteredExtension = BundledExtension;

const registry = new Map<string, RegisteredExtension>();

/**
 * Renderer-side enrichment cache. Keyed by `<extensionId>:<emailKey>` where
 * emailKey is "<sender-domain>" for the sender-profile extension and
 * "<emailId>" for everything else (we don't have a multi-extension story
 * yet, so this is a one-implementation thing — extending later means
 * exposing a `keyFor(email)` callback on BundledExtension).
 *
 * The 7-day TTL is enforced by the SIDECAR'S persistent cache. This map is
 * just a session-lifetime memo so re-rendering the panel doesn't re-call
 * the sidecar.
 */
const sessionCache = new Map<string, ExtensionEnrichmentResult>();

/**
 * In-flight enrichment requests, deduped by cache key. Multiple panels
 * mounted for the same email shouldn't trigger N concurrent lookups.
 */
const inflight = new Map<string, Promise<ExtensionEnrichmentResult | null>>();

// ── Enabled/disabled state ──────────────────────────────────────────────

const enabledOverrides = new Map<string, boolean>();

/**
 * Update the renderer's local enabled state for an extension. The Settings
 * tab calls this after persisting the toggle to preferences. The next
 * getPanelsFor() call reflects the change immediately without re-fetching
 * from the sidecar.
 */
export function setExtensionEnabled(id: string, enabled: boolean): void {
  enabledOverrides.set(id, enabled);
  notifyRegistryListeners();
}

/**
 * Hydrate the renderer's enabled-state map from the sidecar. Called once at
 * boot; subsequent updates flow through setExtensionEnabled.
 */
export function hydrateEnabledStates(states: Array<{ id: string; enabled: boolean }>): void {
  for (const s of states) enabledOverrides.set(s.id, s.enabled);
  notifyRegistryListeners();
}

function isEnabled(id: string): boolean {
  // Default is enabled; only flip if we have an explicit override.
  return enabledOverrides.get(id) ?? true;
}

// ── Listeners ───────────────────────────────────────────────────────────

const registryListeners = new Set<() => void>();

export function onHostChange(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

function notifyRegistryListeners(): void {
  for (const l of registryListeners) l();
}

// ── Registration ────────────────────────────────────────────────────────

/**
 * Register a bundled extension. The panel components are also registered
 * with the legacy ExtensionPanelSlot registry so existing
 * `<ExtensionPanelSlot extensionId=… panelId=…>` markup keeps working.
 *
 * Idempotent: re-registering the same id replaces the previous entry. (The
 * boot path only calls this once per id, so this is mostly a guard against
 * hot-reload churn.)
 */
export function registerBundledExtension(ext: BundledExtension): void {
  registry.set(ext.id, ext);
  for (const panel of ext.panels) {
    registerPanelComponent(ext.id, panel.id, panel.component);
  }
  notifyRegistryListeners();
}

/** Iterate the registry. */
export function listBundledExtensions(): BundledExtension[] {
  return [...registry.values()];
}

// ── Panel queries ───────────────────────────────────────────────────────

export interface PanelDescriptor {
  extensionId: string;
  panelId: string;
  title: string;
  scope: PanelScope;
  priority: number;
}

export function getPanelsFor(scope: PanelScope, _email: DashboardEmail | null): PanelDescriptor[] {
  const out: PanelDescriptor[] = [];
  for (const ext of registry.values()) {
    if (!isEnabled(ext.id)) continue;
    for (const panel of ext.panels) {
      if (panel.scope !== scope) continue;
      out.push({
        extensionId: ext.id,
        panelId: panel.id,
        title: panel.title,
        scope: panel.scope,
        priority: panel.priority ?? 50,
      });
    }
  }
  out.sort((a, b) => b.priority - a.priority);
  return out;
}

/** All panels across all enabled extensions (for the legacy hook). */
export function getAllPanels(): PanelDescriptor[] {
  return [...getPanelsFor("sender", null), ...getPanelsFor("email", null)];
}

// ── Enrichment ──────────────────────────────────────────────────────────

/**
 * Build the cache key for an extension on a given email.
 *
 * The sender-profile extension caches by sender domain (one lookup serves
 * every email from that sender). Everything else caches by email id.
 */
function cacheKeyFor(extensionId: string, email: DashboardEmail): string {
  if (extensionId === "sender-profile") {
    const senderEmail = extractSenderEmail(email.from).toLowerCase();
    return `${extensionId}:${senderEmail}`;
  }
  return `${extensionId}:${email.id}`;
}

function extractSenderEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

function extractSenderName(from: string): string {
  const m = from.match(/^([^<]+)/);
  return (m ? m[1] : from).trim();
}

/** Cached enrichment for a panel — does NOT trigger a fetch. */
export function getCachedEnrichmentFor(
  extensionId: string,
  email: DashboardEmail,
): ExtensionEnrichmentResult | null {
  return sessionCache.get(cacheKeyFor(extensionId, email)) ?? null;
}

/**
 * Trigger enrichment for a single extension. Resolves with the result the
 * panel should render. Multiple concurrent calls for the same key share a
 * single in-flight request.
 *
 * Returns null when:
 *   - The extension has no enrich fn (panel renders without external data)
 *   - The extension is disabled
 *   - The sidecar dispatcher returns null (e.g. for an obvious automated address)
 */
export async function enrichForEmail(
  extensionId: string,
  email: DashboardEmail,
  threadEmails: DashboardEmail[],
  accountId?: string,
): Promise<ExtensionEnrichmentResult | null> {
  const ext = registry.get(extensionId);
  if (!ext) return null;
  if (!isEnabled(extensionId)) return null;

  const key = cacheKeyFor(extensionId, email);
  const cached = sessionCache.get(key);
  if (cached) return cached;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = runEnrichment(ext, email, threadEmails, accountId)
    .then((result) => {
      if (result) sessionCache.set(key, result);
      return result;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/**
 * Enrich every panel for a given email. Used by the panels hook to drive a
 * single async fan-out. Each panel's result is yielded as a separate
 * ExtensionEnrichmentResult so the UI can update them independently.
 */
export async function enrichAllForEmail(
  email: DashboardEmail,
  threadEmails: DashboardEmail[],
  accountId?: string,
): Promise<ExtensionEnrichmentResult[]> {
  const results = await Promise.all(
    [...registry.keys()].map(async (id) => {
      try {
        return await enrichForEmail(id, email, threadEmails, accountId);
      } catch (err) {
        console.warn(`[Extensions] enrichment failed for ${id}:`, err);
        return null;
      }
    }),
  );
  return results.filter((r): r is ExtensionEnrichmentResult => r !== null);
}

async function runEnrichment(
  ext: RegisteredExtension,
  email: DashboardEmail,
  threadEmails: DashboardEmail[],
  accountId?: string,
): Promise<ExtensionEnrichmentResult | null> {
  // If the extension supplies its own enrich fn (renderer-only enrichment),
  // call it directly. Otherwise, dispatch to the sidecar — which is where
  // the sender-profile lookup actually lives.
  let data: unknown;
  if (ext.enrich) {
    data = await ext.enrich({ email, threadEmails, accountId });
  } else {
    // Sidecar dispatch. The sidecar's extensions.getEnrichment looks up the
    // dispatcher by extension id (today: sender-profile → sender.lookup).
    data = await bridge.call("extensions.getEnrichment", {
      extensionId: ext.id,
      accountId,
      email: extractSenderEmail(email.from),
      name: extractSenderName(email.from),
    });
  }

  if (data == null) return null;

  // Panel id: today every extension has exactly one panel. If/when an
  // extension wants per-panel enrichment shapes, this becomes
  // `panelId: ext.panels[i].id` indexed by something the enrich fn
  // returns. Not needed for V1.
  const panelId = ext.panels[0]?.id ?? "default";

  return {
    extensionId: ext.id,
    panelId,
    data: data as Record<string, unknown>,
    isLoading: false,
  };
}

/** Drop the renderer-side memo cache. Settings → Extensions toggles call this. */
export function clearSessionCache(): void {
  sessionCache.clear();
}
