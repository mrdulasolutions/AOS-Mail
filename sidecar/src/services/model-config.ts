// Per-feature model resolution — single entry point.
//
// Background:
//   Every Claude-backed feature (analysis, drafts, refine, summary,
//   archive-ready, sender-lookup, learned-rules.classify, …) used to
//   open-code its own resolver:
//
//     1. Read modelConfig.<feature> from preferences.
//     2. If the value matches a legacy tier name ("haiku"/"sonnet"/"opus"),
//        translate it to a concrete Claude model id.
//     3. If the value is a concrete model id (Claude or OpenRouter), pass
//        through unchanged.
//     4. Otherwise, fall back to the feature's hard-coded default.
//
//   Seven copies of the same dance lived across the sidecar — anytime a
//   tier was renamed or a default bumped, every helper had to be updated
//   in lockstep. See `docs/POST-MORTEM-2026-05.md` architectural-debt #4.
//
// This module is the single source of truth: one tier-name map, one
// per-feature defaults table, one resolver. Call sites import
// `resolveModelFor("<feature>")` and stop thinking about it.
//
// Notes on the call-site contract:
//   - The resolver returns whatever id the user configured (after legacy
//     tier translation). It does NOT validate whether the chosen provider
//     supports the call's tool surface.
//   - Sender-lookup needs Anthropic web_search, which is Claude-only. The
//     guard for that lives at the `sender-lookup.ts` call site (it checks
//     the resolved id with `isWebSearchCapableModel` and throws a clear
//     error if the user picked an OpenRouter id). The resolver stays
//     provider-agnostic — same shape as analysis/drafts/summary, which
//     happily run on either Anthropic or OpenRouter.

import { getPreferences } from "../lib/preferences.js";

/**
 * The set of features that have a configurable model. The string keys
 * mirror `ModelConfigSchema` in `src/shared/types.ts` so renderer-side
 * settings flow into the same names the sidecar reads.
 *
 *   - analysis      : email triage (needs-reply / priority)
 *   - drafts        : initial draft generation
 *   - refinement    : draft refinement (falls through to drafts)
 *   - summary       : thread summarization
 *   - archiveReady  : archive-ready detection
 *   - senderLookup  : sender profile lookup (web search; Claude-only at
 *                     the call site)
 *   - classify      : learned-rules scope classification (currently
 *                     piggybacks on `summary` if its own key is unset)
 *   - agentDrafter  : agent drafter mode
 *   - agentChat     : agent chat mode
 */
export type ModelFeature =
  | "analysis"
  | "drafts"
  | "refinement"
  | "summary"
  | "archiveReady"
  | "senderLookup"
  | "classify"
  | "agentDrafter"
  | "agentChat";

/**
 * Legacy tier names from old preferences. The renderer's settings UI no
 * longer writes these — it stores concrete model ids — but pre-migration
 * configs may still have "haiku"/"sonnet"/"opus" stored, so we translate
 * on read.
 *
 * Concrete ids match the ones used elsewhere in the codebase
 * (`MODEL_TIER_IDS` in `src/shared/types.ts` is the renderer-side mirror;
 * the opus value here is `claude-opus-4-20250514`, matching the prior
 * sidecar resolvers).
 */
const TIER_NAME_MAP: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-20250514",
};

interface FeatureSpec {
  /** Hard-coded fallback when the user has nothing usable configured. */
  default: string;
  /**
   * Other feature keys to consult before falling back to `default`. Used
   * by `refinement` (drafts is its inherited setting) and `classify`
   * (summary is its inherited setting — historically the only case).
   */
  fallbacks?: ModelFeature[];
}

/**
 * Per-feature defaults. These match the values previously hard-coded in
 * each feature's helper module so this consolidation is behavior-neutral:
 *
 *   - analysis       → Sonnet (higher-stakes reasoning)
 *   - drafts         → Sonnet (matches analysis on stakes)
 *   - refinement     → falls through to drafts; ultimate default Sonnet
 *   - summary        → Haiku (small extraction, ~$0.0001/thread)
 *   - archiveReady   → Sonnet (preserves prior behavior)
 *   - senderLookup   → Sonnet (most reliable web_search/cite output)
 *   - classify       → Haiku; also falls through to summary so users who
 *                      only customized summary still see consistent
 *                      classification behavior
 *   - agentDrafter   → Sonnet
 *   - agentChat      → Opus
 */
const FEATURE_SPECS: Record<ModelFeature, FeatureSpec> = {
  analysis: { default: "claude-sonnet-4-5-20250929" },
  drafts: { default: "claude-sonnet-4-5-20250929" },
  refinement: {
    default: "claude-sonnet-4-5-20250929",
    fallbacks: ["drafts"],
  },
  summary: { default: "claude-haiku-4-5-20251001" },
  archiveReady: { default: "claude-sonnet-4-5-20250929" },
  senderLookup: { default: "claude-sonnet-4-5-20250929" },
  classify: {
    default: "claude-haiku-4-5-20251001",
    fallbacks: ["summary"],
  },
  agentDrafter: { default: "claude-sonnet-4-5-20250929" },
  agentChat: { default: "claude-opus-4-20250514" },
};

/**
 * Read a single feature's stored selection from preferences and apply tier
 * translation. Returns null when nothing usable is stored so callers can
 * walk the fallback chain.
 */
function readStoredSelection(feature: ModelFeature): string | null {
  const prefs = getPreferences() as {
    modelConfig?: Partial<Record<ModelFeature, unknown>>;
  };
  const raw = prefs.modelConfig?.[feature];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return TIER_NAME_MAP[trimmed] ?? trimmed;
}

/**
 * Resolve which model id to use for a given feature.
 *
 * Lookup order:
 *   1. `modelConfig.<feature>` from preferences (after tier-name
 *      translation). Concrete model ids — Claude (`claude-…`) or
 *      OpenRouter (`openai/gpt-4o-mini`, etc.) — pass through unchanged.
 *   2. Each entry in `FEATURE_SPECS[feature].fallbacks` (e.g. refinement
 *      → drafts) consulted in order.
 *   3. The feature's hard-coded default.
 *
 * The router in `services/anthropic.ts` dispatches on the model id prefix:
 * `claude-…` ids go through the Anthropic SDK, everything else goes
 * through OpenRouter. The resolver itself is provider-agnostic.
 *
 * For features whose call site requires a specific provider (e.g.
 * sender-lookup needs Anthropic-only `web_search_20250305`), the call
 * site is responsible for validating the resolved id — see
 * `sender-lookup.ts`'s `isWebSearchCapableModel` guard. Doing the check
 * at the call site keeps the resolver shape uniform and lets each
 * feature surface a feature-specific error message.
 */
export function resolveModelFor(feature: ModelFeature): string {
  const spec = FEATURE_SPECS[feature];

  // Direct selection.
  const direct = readStoredSelection(feature);
  if (direct) return direct;

  // Inherited fallbacks (e.g. refinement inherits drafts; classify inherits summary).
  for (const fallback of spec.fallbacks ?? []) {
    const inherited = readStoredSelection(fallback);
    if (inherited) return inherited;
  }

  return spec.default;
}
