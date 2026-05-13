// OpenRouter provider — wraps OpenRouter's OpenAI-compatible chat-completions
// endpoint and adapts it to the Anthropic SDK Message shape consumed by the
// sidecar's analyzers and drafters.
//
// Why OpenRouter: it provides a single bearer-token gateway to dozens of
// open-source and proprietary LLMs, including a tier of models at $0/M
// tokens. That makes "use a free model" a one-checkbox choice in the UI
// without re-plumbing the call sites.
//
// Shape adaptation:
//   - Anthropic's `system: [{type:"text", text:..., cache_control:...}]`
//     becomes a leading `{role:"system", content:"..."}` message.
//     Cache-control hints are stripped — OpenRouter's cache-control story
//     varies per upstream and is not currently exposed via OpenAI-compat.
//   - Anthropic's structured `content` blocks (text + tool_use + tool_result)
//     are flattened to plain strings on the way in. Today no sidecar caller
//     uses tool_use against an OpenRouter model, so this is safe; if/when we
//     wire tools through OpenRouter we'll need a richer translator.
//   - The response is rebuilt as an Anthropic Message: `content:
//     [{type:"text", text}]`, with usage-token mapping
//     prompt_tokens→input_tokens / completion_tokens→output_tokens.
//
// Auth: the API key lives in the in-memory secrets store (lib/secrets.ts),
// itself populated at boot from the OS Keychain via the renderer. The
// process never writes the key to a regular file on disk.

import type {
  MessageCreateParamsNonStreaming,
  Message,
  MessageParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { randomUUID } from "node:crypto";
import { getSecret, setSecret } from "../../lib/secrets.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("openrouter");

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const REFERER_HEADER = "https://github.com/mrdulasolutions/AOS-Mail";
const TITLE_HEADER = "AOS Mail";

// Light retry on transient failures (rate limits, 5xx). Mirrors the spirit
// of the Anthropic retry block, but locally — keeping the router thin.
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 10_000;

// ─── Free-model rate limiting ────────────────────────────────────────────
//
// OpenRouter caps free-tier models at 16 requests/minute (a value returned
// in the `X-RateLimit-Limit` response header). Multiple concurrent agent
// flows in this app — analyzer, draft generator, rerunAgent, sender lookup
// — can each fire OpenRouter calls in parallel, so the burst can blow
// through 16/min in seconds and the user sees an HTTP 429.
//
// We solve this client-side, but ONLY for free models. Paid models on
// OpenRouter have much higher (effectively unbounded for our load) limits
// and don't need the gate; threading them through a 16/min bucket would
// just add latency for no reason.
//
// Detection is by model-id convention: OpenRouter free models are
// distributed with an `:free` suffix (e.g. `meta-llama/llama-3.3-70b
// -instruct:free`). The bare model id with no suffix is the paid tier.
//
// Algorithm is a sliding-window counter — a queue of timestamps of the
// last `FREE_RATE_LIMIT_PER_MIN` successful "issue this call" decisions.
// Before issuing a new free-model call, we drop timestamps older than
// `RATE_WINDOW_MS`, and if the remaining list is still at capacity, sleep
// until the oldest timestamp ages out. Awaiters proceed in arrival order
// because each call awaits before mutating the array.
//
// This is purely in-process — sidecar restarts reset the counter, which
// is fine: the next 429 from the server would just push us back into
// rate-respecting mode via the X-RateLimit-Reset handler below.
const FREE_RATE_LIMIT_PER_MIN = 16;
const RATE_WINDOW_MS = 60_000;
const recentFreeCallTimestamps: number[] = [];

function isFreeModel(model: string): boolean {
  return model.endsWith(":free");
}

async function acquireFreeRateSlot(model: string): Promise<void> {
  if (!isFreeModel(model)) return;
  // Loop because a queued caller may need to wait multiple windows if a
  // burst arrived first. Each iteration either claims a slot or sleeps
  // until the next slot frees up.
  for (;;) {
    const now = Date.now();
    while (
      recentFreeCallTimestamps.length > 0 &&
      recentFreeCallTimestamps[0]! < now - RATE_WINDOW_MS
    ) {
      recentFreeCallTimestamps.shift();
    }
    if (recentFreeCallTimestamps.length < FREE_RATE_LIMIT_PER_MIN) {
      recentFreeCallTimestamps.push(now);
      return;
    }
    // Wait until the oldest tracked call ages out of the window, plus a
    // 50ms cushion to avoid a thundering-herd retry exactly at the
    // boundary.
    const oldest = recentFreeCallTimestamps[0]!;
    const waitMs = oldest + RATE_WINDOW_MS - now + 50;
    log.info("free-model rate limit reached, queueing", {
      model,
      waitMs,
      queued: recentFreeCallTimestamps.length,
    });
    await sleep(Math.max(waitMs, 100));
  }
}

export interface OpenRouterFreeModel {
  id: string;
  name: string;
  contextLength: number;
  pricing: { prompt: string; completion: string };
}

interface OpenRouterChatRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

interface OpenRouterChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string; role?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string | number };
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

