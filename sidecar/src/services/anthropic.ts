// LLM router for the sidecar.
//
// Originally lifted from src/main/services/anthropic-service.ts as a thin
// wrapper over @anthropic-ai/sdk. With OpenRouter support added, this file
// now plays two roles:
//
//   1. ROUTER  — `createMessage` inspects `params.model` and dispatches to
//                either the native Anthropic SDK path (for `claude-*` model
//                ids) or the OpenAI-compatible OpenRouter path (everything
//                else, when an OpenRouter key is configured). Both providers
//                go through `recordCall` so cost-tracking stays uniform.
//   2. RECORD  — every call (success or failure) lands in `llm_calls` for
//                the usage dashboard. Pricing for non-Anthropic models comes
//                from OpenRouter's /models response in cents-per-million-
//                tokens; today we record 0 cost for free-tier models since
//                that's what they actually cost.
//
// Differences from the Electron version:
//   - DB handle resolved lazily via getDb().
//   - API key strictly from env var ANTHROPIC_API_KEY first, then in-memory
//     secrets store (lib/secrets.ts) — backed by the OS Keychain via the
//     Rust shell at the renderer boundary.
//   - OpenRouter key resolution lives in providers/openrouter.ts and is
//     analogous (env OPENROUTER_API_KEY → secrets).
//   - Streaming-call recording omitted — no current sidecar caller needs it.

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  Message,
} from "@anthropic-ai/sdk/resources/messages.js";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { getSecret, setSecret } from "../lib/secrets.js";
import { createLogger } from "../lib/logger.js";
import { createMessageOpenRouter, getOpenRouterApiKey } from "./providers/openrouter.js";

const log = createLogger("anthropic");

// Pricing per million tokens. Source: src/main/services/anthropic-service.ts.
const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-opus-4-20250514": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-6": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
};
const DEFAULT_PRICING = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}
const RETRY_CONFIGS: Record<string, RetryConfig> = {
  rate_limit: { maxRetries: 5, initialDelayMs: 1000, maxDelayMs: 30000 },
  server_error: { maxRetries: 3, initialDelayMs: 2000, maxDelayMs: 30000 },
  connection: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 10000 },
};

export interface CreateOptions {
  caller: string;
  emailId?: string;
  accountId?: string;
  timeoutMs?: number;
}

let cachedClient: Anthropic | null = null;
let cachedKey: string | null = null;

/** Order: env var, then keychain-backed secrets store. */
function resolveApiKey(): string | null {
  return getSecret("anthropicApiKey");
}

/**
 * Update the in-memory key. Persistence is owned by the renderer via the
 * OS keychain — this just keeps the live sidecar process in sync after
 * the user changes the key in Settings.
 */
export function setApiKey(key: string): void {
  setSecret("anthropicApiKey", key);
  cachedKey = null;
  cachedClient = null;
}

export function resetClient(): void {
  cachedClient = null;
  cachedKey = null;
}

function getClient(): Anthropic {
  const key = resolveApiKey();
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY not set — pass via env or call settings.setApiKey from the renderer",
    );
  }
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedClient = new Anthropic({ apiKey: key });
  cachedKey = key;
  return cachedClient;
}

function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
): number {
  const p = PRICING[model] || DEFAULT_PRICING;
  return (
    ((inputTokens * p.input) / 1_000_000 +
      (outputTokens * p.output) / 1_000_000 +
      (cacheReadTokens * p.cacheRead) / 1_000_000 +
      (cacheCreateTokens * p.cacheWrite) / 1_000_000) *
    100
  );
}

