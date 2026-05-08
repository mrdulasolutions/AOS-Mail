// Thread summarizer — Claude reads the conversation history and returns
// a structured summary the V1 agent panel renders. Used when the user
// opens a multi-message thread and wants a quick "what's this about" +
// "what do I owe people" without reading every message.
//
// Caching strategy: keyed on (threadId, accountId, latestMessageId).
// Latest message id changes whenever a new reply lands, which busts the
// cache automatically. Persisted in the thread_summaries table so a
// reload doesn't burn another Claude call for an unchanged thread.

import { createMessage } from "./anthropic.js";
import { resolveModelFor } from "./model-config.js";
import { stripJsonFences } from "../lib/prompts/strip-json-fences.js";
import { stripQuotedContent } from "../lib/prompts/strip-quoted-content.js";
import {
  UNTRUSTED_DATA_INSTRUCTION,
  wrapUntrustedEmail,
} from "../lib/prompts/prompt-safety.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("thread-summary");

export interface ThreadSummaryInput {
  threadId: string;
  accountId: string;
  /** Oldest-first list of messages; we always include all of them. */
  messages: Array<{
    id: string;
    from: string;
    to: string;
    date: string;
    body: string;
    bodyText: string | null;
  }>;
}

export interface ThreadSummary {
  /** 2–4 sentences describing the conversation so far. Markdown-safe plain text. */
  summary: string;
  /** What the user has been asked to do, oldest first. May be empty. */
  actionItems: string[];
  /** Decisions reached in the thread. May be empty. */
  decisions: string[];
}

const SUMMARY_SYSTEM_PROMPT = `You are an email-thread summarizer for a busy executive.

Given a conversation, you produce a JSON object with three fields:

  {
    "summary": "<2 to 4 sentences>",
    "action_items": ["<thing the recipient (you) needs to do>", ...],
    "decisions": ["<decision reached in the thread>", ...]
  }

Rules:
- summary: focus on WHO is talking, WHAT is being asked, and WHERE the
  conversation has landed. Skip greetings and signatures. Past tense for
  what happened, present for the current ask.
- action_items: only include things the RECIPIENT (the "you" / "to:"
  party) still owes. Do NOT include things other participants owe. Use
  imperative voice ("Approve the budget", "Send the deck").
- decisions: factual outcomes ("Picked vendor A over B", "Meeting moved
  to Thursday"). Skip if none.
- Empty arrays are fine. Don't invent items.
- Respond ONLY with valid JSON. No markdown, no commentary, no fences.`;

function formatMessages(messages: ThreadSummaryInput["messages"]): string {
  // Strip quoted ancestors from each message body so Claude doesn't see
  // the same content N times across the chain. Truncate each message to
  // ~3k chars; threads tend to mushroom otherwise.
  return messages
    .map((m, idx) => {
      const text = m.bodyText ?? m.body;
      const stripped = stripQuotedContent(text);
      const trimmed =
        stripped.length > 3000 ? stripped.slice(0, 3000) + "\n[…]" : stripped;
      return [
        `--- Message ${idx + 1} of ${messages.length} ---`,
        `From: ${m.from}`,
        `To: ${m.to}`,
        `Date: ${m.date}`,
        "",
        trimmed,
      ].join("\n");
    })
    .join("\n\n");
}

export async function summarizeThread(
  input: ThreadSummaryInput,
): Promise<ThreadSummary> {
  if (input.messages.length === 0) {
    return { summary: "", actionItems: [], decisions: [] };
  }
  const wrapped = wrapUntrustedEmail(formatMessages(input.messages));

  const response = await createMessage(
    {
      // Default to Haiku, but honor modelConfig.summary if the user picked
      // an OpenRouter free model (or another Claude model) in Settings →
      // Agent Tools → AI Models. The router in services/anthropic.ts
      // dispatches based on the model id prefix.
      model: resolveModelFor("summary"),
      max_tokens: 600,
      system: [
        {
          type: "text",
          text: SUMMARY_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `${UNTRUSTED_DATA_INSTRUCTION}\n\n${wrapped}`,
        },
      ],
    },
    {
      caller: "thread-summary",
      accountId: input.accountId,
    },
  );

  const block = response.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  const cleaned = stripJsonFences(raw);

  try {
    const parsed = JSON.parse(cleaned) as {
      summary?: unknown;
      action_items?: unknown;
      decisions?: unknown;
    };
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      actionItems: Array.isArray(parsed.action_items)
        ? parsed.action_items.filter((x): x is string => typeof x === "string")
        : [],
      decisions: Array.isArray(parsed.decisions)
        ? parsed.decisions.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch (err) {
    log.warn("thread summary JSON parse failed", {
      threadId: input.threadId,
      err: err instanceof Error ? err.message : String(err),
      raw: raw.slice(0, 200),
    });
    return { summary: "", actionItems: [], decisions: [] };
  }
}
