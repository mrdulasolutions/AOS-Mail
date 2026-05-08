# OpenRouter integration audit

This document audits every LLM call site in the sidecar, verifies it routes
through the central `createMessage` router in
`sidecar/src/services/anthropic.ts`, and documents per-call-site
provider compatibility.

The router dispatches based on the model id prefix: `claude-*` ids go through
the Anthropic SDK; everything else goes through the OpenRouter
chat-completions endpoint (with a clean error if no OpenRouter key is set).

The user's feature-by-feature model selection lives in
`preferences.modelConfig`, with one key per feature
(`analysis` / `drafts` / `refinement` / `summary` / `archiveReady` /
`senderLookup` / `agentDrafter` / `agentChat`). The reference resolver
pattern is `resolveSummaryModel()` in `thread-summary.ts`.

## Call site inventory

### `sidecar/src/services/email-analyzer.ts` — `analyzeEmail`

- **Currently uses:** `modelConfig.analysis` via `resolveAnalysisModel()`,
  default `claude-sonnet-4-5-20250929`.
- **Routes through `createMessage`:** yes.
- **Provider compatibility:** both. Plain text-in / JSON-out, no tools.
  Works with any OpenRouter chat model.
- **Recommended action:** none. Already migrated.

### `sidecar/src/services/draft-generator.ts` — `generateDraft`

- **Currently uses:** `modelConfig.drafts` via `resolveDraftModel()`,
  default `claude-sonnet-4-5-20250929`.
- **Routes through `createMessage`:** yes.
- **Provider compatibility:** both. Plain text-in / text-out, no tools.
- **Recommended action:** none. Already migrated.

### `sidecar/src/services/draft-generator.ts` — `refineDraft`

- **Currently uses:** `modelConfig.refinement` via `resolveRefineModel()`,
  with explicit fallback to `modelConfig.drafts` then default
  `claude-sonnet-4-5-20250929`.
- **Routes through `createMessage`:** yes.
- **Provider compatibility:** both. Same shape as `generateDraft`.
- **Recommended action:** none. Already migrated.

### `sidecar/src/services/archive-ready-analyzer.ts` — `analyzeThread`

- **Currently uses:** `modelConfig.archiveReady` via
  `resolveArchiveReadyModel()`, default `claude-sonnet-4-5-20250929`.
- **Routes through `createMessage`:** yes.
- **Provider compatibility:** both. Plain text-in / JSON-out, no tools.
- **Recommended action:** none. Already migrated.

### `sidecar/src/services/thread-summary.ts` — `summarizeThread`

- **Currently uses:** `modelConfig.summary` via `resolveSummaryModel()`,
  default `claude-haiku-4-5-20251001`.
- **Routes through `createMessage`:** yes.
- **Provider compatibility:** both. Plain text-in / JSON-out, no tools.
- **Recommended action:** none. Reference implementation for the resolver
  pattern.

### `sidecar/src/services/sender-lookup.ts` — `lookupSender`

- **Currently uses:** `modelConfig.senderLookup` via
  `resolveSenderLookupModel()`, default `claude-sonnet-4-5-20250929`.
  Throws a clear error if the configured model id does not start with
  `claude-`.
- **Routes through `createMessage`:** yes.
- **Provider compatibility:** **Anthropic-only**. The lookup uses the
  `web_search_20250305` tool, which only Anthropic exposes today.
  OpenRouter's OpenAI-compatible API does not have a portable equivalent,
  and the sidecar's OpenRouter wrapper drops non-text content blocks.
- **Recommended action:** the AI Models card in Settings now flags this
  picker as **Anthropic-only**, hides the OpenRouter optgroup for that
  feature, and surfaces a clear note when the stored value is somehow set
  to a non-Claude model (e.g. via direct preferences.json edit). See the
  "Cross-compat exception" section below.

### `sidecar/src/methods/memory.ts` — `memory.classify`

- **Previously used:** hardcoded `claude-haiku-4-5-20251001` (gap).
- **Now uses:** `modelConfig.summary` via `resolveClassifyModel()` (this
  audit), default `claude-haiku-4-5-20251001`.
