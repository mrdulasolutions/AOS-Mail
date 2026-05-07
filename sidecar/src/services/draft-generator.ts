// AI draft generation — turns an inbox email into a candidate reply.
//
// V1 keeps it lean: one Claude call per draft, no style-profile lookup,
// no memory-context injection. The Electron version's draft-pipeline
// (style profiling + memory consolidation + cost-optimized passes)
// arrives in follow-up work.

import { createMessage } from "./anthropic.js";
import { stripQuotedContent } from "../lib/prompts/strip-quoted-content.js";
import {
  UNTRUSTED_DATA_INSTRUCTION,
  wrapUntrustedEmail,
} from "../lib/prompts/prompt-safety.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("draft-generator");

export interface DraftInput {
  emailId: string;
  accountId?: string;
  email: { from: string; to: string; subject: string; date: string; body: string };
  /** When set, used to refine an existing draft per a critique. */
  currentDraft?: string;
  critique?: string;
}

const DRAFT_SYSTEM_PROMPT = `You draft email replies for the user.

The user is the recipient of the email below. Write a reply they could send as-is. Match the original sender's tone (formal/casual). Be concise — the user prefers short replies.

OUTPUT RULES:
- Output the reply body ONLY. No subject line, no greetings like "Dear X" unless the original used one, no signature (the app appends one automatically).
- Do NOT include a "—Sent by AOS Mail" line — the app adds it.
- Do NOT wrap the response in quotes or markdown.
- 2–4 short paragraphs at most.
- Address questions in the email directly. If the email asks for a decision, default to "yes" unless the email content suggests otherwise.
- If a meeting time is requested, propose two options; don't decline outright.
- If the email is a marketing/automated message, decline politely or skip — but if asked to draft anyway, keep it brief.`;

const REFINE_SYSTEM_PROMPT = `You revise email-reply drafts based on feedback.

Output the revised reply ONLY. No commentary about what changed. Same output rules as the original drafter:
- Reply body only — no subject, no signature, no markdown wrapping.
- Match the original sender's tone.
- Apply the user's feedback faithfully but keep the reply concise.`;

function trimBody(body: string): string {
  let stripped = stripQuotedContent(body);
  if (stripped.length > 6000) stripped = stripped.slice(0, 6000) + "\n[…]";
  return stripped;
}

export async function generateDraft(input: DraftInput): Promise<string> {
  const body = trimBody(input.email.body);
  const wrapped = wrapUntrustedEmail(
    `From: ${input.email.from}\nTo: ${input.email.to}\nSubject: ${input.email.subject}\nDate: ${input.email.date}\n\n${body}`,
  );
  const response = await createMessage(
    {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 600,
      system: [
        { type: "text", text: UNTRUSTED_DATA_INSTRUCTION },
        { type: "text", text: DRAFT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: `Draft a reply to this email:\n\n${wrapped}`,
        },
      ],
    },
    { caller: "draft-generator", emailId: input.emailId, accountId: input.accountId },
  );
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("No text response from Claude");
  return block.text.trim();
}

export async function refineDraft(input: DraftInput): Promise<string> {
  if (!input.currentDraft || !input.critique) {
    throw new Error("refineDraft: requires currentDraft + critique");
  }
  const body = trimBody(input.email.body);
  const wrapped = wrapUntrustedEmail(
    `From: ${input.email.from}\nSubject: ${input.email.subject}\n---\n${body}`,
  );
  const response = await createMessage(
    {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 600,
      system: [
        { type: "text", text: UNTRUSTED_DATA_INSTRUCTION },
        { type: "text", text: REFINE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: `Refine this email-reply draft based on the user's feedback.

ORIGINAL EMAIL:
${wrapped}

CURRENT DRAFT:
${input.currentDraft}

USER FEEDBACK:
${input.critique}

Output the revised reply only.`,
        },
      ],
    },
    { caller: "draft-refiner", emailId: input.emailId, accountId: input.accountId },
  );
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("No text response from Claude");
  log.info("refined draft", {
    emailId: input.emailId,
    originalChars: input.currentDraft.length,
    newChars: block.text.length,
  });
  return block.text.trim();
}
