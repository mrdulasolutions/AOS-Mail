// Email triage — calls Claude to decide whether each email needs a
// reply and at what priority. Lifted from src/main/services/
// email-analyzer.ts with two scoping changes:
//
//   1. Memory context is omitted for V1. The Electron version mixed
//      per-sender / per-domain "analysis preferences" into the prompt
//      via buildAnalysisMemoryContext. That code lifts when the
//      memory namespace ports.
//
//   2. The system prompt is shorter — just rules + a handful of
//      examples — to keep the bundle small. Prompt caching still
//      kicks in (~1024-token threshold) when the same system prompt
//      is reused across multiple analyze() calls in a session.

import { createMessage } from "./anthropic.js";
import { stripJsonFences } from "../lib/prompts/strip-json-fences.js";
import { stripQuotedContent } from "../lib/prompts/strip-quoted-content.js";
import {
  UNTRUSTED_DATA_INSTRUCTION,
  wrapUntrustedEmail,
} from "../lib/prompts/prompt-safety.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("analyzer");

export interface AnalyzeInput {
  emailId: string;
  accountId?: string;
  userEmail?: string;
  email: {
    id: string;
    from: string;
    to: string;
    subject: string;
    date: string;
    body: string;
  };
}

export interface AnalysisResult {
  needsReply: boolean;
  reason: string;
  priority: "high" | "medium" | "low" | null;
}

const ANALYSIS_SYSTEM_PROMPT = `You are an email triage assistant. Decide if an email needs a reply from the user.

The user's email may be supplied. If given, treat it as the recipient: only count something as needing a reply if it's *asking something of the user*, not the user merely receiving an answer to their own question.

Respond with ONLY valid JSON, no markdown / code fences:
{
  "needs_reply": true | false,
  "reason": "brief explanation",
  "priority": "high" | "medium" | "low"   // only when needs_reply is true
}

SKIP REPLIES FOR:
- Newsletters / marketing / promotions
- Automated notifications (GitHub, CI/CD, builds, receipts, shipping, alerts)
- Calendar invite notifications (the user's calendar app handles those)
- CC'd emails where the user is not the primary recipient
- FYI-only messages
- Transactional confirmations (orders, password resets, subscriptions)
- Social-network notifications (LinkedIn, X, Facebook…)
- Mailing-list digests
- Read receipts / out-of-office replies
- Spam or suspicious mail

DRAFT REPLIES FOR:
- Direct questions addressed to the user
- Requests for the user's response or decision
- Meeting coordination needing user input
- Business or personal correspondence expecting a reply
- Action items assigned to the user
- Follow-ups on previous conversations
- Personal introductions warranting a reply

PRIORITY:
- high   : urgent, time-sensitive, important business decisions, exec/VIP
- medium : normal correspondence, reasonable deadlines
- low    : non-urgent, optional response, social

EXAMPLES:

— Newsletter (skip)
Subject: "Weekly Tech Digest"
Body: "Welcome to your weekly digest. This week in AI: 1. … 2. …"
→ {"needs_reply": false, "reason": "Newsletter / automated digest"}

— Direct question (reply)
Subject: "Q3 Budget Proposal Review"
Body: "Could you review sections 3 and 4 by Friday so we can finalize?"
→ {"needs_reply": true, "reason": "Direct request with deadline", "priority": "medium"}

— GitHub notification (skip)
Subject: "[company/repo] PR #123 was merged"
Body: "Merged #123 into main…"
→ {"needs_reply": false, "reason": "Automated GitHub notification"}

— Urgent escalation (reply, high)
Subject: "URGENT: Production database issue"
Body: "I need your approval to scale up the DB instance — please respond ASAP."
→ {"needs_reply": true, "reason": "Urgent prod issue requiring approval", "priority": "high"}

— Meeting request (reply, medium)
Subject: "Sync on project timeline?"
Body: "Could we do 30 min tomorrow or Wednesday?"
→ {"needs_reply": true, "reason": "Meeting coordination request", "priority": "medium"}

— LinkedIn notification (skip)
Subject: "John Smith viewed your profile"
→ {"needs_reply": false, "reason": "Automated LinkedIn notification"}

— Recruiter outreach (reply, low)
Subject: "Exciting opportunity"
Body: "Quick call to discuss?"
→ {"needs_reply": true, "reason": "Recruiter outreach", "priority": "low"}

— Action-required task (reply, low)
Subject: "Update team roster"
Body: "Could you add the two new hires by end of week?"
→ {"needs_reply": true, "reason": "Action item — update doc", "priority": "low"}

Now analyze the email below.`;

function formatEmailForAnalysis(body: string): string {
  let stripped = stripQuotedContent(body);
  if (stripped.length > 4000) {
    stripped = stripped.slice(0, 4000) + "\n[… email truncated …]";
  }
  return stripped;
}

export async function analyzeEmail(input: AnalyzeInput): Promise<AnalysisResult> {
  const body = formatEmailForAnalysis(input.email.body);
  const userIdentityLine = input.userEmail
    ? `Your email address: ${input.userEmail}\n\n`
    : "";

  const wrapped = wrapUntrustedEmail(
    `From: ${input.email.from}\nTo: ${input.email.to}\nSubject: ${input.email.subject}\nDate: ${input.email.date}\n\n${body}`,
  );

  const response = await createMessage(
    {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 256,
      system: [
        {
          type: "text",
          text: ANALYSIS_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `${UNTRUSTED_DATA_INSTRUCTION}\n\n${userIdentityLine}${wrapped}`,
        },
      ],
    },
    {
      caller: "email-analyzer",
      emailId: input.emailId,
      accountId: input.accountId,
    },
  );

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("No text response from Claude");
  }

  let parsed: { needs_reply?: boolean; reason?: string; priority?: string };
  try {
    parsed = JSON.parse(stripJsonFences(block.text)) as typeof parsed;
  } catch (err) {
    log.warn("failed to parse analysis JSON", {
      emailId: input.emailId,
      err: err instanceof Error ? err.message : String(err),
      text: block.text.slice(0, 200),
    });
    return { needsReply: false, reason: "Failed to parse — skipping for safety", priority: null };
  }

  const validPriorities = new Set(["high", "medium", "low"]);
  return {
    needsReply: !!parsed.needs_reply,
    reason: typeof parsed.reason === "string" ? parsed.reason : "(no reason given)",
    priority:
      parsed.needs_reply && parsed.priority && validPriorities.has(parsed.priority)
        ? (parsed.priority as "high" | "medium" | "low")
        : null,
  };
}