interface OpenRouterModelListResponse {
  data?: OpenRouterModel[];
}

// ─── Key handling ────────────────────────────────────────────────────────

export function getOpenRouterApiKey(): string | null {
  // env-var override is built into getSecret() for documented secret
  // names — keeps dev/CI ergonomics matching the prior Anthropic path.
  return getSecret("openRouterApiKey");
}

export function setOpenRouterApiKey(key: string): void {
  setSecret("openRouterApiKey", key);
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Quick auth check against OpenRouter's /models endpoint. Used by the
 * Settings UI before persisting a candidate key.
 */
export async function validateOpenRouterKey(candidate: string): Promise<void> {
  const key = candidate.trim();
  if (!key) throw new Error("API key is empty");
  const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
    method: "GET",
    headers: buildHeaders(key),
  });
  if (!res.ok) {
    // /models is public but auth-aware — a bad key returns 401.
    const text = await safeText(res);
    throw new Error(`OpenRouter rejected the API key (HTTP ${res.status}): ${text || "no body"}`);
  }
}

/**
 * Fetch the free-tier models from OpenRouter. Free is defined as
 * `pricing.prompt === "0"` — OpenRouter encodes prices as decimal strings,
 * not numbers, and "0" is the canonical zero. Returns id, label, and
 * context length so the renderer can render a sensible dropdown.
 */
export async function listFreeModels(): Promise<OpenRouterFreeModel[]> {
  // /models works without an API key, but providing one gives the user
  // a more accurate "your-tier" view if they've BYOK'd a paid plan.
  const key = getOpenRouterApiKey();
  const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
    method: "GET",
    headers: key ? buildHeaders(key) : buildAnonHeaders(),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`OpenRouter /models failed (HTTP ${res.status}): ${text || "no body"}`);
  }
  const json = (await res.json()) as OpenRouterModelListResponse;
  const all = json.data ?? [];
  const free: OpenRouterFreeModel[] = [];
  for (const m of all) {
    const promptPrice = m.pricing?.prompt;
    const completionPrice = m.pricing?.completion;
    if (promptPrice === "0" && completionPrice === "0") {
      free.push({
        id: m.id,
        name: m.name ?? m.id,
        contextLength: m.context_length ?? 0,
        pricing: { prompt: promptPrice, completion: completionPrice ?? "0" },
      });
    }
  }
  // Sort by name for stable UI ordering.
  free.sort((a, b) => a.name.localeCompare(b.name));
  return free;
}

/**
 * Send a chat-completions request to OpenRouter, translating to/from the
 * Anthropic Message shape so the sidecar's call sites can stay uniform.
 *
 * The returned Message is shape-compatible with what `anthropic.messages
 * .create` returns — `content[0].text` holds the model's reply — but does
 * not carry server-side metadata we don't get from OpenRouter (stop_sequence,
 * cache_creation_input_tokens, etc., come back as null/0).
 */
