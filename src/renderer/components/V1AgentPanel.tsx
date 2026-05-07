// V1 inbox-agent surface for the right sidebar.
//
// AOS Mail V1 ships a single inbox agent that triages every new email,
// drafts replies, and looks up senders. Unlike the V2 streaming-trace UI
// in AgentPanel.tsx, V1 isn't continuous — it does discrete unit work
// per email and persists the result to SQLite. This panel surfaces what
// the agent has done for the currently-open email and lets the user
// kick off a triage or draft on demand.
//
// Three blocks:
//   1. Triage   — priority badge + needsReply + reason. Run/Re-run button.
//   2. Draft    — preview when a draft exists; "Generate Draft" otherwise.
//   3. Sender   — from-name + from-email. Acts as a footer-level identity
//                 strip. Web-search-via-Claude sender enrichment (the V2
//                 path) lifts later.
//
// The panel reads analysis + draft straight off the email row in the
// store — those fields are now joined in sync.getEmails (commit eeab3f3)
// so the data is there from the first paint, no separate fetch needed.

import { memo, useState } from "react";
import { useAppStore } from "../store";
import type { DashboardEmail } from "../../shared/types";

interface V1AgentPanelProps {
  email: DashboardEmail | null;
  accountId: string | null;
}

function PriorityPill({
  priority,
}: {
  priority: "high" | "medium" | "low" | "skip" | undefined;
}) {
  const map: Record<string, { label: string; classes: string }> = {
    high: {
      label: "High",
      classes: "bg-red-100 text-red-700 border-red-200",
    },
    medium: {
      label: "Medium",
      classes: "bg-amber-100 text-amber-700 border-amber-200",
    },
    low: {
      label: "Low",
      classes: "bg-blue-100 text-blue-700 border-blue-200",
    },
    skip: {
      label: "Skip",
      classes: "bg-gray-100 text-gray-600 border-gray-200",
    },
  };
  const v = priority ? map[priority] : null;
  if (!v) {
    return (
      <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-500 border border-gray-200">
        Unprioritized
      </span>
    );
  }
  return (
    <span
      className={`px-2 py-0.5 text-xs font-medium rounded-full border ${v.classes}`}
    >
      {v.label}
    </span>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3 border-b border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {title}
        </h4>
        {action}
      </div>
      {children}
    </div>
  );
}

export const V1AgentPanel = memo(function V1AgentPanel({
  email,
}: V1AgentPanelProps) {
  const updateEmail = useAppStore((s) => s.updateEmail);
  const [triageBusy, setTriageBusy] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!email) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm text-gray-400">Select an email</p>
          <p className="text-xs text-gray-400 mt-1">
            The agent panel shows triage and draft state for the open thread.
          </p>
        </div>
      </div>
    );
  }

  // From-name / from-email split (RFC 5322 "Name <addr>" form).
  const fromMatch = email.from.match(/^([^<]+?)\s*<([^>]+)>/);
  const fromName = fromMatch ? fromMatch[1].trim() : email.from;
  const fromEmail = fromMatch ? fromMatch[2] : email.from;

  async function runTriage() {
    if (!email) return;
    setTriageBusy(true);
    setError(null);
    try {
      // analysis.analyze runs the triage on the sidecar, persists to the
      // analyses table, and returns the row. We project it into the same
      // shape the email.analysis field uses.
      const result = (await window.api.analysis.analyze(email.id)) as {
        success: boolean;
        data?: {
          needsReply: boolean;
          reason: string;
          priority?: "high" | "medium" | "low" | "skip";
          analyzedAt?: number;
        };
        error?: string;
      };
      if (!result.success || !result.data) {
        setError(result.error ?? "Triage failed");
        return;
      }
      updateEmail(email.id, {
        analysis: {
          needsReply: result.data.needsReply,
          reason: result.data.reason,
          priority: result.data.priority,
          analyzedAt: result.data.analyzedAt ?? Date.now(),
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriageBusy(false);
    }
  }

  async function generateDraft() {
    if (!email) return;
    setDraftBusy(true);
    setError(null);
    try {
      // drafts.rerunAgent generates a fresh draft via Claude using the
      // user's style profile + the analyzer's reasoning. Returns the body.
      const result = (await window.api.drafts.rerunAgent(email.id)) as {
        success: boolean;
        data?: { body: string };
        error?: string;
      };
      if (!result.success || !result.data) {
        setError(result.error ?? "Draft generation failed");
        return;
      }
      updateEmail(email.id, {
        draft: {
          body: result.data.body,
          status: "pending",
          createdAt: Date.now(),
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusy(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      {error && (
        <div className="mx-4 mt-3 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md">
          {error}
        </div>
      )}

      {/* Sender identity — minimal until extension-driven enrichment lifts. */}
      <Section title="From">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-blue-100 text-blue-600 font-semibold flex items-center justify-center flex-shrink-0">
            {fromName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 truncate">{fromName}</p>
            <p className="text-xs text-gray-500 truncate">{fromEmail}</p>
          </div>
        </div>
      </Section>

      <Section
        title="Triage"
        action={
          <button
            onClick={runTriage}
            disabled={triageBusy}
            className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:text-gray-400"
          >
            {triageBusy
              ? "Running…"
              : email.analysis
                ? "Re-run"
                : "Run Triage"}
          </button>
        }
      >
        {email.analysis ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <PriorityPill priority={email.analysis.priority} />
              <span className="text-xs text-gray-500">
                {email.analysis.needsReply ? "Needs reply" : "No reply needed"}
              </span>
            </div>
            <p className="text-sm text-gray-700 leading-snug">
              {email.analysis.reason}
            </p>
          </div>
        ) : (
          <p className="text-sm text-gray-400">
            Not yet triaged. Run the analyzer to label priority and decide whether
            this needs a reply.
          </p>
        )}
      </Section>

      <Section
        title="Draft"
        action={
          <button
            onClick={generateDraft}
            disabled={draftBusy}
            className="text-xs font-medium text-purple-600 hover:text-purple-800 disabled:text-gray-400"
          >
            {draftBusy
              ? "Drafting…"
              : email.draft?.body
                ? "Regenerate"
                : "Generate"}
          </button>
        }
      >
        {email.draft?.body ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                  email.draft.status === "created"
                    ? "bg-green-100 text-green-700"
                    : email.draft.status === "edited"
                      ? "bg-blue-100 text-blue-700"
                      : "bg-gray-100 text-gray-600"
                }`}
              >
                {email.draft.status === "created"
                  ? "Saved to Gmail"
                  : email.draft.status === "edited"
                    ? "Edited"
                    : "Pending"}
              </span>
              <span className="text-xs text-gray-400">
                {new Date(email.draft.createdAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <p className="text-sm text-gray-700 leading-snug whitespace-pre-wrap line-clamp-6">
              {email.draft.body}
            </p>
          </div>
        ) : (
          <p className="text-sm text-gray-400">
            No draft yet. Generate a reply in your voice using the analyzer&apos;s
            reasoning + your style profile.
          </p>
        )}
      </Section>
    </div>
  );
});