- **Routes through `createMessage`:** yes.
- **Provider compatibility:** both. Plain text-in / JSON-out, no tools.
- **Why share `summary` rather than introduce a `classify` key:** memory
  classification and thread summary are both short JSON-extraction jobs
  over a small context, and surfacing two near-identical knobs in the
  AI Models card adds UI noise without giving the user a meaningfully
  different lever. Users who want a different classifier model can edit
  `preferences.json` directly today.

## Direct Anthropic SDK usage

`grep -rn "@anthropic-ai/sdk" sidecar/src/` returns only the router itself
(`sidecar/src/services/anthropic.ts`) and the OpenRouter provider
(`sidecar/src/services/providers/openrouter.ts`, which imports the
`Message` / `MessageCreateParamsNonStreaming` *types* for shape
adaptation; it does not instantiate the SDK).

No call site bypasses the router.

## Cross-compat exception: sender lookup is Anthropic-only

Sender lookup is the only feature whose **tool plumbing**, not its
LLM-token cost, ties it to a specific provider. The lookup runs Claude
with the `web_search_20250305` server-side tool: Claude issues queries,
fetches the results, and reads them back into the conversation.
OpenRouter's chat-completions surface has no portable equivalent — the
underlying upstream models can sometimes call functions, but there's no
free-tier model that runs server-side web search the way Anthropic does.

We considered two paths and chose approach 2:

1. **Brave Search API fallback.** When the picker is set to a non-Claude
   model, route the search through Brave's HTTP API and hand the results
   to the configured model for synthesis. Pro: works for users without
   an Anthropic key. Con: another vendor dependency, another key in the
   AI Models card, and the search-quality story is still worse than
   Claude's web_search.

2. **Claude-as-tool only.** Keep using Anthropic for sender lookup
   regardless of any OpenRouter model the user has picked elsewhere.
   Surface this as an exception in the AI Models card. **This is what
   ships today.**

The honest framing: this feature requires an Anthropic key because the
agent uses Anthropic's web search tool. Users who only have OpenRouter
keys configured can still use OpenRouter for analysis / drafts /
refinement / summary / archive-ready; only sender lookup is gated.

The Settings UI signals this in three ways:

- The picker for "Sender Lookup" is rendered with an `Anthropic-only`
  badge and a tooltip explaining why.
- The OpenRouter optgroup is hidden from that picker — users can only
  choose between Claude Haiku / Sonnet / Opus.
- If the stored value is somehow set to a non-Claude id (e.g. by a
  direct edit of `preferences.json`), the card shows a warning that
  sender lookup will fail until a Claude model is selected.

The sidecar enforces the same constraint defensively: `lookupSender()`
throws a descriptive error if `resolveSenderLookupModel()` returns a
non-Claude id, rather than silently routing to OpenRouter and producing
an opaque "tool_use not supported" failure.

## Provider routing summary

| Feature           | modelConfig key   | Default                       | Anthropic | OpenRouter |
| ----------------- | ----------------- | ----------------------------- | --------- | ---------- |
| Email analysis    | `analysis`        | `claude-sonnet-4-5-20250929`  | yes       | yes        |
| Draft generation  | `drafts`          | `claude-sonnet-4-5-20250929`  | yes       | yes        |
| Draft refinement  | `refinement`      | `claude-sonnet-4-5-20250929`  | yes       | yes        |
| Thread summary    | `summary`         | `claude-haiku-4-5-20251001`   | yes       | yes        |
| Archive-ready     | `archiveReady`    | `claude-sonnet-4-5-20250929`  | yes       | yes        |
| Sender lookup     | `senderLookup`    | `claude-sonnet-4-5-20250929`  | yes       | **no**     |
| Memory classify   | `summary` (shared) | `claude-haiku-4-5-20251001`  | yes       | yes        |

`agentDrafter` and `agentChat` keys exist in the schema but route through
the agent SDK / agent chat surface (separate code paths from this audit);
they are not invoked via `createMessage` from any service file in this
listing.
