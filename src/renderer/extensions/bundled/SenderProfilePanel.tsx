import React, { useEffect, useState } from "react";
import type { DashboardEmail } from "../../../shared/types";
import type { ExtensionEnrichmentResult } from "../../../shared/extension-types";

// Two enrichment shapes we accept:
//
//  - V1 sidecar shape (current): { name, role, company, summary, linkedinUrl,
//    sources, cachedAt, isAutomated }
//  - Legacy Electron shape: { name, title, company, summary, linkedinUrl,
//    lookupAt, isReminder }
//
// We normalize them through one local view-model so the JSX below stays
// simple. Field aliases handled: role↔title, cachedAt↔lookupAt.

interface SourceLink {
  title: string;
  url: string;
}

interface SenderProfileViewModel {
  email?: string;
  name?: string;
  role?: string;
  company?: string;
  summary?: string;
  linkedinUrl?: string;
  sources?: SourceLink[];
  cachedAt?: number;
  isAutomated?: boolean;
  isReminder?: boolean;
}

interface SenderProfilePanelProps {
  email: DashboardEmail;
  threadEmails: DashboardEmail[];
  enrichment: ExtensionEnrichmentResult | null;
  isLoading: boolean;
}

function asProfile(raw: unknown): SenderProfileViewModel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sources: SourceLink[] = [];
  if (Array.isArray(r.sources)) {
    for (const s of r.sources) {
      if (s && typeof s === "object") {
        const sr = s as Record<string, unknown>;
        if (typeof sr.title === "string" && typeof sr.url === "string") {
          sources.push({ title: sr.title, url: sr.url });
        }
      }
    }
  }
  return {
    email: typeof r.email === "string" ? r.email : undefined,
    name: typeof r.name === "string" ? r.name : undefined,
    role: typeof r.role === "string" ? r.role : typeof r.title === "string" ? r.title : undefined,
    company: typeof r.company === "string" ? r.company : undefined,
    summary: typeof r.summary === "string" ? r.summary : undefined,
    linkedinUrl: typeof r.linkedinUrl === "string" ? r.linkedinUrl : undefined,
    sources,
    cachedAt:
      typeof r.cachedAt === "number"
        ? r.cachedAt
        : typeof r.lookupAt === "number"
          ? r.lookupAt
          : undefined,
    isAutomated: typeof r.isAutomated === "boolean" ? r.isAutomated : undefined,
    isReminder: typeof r.isReminder === "boolean" ? r.isReminder : undefined,
  };
}

/**
 * Sender Profile Panel - displays information about the email sender.
 */