// Prepared once and cached across calls. The explicit generic param lets
// better-sqlite3's type system accept the variadic .run(...params) form;
// without it the default Statement<[]> only accepts zero arguments.
type Bindable = string | number | bigint | Buffer | null;
let _cachedInsert: import("better-sqlite3").Statement<Bindable[]> | null = null;
function getInsertStmt(): import("better-sqlite3").Statement<Bindable[]> {
  if (_cachedInsert) return _cachedInsert;
  _cachedInsert = getDb().prepare<Bindable[]>(
    `INSERT INTO llm_calls (id, model, caller, email_id, account_id,
       input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
       cost_cents, duration_ms, success, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return _cachedInsert;
}

function recordCall(
  model: string,
  caller: string,
  emailId: string | null,
  accountId: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  durationMs: number,
  success: boolean,
  errorMessage: string | null,
): void {
  const cost = calculateCostCents(
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
  );
  try {
    getInsertStmt().run(
      randomUUID(),
      model,
      caller,
      emailId,
      accountId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      cost,
      durationMs,
      success ? 1 : 0,
      errorMessage,
    );
  } catch (err) {
    log.error("failed to record LLM call", { err: String(err) });
  }
}

function getRetryCategory(error: unknown): string | null {
  if (error instanceof Anthropic.RateLimitError) return "rate_limit";
  if (error instanceof Anthropic.InternalServerError) return "server_error";
  if (error instanceof Anthropic.APIConnectionError) return "connection";
  if (error instanceof Anthropic.APIError && (error as { status?: number }).status === 529) {
    return "server_error";
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Provider selector: claude-* models go to Anthropic, anything else to OpenRouter. */
function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-");
}

export async function createMessage(
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
): Promise<Message> {
  if (isClaudeModel(params.model)) {
    return createMessageAnthropic(params, options);
  }
  // Anything else routes to OpenRouter. We require an API key here so the
  // failure mode is "tell the user to configure one" rather than silently
  // falling back to Anthropic and producing surprising bills/costs.
  if (!getOpenRouterApiKey()) {
    const err = new Error(
      `Model "${params.model}" requires an OpenRouter API key. Open Settings → Agent Tools → AI Models to configure one, or pick a Claude model.`,
    );
    recordCall(
      params.model,
      options.caller,
      options.emailId ?? null,
      options.accountId ?? null,
      0,
      0,
      0,
      0,
      0,
      false,
      err.message,
    );
    throw err;
  }
  return createMessageViaOpenRouter(params, options);
}

async function createMessageAnthropic(
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
): Promise<Message> {
  const { caller, emailId, accountId, timeoutMs } = options;
  const model = params.model;
  const startTime = Date.now();

  const client = getClient();
  let lastError: unknown = null;

  const maxPossibleRetries = Math.max(...Object.values(RETRY_CONFIGS).map((c) => c.maxRetries));

  for (let attempt = 0; attempt <= maxPossibleRetries; attempt++) {
    let abortController: AbortController | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      abortController = new AbortController();
      timeoutHandle = setTimeout(() => abortController!.abort(), timeoutMs);
    }

    try {
      const response = await client.messages.create(params, {
        signal: abortController?.signal,
      });

      const usage = response.usage as unknown as Record<string, number>;
      recordCall(
        model,
        caller,
        emailId ?? null,
        accountId ?? null,
        usage.input_tokens || 0,
        usage.output_tokens || 0,
        usage.cache_read_input_tokens || 0,
        usage.cache_creation_input_tokens || 0,
        Date.now() - startTime,
        true,
        null,
      );
      return response;
    } catch (error) {
      lastError = error;
      const category = getRetryCategory(error);
      if (!category) break;
      const config = RETRY_CONFIGS[category];
      if (!config || attempt >= config.maxRetries) break;
      const baseDelay = Math.min(config.initialDelayMs * Math.pow(2, attempt), config.maxDelayMs);
      const delay = baseDelay + baseDelay * 0.1 * Math.random();
      log.warn("LLM call failed, retrying", {
        caller,
        model,
        attempt: attempt + 1,
        maxRetries: config.maxRetries,
        category,
        delayMs: Math.round(delay),
      });
      await sleep(delay);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  recordCall(
    model,
    caller,
    emailId ?? null,
    accountId ?? null,
    0,
    0,
    0,
    0,
    Date.now() - startTime,
    false,
    errMsg,
  );
  throw lastError;
}

async function createMessageViaOpenRouter(
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
): Promise<Message> {
  const { caller, emailId, accountId, timeoutMs } = options;
  const model = params.model;
  const startTime = Date.now();
  try {
    const response = await createMessageOpenRouter(params, { timeoutMs });
    const usage = response.usage as unknown as Record<string, number>;
    recordCall(
      model,
      caller,
      emailId ?? null,
      accountId ?? null,
      usage.input_tokens || 0,
      usage.output_tokens || 0,
      0,
      0,
      Date.now() - startTime,
      true,
      null,
    );
    return response;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    recordCall(
      model,
      caller,
      emailId ?? null,
      accountId ?? null,
      0,
      0,
      0,
      0,
      Date.now() - startTime,
      false,
      errMsg,
    );
    throw err;
  }
}

/**
 * Validate a candidate API key without persisting it. Used by the Settings
 * UI before calling setApiKey: a quick round-trip surfaces 401s before we
 * write a bad key to preferences.json.
 */
export async function validateApiKey(candidate: string): Promise<void> {
  const key = candidate.trim();
  if (!key) throw new Error("API key is empty");
  const client = new Anthropic({ apiKey: key });
  // 1-token reply keeps it cheap; we don't care about the content, only
  // whether the auth handshake succeeds. Errors propagate with their
  // Anthropic-supplied message (e.g. "invalid x-api-key").
  await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1,
    messages: [{ role: "user", content: "ok" }],
  });
}

/** Probe call: returns the model's reply to a one-token "Reply with OK". */
export async function ping(): Promise<string> {
  const result = await createMessage(
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply with OK." }],
    },
    { caller: "anthropic.ping" },
  );
  const block = result.content[0];
  return block && block.type === "text" ? block.text : "(no text block)";
}