export async function createMessageOpenRouter(
  params: MessageCreateParamsNonStreaming,
  options: { timeoutMs?: number } = {},
): Promise<Message> {
  const key = getOpenRouterApiKey();
  if (!key) {
    throw new Error(
      "OpenRouter API key not set — open Settings → Agent Tools → AI Models to configure one",
    );
  }

  const messages: OpenRouterChatRequest["messages"] = [];
  const systemContent = extractSystemString(params.system);
  if (systemContent) {
    messages.push({ role: "system", content: systemContent });
  }
  for (const m of params.messages as MessageParam[]) {
    const flat = flattenContent(m.content);
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: flat });
    }
  }

  const body: OpenRouterChatRequest = {
    model: params.model,
    messages,
    max_tokens: params.max_tokens,
  };
  if (typeof params.temperature === "number") {
    body.temperature = params.temperature;
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortController: AbortController | undefined;
    if (options.timeoutMs) {
      abortController = new AbortController();
      timeoutHandle = setTimeout(() => abortController!.abort(), options.timeoutMs);
    }

    try {
      // Client-side rate gate for free models — see top of file. No-op
      // for paid models. Runs INSIDE the retry loop so a 429-with-Retry-
      // After path also goes through the queue on the next attempt.
      await acquireFreeRateSlot(params.model);

      const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(key),
        body: JSON.stringify(body),
        signal: abortController?.signal,
      });

      if (!res.ok) {
        const text = await safeText(res);
        // 429/5xx → retryable; everything else gives up immediately so we
        // surface a clean error to the caller (e.g. 400 = bad model id).
        const retryable = res.status === 429 || res.status >= 500;
        const err = new Error(`OpenRouter HTTP ${res.status}: ${text || "no body"}`);
        if (!retryable || attempt >= MAX_RETRIES) throw err;
        lastError = err;
        // Server-side safety net: if OpenRouter sent X-RateLimit-Reset
        // (epoch milliseconds), respect it instead of falling back to a
        // capped exponential backoff that wouldn't outlast a 60s window.
        // Cap the sleep at 90s so a misconfigured/giant Reset header
        // can't strand the call.
        const resetMs = parseRateLimitResetMs(res);
        const delay =
          res.status === 429 && resetMs !== null
            ? Math.min(Math.max(resetMs - Date.now() + 250, 100), 90_000)
            : backoff(attempt);
        if (res.status === 429) {
          log.warn("OpenRouter 429 — sleeping before retry", {
            model: params.model,
            resetMs,
            delay,
            attempt,
          });
        }
        await sleep(delay);
        continue;
      }

      const json = (await res.json()) as OpenRouterChatResponse;
      if (json.error) {
        throw new Error(
          `OpenRouter error: ${json.error.message ?? String(json.error.code ?? "unknown")}`,
        );
      }
      const choice = json.choices?.[0];
      const content = choice?.message?.content ?? "";
      const promptTokens = json.usage?.prompt_tokens ?? 0;
      const completionTokens = json.usage?.completion_tokens ?? 0;

      // Build a Message-shaped response. The Anthropic SDK's Message type
      // has a few server-only fields we don't get from OpenRouter
      // (stop_sequence, cache token counts) — null/0 is the right default
      // and matches what the SDK puts there for non-cached calls anyway.
      const message: Message = {
        id: json.id ?? randomUUID(),
        type: "message",
        role: "assistant",
        model: json.model ?? params.model,
        content: [{ type: "text", text: content, citations: null }],
        stop_reason: mapFinishReason(choice?.finish_reason),
        stop_sequence: null,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          cache_creation: null,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          // server_tool_use was added to the SDK type; OpenRouter doesn't
          // surface anything analogous so it's null.
          server_tool_use: null,
          service_tier: null,
        },
      };
      return message;
    } catch (err) {
      lastError = err;
      // AbortError counts as transient — retry with the next backoff.
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort && attempt < MAX_RETRIES) {
        await sleep(backoff(attempt));
        continue;
      }
      // Otherwise: rethrow whatever we have.
      log.warn("OpenRouter call failed", {
        attempt,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function buildHeaders(key: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "HTTP-Referer": REFERER_HEADER,
    "X-Title": TITLE_HEADER,
  };
}

function buildAnonHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "HTTP-Referer": REFERER_HEADER,
    "X-Title": TITLE_HEADER,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// OpenRouter returns `X-RateLimit-Reset` as a Unix-epoch value indicating
// when the current rate window will reset. It's documented as
// milliseconds, but treat both ms-since-epoch and s-since-epoch defensively
// so a future change in spec doesn't silently land us in 1970-time.
// Returns null if the header isn't present or doesn't parse to a positive
// future timestamp.
function parseRateLimitResetMs(res: Response): number | null {
  const raw = res.headers.get("X-RateLimit-Reset");
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Heuristic: a value < 10^12 is almost certainly seconds (year 2001+).
  // Above that, it's milliseconds. Both branches return ms.
  const ms = n < 1e12 ? n * 1000 : n;
  // Sanity: must be in the next 5 minutes — anything further out is
  // either a clock skew issue or a header bug we shouldn't honour.
  if (ms - Date.now() > 5 * 60_000) return null;
  return ms;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoff(attempt: number): number {
  const base = Math.min(INITIAL_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  return base + base * 0.1 * Math.random();
}

/**
 * Anthropic's `system` field is either a string or an array of TextBlock-
 * like objects; we collapse to a single string for the OpenAI-compat
 * endpoint, dropping cache_control hints (irrelevant on OpenRouter).
 */
function extractSystemString(
  system: MessageCreateParamsNonStreaming["system"] | undefined,
): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => {
        const block = b as TextBlockParam;
        return block && block.type === "text" ? block.text : "";
      })
      .filter((s) => s.length > 0)
      .join("\n\n");
  }
  return "";
}

/**
 * MessageParam.content can be a string or an array of content blocks
 * (TextBlockParam, ToolUseBlockParam, ToolResultBlockParam, ImageBlockParam,
 * etc.). For OpenRouter today we flatten to text-only — every active
 * sidecar caller passes plain strings, and we never round-trip tool calls
 * through OpenRouter yet. Non-text blocks are dropped with a warning.
 */
function flattenContent(content: MessageParam["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else {
      log.debug("dropping non-text content block in OpenRouter call", {
        type: b.type ?? "unknown",
      });
    }
  }
  return parts.join("\n\n");
}

function mapFinishReason(reason: string | undefined): Message["stop_reason"] {
  // OpenAI-compat finish_reason → Anthropic stop_reason.
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "end_turn";
  }
}