export function SenderProfilePanel({
  email,
  enrichment,
  isLoading,
}: SenderProfilePanelProps): React.ReactElement {
  const profile = asProfile(enrichment?.data);
  const linkedInUrl =
    profile && typeof profile.linkedinUrl === "string"
      ? parseProfileLink(profile.linkedinUrl)
      : undefined;

  // Fallback values if no enrichment.
  const senderName = profile?.name || extractDisplayName(email.from);
  const senderEmail = profile?.email || extractEmailAddress(email.from);

  return (
    <div className="p-4">
      {profile?.isReminder && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs px-2 py-1 rounded mb-3">
          Returned via reminder - showing original sender
        </div>
      )}
      {profile?.isAutomated && (
        <div className="bg-gray-50 dark:bg-gray-900/30 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-xs px-2 py-1 rounded mb-3">
          Automated sender - skipping web lookup
        </div>
      )}

      {/* Sender Avatar & Name */}
      <div className="flex items-center space-x-3 mb-4">
        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-lg font-semibold text-white">
          {senderName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{senderName}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{senderEmail}</p>
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="flex items-center space-x-2 text-gray-500 dark:text-gray-400">
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span className="text-sm">Looking up...</span>
          </div>
        </div>
      )}

      {/* Profile Info */}
      {!isLoading && profile && (
        <div className="space-y-4">
          {(profile.company || profile.role) && (
            <div className="bg-gray-50 dark:bg-gray-800/50 p-3 rounded-lg">
              {profile.role && (
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {profile.role}
                </p>
              )}
              {profile.company && (
                <p className="text-sm text-gray-600 dark:text-gray-400">{profile.company}</p>
              )}
            </div>
          )}

          {profile.summary && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                About
              </h4>
              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                {profile.summary}
              </p>
            </div>
          )}

          {linkedInUrl && (
            <a
              href={linkedInUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center space-x-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
              </svg>
              <span>View LinkedIn</span>
            </a>
          )}

          {profile.sources && profile.sources.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                Sources
              </h4>
              <ul className="space-y-1">
                {profile.sources.map((s, i) => {
                  const safe = parseProfileLink(s.url);
                  if (!safe) return null;
                  return (
                    <li key={`${s.url}-${i}`}>
                      <a
                        href={safe}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate block"
                      >
                        {s.title}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {profile.cachedAt && (
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Last updated: {new Date(profile.cachedAt).toLocaleDateString()}
            </p>
          )}

          {/* "Was this useful?" feedback. Two effects:
                1. 'Wrong' invalidates the cached profile so the next open
                   re-fetches with a fresh web search instead of re-serving
                   the same bad bio.
                2. Every entry lands in `sender_feedback` so we can iterate
                   on the lookup prompt with the bad examples as a few-shot
                   set on the next prompt revision. */}
          <SenderFeedback senderEmail={profile.email ?? senderEmail} email={email} />
        </div>
      )}

      {/* No profile available */}
      {!isLoading && !profile && (
        <div className="text-center py-8">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No profile information available
          </p>
        </div>
      )}
    </div>
  );
}

function SenderFeedback({
  senderEmail,
  email,
}: {
  senderEmail: string;
  email: DashboardEmail;
}): React.ReactElement {
  const [submitted, setSubmitted] = useState<"useful" | "wrong" | "partial" | null>(null);
  const [showWrongForm, setShowWrongForm] = useState(false);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // On mount, look up any prior feedback so the panel doesn't keep prompting
  // a user who already gave it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.api.sender.getFeedback(senderEmail);
        if (cancelled) return;
        if (result.success && result.data) {
          setSubmitted(result.data.rating);
        }
      } catch {
        // ignore — feedback prompt is best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [senderEmail]);

  const submit = async (rating: "useful" | "wrong" | "partial", noteText?: string) => {
    setSubmitting(true);
    try {
      await window.api.sender.recordFeedback(senderEmail, rating, {
        notes: noteText,
        accountId: email.accountId ?? undefined,
        emailId: email.id,
      });
      setSubmitted(rating);
      setShowWrongForm(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-gray-800 pt-3 mt-3">
        Thanks — feedback recorded.{" "}
        {submitted !== "useful" && (
          <span className="text-gray-400 dark:text-gray-500">
            We'll re-look-up next time you open this thread.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-3">
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span>Was this useful?</span>
        <button
          type="button"
          onClick={() => void submit("useful")}
          disabled={submitting}
          className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
          title="Mark this profile as accurate"
        >
          👍 Yes
        </button>
        <button
          type="button"
          onClick={() => setShowWrongForm(true)}
          disabled={submitting}
          className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
          title="Mark this profile as wrong"
        >
          👎 No
        </button>
      </div>
      {showWrongForm && (
        <div className="mt-2 space-y-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What's wrong? (e.g. 'company is X not Y', or 'this person doesn't exist')"
            className="w-full text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 focus:outline-none focus:border-blue-400"
            rows={2}
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setShowWrongForm(false);
                setNotes("");
              }}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit("wrong", notes.trim() || undefined)}
              disabled={submitting}
              className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Submit"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function parseProfileLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function extractDisplayName(from: string): string {
  const match = from.match(/^\s*([^<]+?)\s*(?:<|$)/);
  return match ? match[1].trim() : from.trim();
}

function extractEmailAddress(from: string): string {
  const match = from.match(/<\s*([^>]+?)\s*>/);
  return (match ? match[1] : from).trim().toLowerCase();
}
