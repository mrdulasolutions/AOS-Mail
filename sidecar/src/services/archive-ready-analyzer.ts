// Archive-ready detector — calls Claude to decide whether an email
// thread is conversationally complete (no further reply expected) and
// therefore safe to surface in the renderer's "Archive Ready" tab.
// Lifted from src/main/services/archive-ready-analyzer.ts with two
// scoping changes:
//
//   1. Custom-prompt overrides are omitted for V1. The Electron version
//      pulled an editable prompt out of preferences; that knob can lift
//      with the settings IPC namespace later. The default prompt covers
//      everything the renderer needs today.
//
//   2. The system prompt is shorter — rules + a handful of examples —
//      to keep the sidecar bundle lean. Prompt caching still kicks in
//      (~1024-token threshold) when the same system prompt is reused
//      across multiple analyzeThread() calls in a session.
//
// Mirrors sidecar/src/services/email-analyzer.ts in shape:
//   format → Claude → parse → caller persists.
//
// The analyzer only sees the last 1-2 messages of the thread because
// archive-readiness is determined by the most recent turn(s); earlier
// messages just add token noise without improving accuracy.
import { createMessage } from "./anthropic.js";
import { resolveModelFor } from "./model-config.js";
import { stripJsonFences } from "../lib/prompts/strip-json-fences.js";
import { stripQuotedContent } from "../lib/prompts/strip-quoted-content.js";
import { UNTRUSTED_DATA_INSTRUCTION, wrapUntrustedEmail } from "../lib/prompts/prompt-safety.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("archive-ready");

export interface ThreadEmailForAnalysis {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  snippet?: string | null;
  labelIds?: string[] | null;
}

export interface AnalyzeThreadInput {
  threadId: string;
  accountId?: string;
  userEmail?: string;
  emails: ThreadEmailForAnalysis[];
}

export interface ArchiveReadyResult {
  isReady: boolean;
  reason: string;
}

const ARCHIVE_READY_SYSTEM_PROMPT = `You are an email triage assistant. Decide if an email thread is conversationally complete (no further reply is expected) and therefore safe to archive.

Be conservative — when unsure, mark NOT ready.

READY TO ARCHIVE when:
- The user was the last to reply and didn't ask a question or request further action
- Someone sent a "thanks", acknowledgment, or confirmation that naturally ended the thread
- It's a notification, newsletter, or automated email with no action needed
- A meeting/event was confirmed and no further coordination is needed
- An FYI or announcement that's been read
- All action items have been addressed or delegated

NOT READY when:
- Someone asked the user a direct question that hasn't been answered
- There's a pending action item or deadline the user hasn't addressed
- The user is waiting on a response they still need
- There's an ongoing back-and-forth that hasn't concluded
- A decision is still pending

Respond with ONLY valid JSON, no markdown / code fences:
{
  "archive_ready": true | false,
  "reason": "brief explanation"
}

EXAMPLES:

— Thanks reply ends thread (ready)
Last message FROM USER: "Thanks Sarah, that works for me!"
→ {"archive_ready": true, "reason": "User confirmed; conversation naturally concluded"}

— Newsletter (ready)
Last message RECEIVED: "Welcome to your weekly digest. This week in AI: 1. … 2. …"
→ {"archive_ready": true, "reason": "Automated newsletter, no reply needed"}

— Open question to user (not ready)
Last message RECEIVED: "Could you review sections 3 and 4 by Friday?"
→ {"archive_ready": false, "reason": "Direct question awaiting user reply"}

— Meeting confirmed (ready)
Last message RECEIVED: "Confirmed for Wednesday at 2pm. Calendar invite sent."
→ {"archive_ready": true, "reason": "Meeting confirmed, no further coordination needed"}

— User waiting on response (not ready)
Last message FROM USER: "When you have a chance — do you have an ETA on the contract?"
→ {"archive_ready": false, "reason": "User is awaiting a response"}

— Receipt / transactional (ready)
Last message RECEIVED: "Your order #1234 has shipped."
→ {"archive_ready": true, "reason": "Transactional notification, no reply needed"}

Now analyze the thread below.`;

function isFromUser(email: ThreadEmailForAnalysis, userEmail: string): boolean {
  if (email.labelIds?.includes("SENT")) return true;
  const fromLower = email.from.toLowerCase();
  const userLower = userEmail.toLowerCase();
  const match = fromLower.match(/<([^>]+)>/);
  const fromEmail = match ? (match[1] ?? fromLower) : fromLower;
  return fromEmail.trim() === userLower.trim();
}

function formatThreadForAnalysis(emails: ThreadEmailForAnalysis[], userEmail?: string): string {
  // Sort ascending by date so the conversation flows oldest → newest.
  const sorted = [...emails].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  // Only the last 1-2 messages drive the decision.
  const recent = sorted.slice(-2);

  const parts: string[] = [];
  parts.push(`Number of messages in thread: ${sorted.length}`);
  if (userEmail) parts.push(`User's email: ${userEmail}`);
  parts.push("");
  parts.push(UNTRUSTED_DATA_INSTRUCTION);
  parts.push("");
  parts.push(wrapUntrustedEmail(`Thread subject: ${sorted[0]?.subject || "(no subject)"}`));
  parts.push("");

  for (const email of recent) {
    const fromUser = userEmail ? isFromUser(email, userEmail) : false;
    parts.push(`--- Message ${fromUser ? "(FROM USER)" : "(RECEIVED)"} ---`);

    let body = stripQuotedContent(email.body || email.snippet || "");
    const maxLen = 1500;
    if (body.length > maxLen) {
      body = body.substring(0, maxLen) + "\n[... truncated ...]";
    }
    parts.push(
      wrapUntrustedEmail(
        `From: ${email.from}\nTo: ${email.to}\nDate: ${email.date}\nBody: ${body}`,
      ),
    );
    parts.push("");
  }

  return parts.join("\n");
}

export async function analyzeThread(input: AnalyzeThreadInput): Promise<ArchiveReadyResult> {
  if (input.emails.length === 0) {
    throw new Error(`thread ${input.threadId} has no emails`);
  }

  const userMessage = formatThreadForAnalysis(input.emails, input.userEmail);

  const response = await createMessage(
    {
      // Honor modelConfig.archiveReady. Same router behavior as
      // thread-summary — claude-* → Anthropic SDK, else OpenRouter.
      model: resolveModelFor("archiveReady"),
      max_tokens: 256,
      system: [
        {
          type: "text",
          text: ARCHIVE_READY_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    },
    {
      caller: "archive-ready-analyzer",
      accountId: input.accountId,
    },
  );

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("No text response from Claude");
  }

  let parsed: { archive_ready?: boolean; reason?: string };
  try {
    parsed = JSON.parse(stripJsonFences(block.text)) as typeof parsed;
  } catch (err) {
    log.warn("failed to parse archive-ready JSON", {
      threadId: input.threadId,
      err: err instanceof Error ? err.message : String(err),
      text: block.text.slice(0, 200),
    });
    return {
      isReady: false,
      reason: "Failed to parse — keeping in inbox for safety",
    };
  }

  return {
    isReady: !!parsed.archive_ready,
    reason: typeof parsed.reason === "string" ? parsed.reason : "(no reason given)",
  };
}
