// Triage catch-up: runs analysis.analyzeBatch on inbox emails that have no
// analysis row yet.
//
// Two callers:
//   1. App.tsx — boot sweep that runs once per account once sync settles, AND
//      re-runs when the user adds an Anthropic key for the first time. Source
//      "boot" so the toast can read differently if we ever want to.
//   2. EmailList.tsx — manual "Triage All" button on the inbox toolbar. Source
//      "manual".
//
// Both callers gate on `diagnostics.hasAnyLlmProvider()` — there's no point
// firing analyzeBatch when the sidecar will just rate-limit the upstream
// provider with auth errors. The gate accepts EITHER an Anthropic key OR
// an OpenRouter key (the LLM router auto-selects based on the analysis
// model id). On a missing provider we silently noop (the SetupWizard /
// Settings card is the only place that should surface that condition).
//
// We cap at MAX_TRIAGE_BATCH (50) so the call returns in a reasonable time
// window. The toast clears when the call resolves; subsequent boots keep
// chipping away at the backlog.

import { useAppStore } from "../store";
import type { DashboardEmail } from "../../shared/types";

export const MAX_TRIAGE_BATCH = 50;

export type TriageSource = "boot" | "manual";

/** Pick inbox emails (account-scoped) that don't yet have an analysis row. */
function pickUnanalyzedIds(emails: DashboardEmail[], accountId: string | null): string[] {
  return emails
    .filter((e) => {
      if (accountId && e.accountId !== accountId) return false;
      if (e.analysis) return false;
      if (e.labelIds?.includes("SENT")) return false;
      return true;
    })
    .map((e) => e.id);
}

/**
 * Run a triage sweep for the current account.
 *
 * Returns the number of emails that were submitted (0 means there was nothing
 * to do, or the API key wasn't configured — caller can use that to suppress
 * surprised feedback).
 *
 * The toast surface (renderer state `triageStatus`) is owned by this helper
 * so callers don't have to remember to clear it on the error path.
 */
export async function runTriageCatchUp(source: TriageSource): Promise<number> {
  const state = useAppStore.getState();
  const { currentAccountId, emails, setTriageStatus } = state;

  // Don't stack: if a triage is already running, ignore.
  if (state.triageStatus) return 0;

  const unanalyzedIds = pickUnanalyzedIds(emails, currentAccountId).slice(0, MAX_TRIAGE_BATCH);
  if (unanalyzedIds.length === 0) return 0;

  // Probe LLM provider — silently bail if missing. Boot path runs
  // unconditionally (no provider just means no triage); manual path could
  // surface the SetupWizard but that's a future polish; for now the user
  // already saw the empty Priority tab + the Settings → Agent Tools intro
  // card flagging the key. The gate is "any LLM" (Anthropic OR OpenRouter)
  // so OpenRouter-only users aren't silently locked out.
  try {
    const has = await window.api.diagnostics.hasAnyLlmProvider();
    if (!has?.success || !has.data?.configured) return 0;
  } catch (err) {
    console.warn("[triage] hasAnyLlmProvider probe failed:", err);
    return 0;
  }

  setTriageStatus({ count: unanalyzedIds.length, source });
  try {
    await window.api.analysis.analyzeBatch(unanalyzedIds);
  } catch (err) {
    console.warn(`[triage] ${source} analyze failed:`, err);
  } finally {
    setTriageStatus(null);
  }
  return unanalyzedIds.length;
}
