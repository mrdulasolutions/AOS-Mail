// `briefing` IPC namespace — daily Morning Briefing.
//
// V1 surface:
//   briefing.getOrGenerate({ accountId, date?, force? })
//     - Returns today's (default) or the given date's briefing, generating
//       and caching it if missing. Subsequent calls on the same day return
//       the cached row.
//   briefing.dismiss({ accountId, date })
//     - Marks `dismissed_at = now` so the renderer's take-over panel
//       doesn't reappear that day.
//   briefing.list({ accountId, limit? })
//     - Last `limit` (default 7) days of briefings, newest first. Lets the
//       user scroll back through prior days.
//
// All persistence lives in the daily_briefings table (see schema.ts). The
// service in services/morning-briefing.ts owns the LLM call + SQL stats
// gathering; this file is just the thin RPC layer.

import { registerMethod } from "../rpc.js";
import {
  dismissBriefing,
  getOrGenerateBriefing,
  listBriefings,
  todayIsoDate,
} from "../services/morning-briefing.js";

export function registerBriefingMethods(): void {
  registerMethod("briefing.getOrGenerate", async (params) => {
    const { accountId, date, force } =
      (params as { accountId?: string; date?: string; force?: boolean }) ?? {};
    if (!accountId) {
      throw new Error("briefing.getOrGenerate: requires { accountId }");
    }
    const briefing = await getOrGenerateBriefing({
      accountId,
      date: date ?? undefined,
      force: !!force,
    });
    return briefing;
  });

  registerMethod("briefing.dismiss", (params) => {
    const { accountId, date } = (params as { accountId?: string; date?: string }) ?? {};
    if (!accountId) {
      throw new Error("briefing.dismiss: requires { accountId, date }");
    }
    // Default to today if `date` is omitted — the common case is the
    // user dismissing the briefing currently on screen.
    const targetDate = date ?? todayIsoDate();
    const updated = dismissBriefing(accountId, targetDate);
    return { ok: true as const, briefing: updated };
  });

  registerMethod("briefing.list", (params) => {
    const { accountId, limit } = (params as { accountId?: string; limit?: number }) ?? {};
    if (!accountId) {
      throw new Error("briefing.list: requires { accountId }");
    }
    return listBriefings(accountId, limit ?? 7);
  });
}
