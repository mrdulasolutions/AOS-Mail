// Lifted from src/main/services/anthropic-service.ts.
//
// Three responsibilities, same as the Electron version:
//   1. WRAP    — thin wrapper over anthropic.messages.create()
//   2. RETRY   — exponential backoff on transient errors
//   3. RECORD  — write each call to llm_calls for cost tracking
//
// Differences from the Electron version:
//   - DB handle resolved lazily via getDb() (no setAnthropicServiceDb step;
//     llm_calls table is created by the sidecar opener).
//   - API key strictly from env var ANTHROPIC_API_KEY for now. Renderer can
//     write the key into preferences.json via settings.setApiKey, which we
//     load on first call (see resolveApiKey).
//   - Streaming-call recording omitted — no current sidecar caller needs it.
//     Add back when agent streaming arrives.

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  Message,
} from "@anthropic-ai/sdk/resources/messages.js";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { getPreferences, setPreference } from "../lib/preferences.js";
import { createLogger } from "../lib/logger.js";

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

/** Order: env var, then preferences.json. */
function resolveApiKey(): string | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const stored = (getPreferences() as { anthropicApiKey?: string }).anthropicApiKey;
  return stored?.trim() || null;
}

export function setApiKey(key: string): void {
  // Stored in preferences.json — for production we should escalate to OS
  // Keychain. Note: this is plaintext on disk; ok for V1 dev, not ok for
  // shipping.
  setPreference("anthropicApiKey" as never, key as never);
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
  if (
    error instanceof Anthropic.APIError &&
    (error as { status?: number }).status === 529
  ) {
    return "server_error";
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createMessage(
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
): Promise<Message> {
  const { caller, emailId, accountId, timeoutMs } = options;
  const model = params.model;
  const startTime = Date.now();

  const client = getClient();
  let lastError: unknown = null;

  const maxPossibleRetries = Math.max(
    ...Object.values(RETRY_CONFIGS).map((c) => c.maxRetries),
  );

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
      const baseDelay = Math.min(
        config.initialDelayMs * Math.pow(2, attempt),
        config.maxDelayMs,
      );
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
