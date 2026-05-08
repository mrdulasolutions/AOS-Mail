// Smart-action picker — pure logic that maps an email's analysis state to
// the single highest-confidence triage action. Backs the Space-bar key in
// useKeyboardShortcuts.ts. Kept side-effect-free so the keyboard handler
// is the only place that talks to the store/IPC layer.
//
// Confidence model:
// We currently treat "the analyzer ran on this email" as confident enough
// to auto-execute. Once the analysis output grows a numeric confidence
// score, gate the auto-execution branches in pickSmartAction on it (and
// fall through to "trigger triage" / a no-op when below threshold).
//
// Decision matrix (priority order, first match wins):
//   1. analyzer hasn't run yet              → trigger-triage (and re-pick)
//   2. analysis says no-reply (FYI)         → archive (reason: automated-fyi)
//   3. analysis says reply, low priority    → archive (reason: low-priority-fyi)
//   4. needsReply, draft already generated  → open-draft
//   5. needsReply, no draft yet             → generate-draft (then open)
// High-pri replies fall into case 4 or 5 — we never auto-archive a
// high-pri thread, even when there's no draft to open.
//
// Why no explicit "skip" branch: the analyzer only ever emits
// `priority ∈ {high, medium, low, null}`. Manual user overrides go through
// AnalysisPrioritySection and the "Skip" UI option maps to
// `needsReply=false, priority=null` — caught by case 2 below. There is no
// path that lands `"skip"` in `analysis.priority`. (Removed in P3 #14.)
//
// The action tag is intentionally a string-literal union (not an enum) so
// callers can ts-pattern over it without importing values.

import type { DashboardEmail } from "../../shared/types";

export type SmartAction =
  | { kind: "archive"; reason: "automated-fyi" | "low-priority-fyi" }
  | { kind: "open-draft"; emailId: string; reason: "draft-ready" }
  | { kind: "generate-draft"; emailId: string; reason: "needs-reply-no-draft" }
  | { kind: "trigger-triage"; emailId: string; reason: "not-analyzed" }
  | { kind: "noop"; reason: "no-email" | "no-analysis-needed" };

/**
 * Decide which smart action to run for `email`. Returns "noop" when the
 * input is unusable (null email) or when there's no obvious next step
 * (e.g. an analyzed email that explicitly doesn't need a reply but also
 * isn't FYI/skip — the analyzer's reason text is informational only and
 * we don't auto-archive in the absence of a positive signal).
 *
 * Pure: no DOM/store/IPC access. The caller is responsible for executing
 * the chosen action, queuing the undo entry, and handling errors.
 */
export function pickSmartAction(email: DashboardEmail | null | undefined): SmartAction {
  if (!email) {
    return { kind: "noop", reason: "no-email" };
  }

  // 1. Not-yet-analyzed → trigger triage and let the caller re-pick when
  //    the analyzer result lands. We can't infer anything useful without it.
  if (!email.analysis) {
    return { kind: "trigger-triage", emailId: email.id, reason: "not-analyzed" };
  }

  const { analysis } = email;
  const priority = analysis.priority ?? null;

  // 2. Automated / no-reply notification (analyzer said no reply needed,
  //    or the user's manual override mapped "Skip" → needsReply=false).
  //    These are FYIs from no-reply senders, calendar nudges, etc.
  if (!analysis.needsReply) {
    return { kind: "archive", reason: "automated-fyi" };
  }

  // 3. Low-priority FYI that the analyzer says could be a reply but
  //    ranks as low. Treat as "the user has now seen it" and archive,
  //    leaning on the 5s undo to recover any false positives.
  if (priority === "low") {
    return { kind: "archive", reason: "low-priority-fyi" };
  }

  // 3. needsReply with priority high or medium. If a draft is already
  //    generated, open it. The renderer's inline-reply pane is the focal
  //    surface — far cheaper than re-running the agent.
  if (email.draft && email.draft.body && email.draft.body.length > 0) {
    return { kind: "open-draft", emailId: email.id, reason: "draft-ready" };
  }

  // 4. needsReply, no draft yet. Generate one then open it. The caller
  //    chains drafts.rerunAgent → open-draft once the new draft lands.
  if (priority === "high" || priority === "medium") {
    return { kind: "generate-draft", emailId: email.id, reason: "needs-reply-no-draft" };
  }

  // Defensive default: analyzed, says-needs-reply, but priority is null
  // and no draft. Treat as "generate" — the user opted into the smart key
  // so we should do *something*.
  return { kind: "generate-draft", emailId: email.id, reason: "needs-reply-no-draft" };
}

/**
 * Short, user-facing label used in the smart-action toast and hint. Picked
 * here (not in the toast) so the picker remains the single source of truth
 * for the action's identity.
 */
export function describeSmartAction(action: SmartAction): string {
  switch (action.kind) {
    case "archive":
      return "Archived";
    case "open-draft":
      return "Draft opened";
    case "generate-draft":
      return "Generating draft…";
    case "trigger-triage":
      return "Triaging…";
    case "noop":
      return "";
  }
}
