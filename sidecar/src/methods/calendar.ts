// `calendar` IPC namespace — Google Calendar V1 surface.
//
// Methods covered here:
//   calendar.list             — calendars across one or all Gmail accounts
//   calendar.setVisibility    — toggle a calendar in/out of the renderer's view
//   calendar.getEvents        — events for a calendar (or all visible),
//                                windowed today-1d → today+30d
//   calendar.respondToEvent   — RSVP (Accept/Decline/Tentative)
//
// Visibility: stored in preferences.json under `calendarVisibility`, keyed
// `${accountId}:${calendarId}` → boolean. Defaults to "visible" unless a
// user has explicitly hidden the calendar. We avoid a SQLite table for
// this V1 because the cardinality is tiny (one row per (account,calendar))
// and visibility is a renderer-only concern.
//
// Caching: `calendar.getEvents` results are memoized for 60 seconds in
// process. The cache key is (accountId, calendarId, timeMin, timeMax) so
// switching the date window or account refreshes immediately. Cache is
// dropped when `respondToEvent` succeeds against that calendar so an RSVP
// is reflected on the next render without waiting out the TTL.

import { registerMethod } from "../rpc.js";
import { getDb } from "../db/index.js";
import {
  listCalendars,
  listEvents,
  respondToEvent,
  type CalendarEventRow,
  type CalendarRow,
  type RsvpResponse,
} from "../services/calendar-sync.js";
import { listAccountIdsWithTokens } from "../services/oauth-gmail.js";
import { getPreferences, setPreference } from "../lib/preferences.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("calendar-method");

// ── Visibility prefs ────────────────────────────────────────────────────

interface CalendarVisibilityMap {
  [key: string]: boolean;
}

function visibilityKey(accountId: string, calendarId: string): string {
  return `${accountId}:${calendarId}`;
}

function getVisibilityMap(): CalendarVisibilityMap {
  const prefs = getPreferences();
  const raw = prefs.calendarVisibility;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as CalendarVisibilityMap;
  }
  return {};
}

function isCalendarVisible(accountId: string, calendarId: string): boolean {
  const map = getVisibilityMap();
  const v = map[visibilityKey(accountId, calendarId)];
  // Default to visible when the user hasn't toggled the calendar.
  return v !== false;
}

function setCalendarVisibility(accountId: string, calendarId: string, visible: boolean): void {
  const next = { ...getVisibilityMap() };
  next[visibilityKey(accountId, calendarId)] = visible;
  setPreference("calendarVisibility", next);
}

// ── Account helpers ─────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  email: string;
  provider: string;
}

/**
 * Only Gmail accounts have calendars wired here. IMAP/Graph come later;
 * for now they're skipped silently so the calendar UI doesn't crash on
 * mixed-provider setups.
 */
function listGmailAccountIds(): AccountRow[] {
  const all = getDb()
    .prepare(
      "SELECT id, email, COALESCE(provider, 'gmail') as provider FROM accounts ORDER BY added_at ASC",
    )
    .all() as AccountRow[];
  // Only return Gmail accounts that also have a token file on disk —
  // there's no point trying to hit the API for accounts we can't auth.
  const tokenIds = new Set(listAccountIdsWithTokens());
  return all.filter((a) => a.provider === "gmail" && tokenIds.has(a.id));
}

// ── Event cache (60s TTL) ───────────────────────────────────────────────

interface CacheEntry {
  rows: CalendarEventRow[];
  expiresAt: number;
}

const eventCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function eventCacheKey(
  accountId: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): string {
  return `${accountId}|${calendarId}|${timeMin}|${timeMax}`;
}

function invalidateEventCache(accountId: string, calendarId: string): void {
  const prefix = `${accountId}|${calendarId}|`;
  for (const key of [...eventCache.keys()]) {
    if (key.startsWith(prefix)) eventCache.delete(key);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Standard 31-day window — today minus 1 day to today plus 30 days.
 * Centralized so cache keys stay stable across getEvents calls within
 * the same minute.
 */
function defaultWindow(): { timeMin: string; timeMax: string } {
  const now = new Date();
  // Snap to the start of the current minute so two calls within the same
  // 60s window get the same cache key. Without this, every call would
  // produce a unique timeMin and bypass the cache entirely.
  now.setSeconds(0, 0);
  const timeMin = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return { timeMin, timeMax };
}

// ── Method registration ─────────────────────────────────────────────────

export function registerCalendarMethods(): void {
  // List calendars (one account or all Gmail accounts).
  // Returns the SettingsPanel-friendly shape:
  //   { success: true, calendars: [...flat...], accountEmails: { id: email } }
  //
  // Each calendar carries its accountId so the panel can group by account.
  // We also fold in the user's local visibility preference so the toggle
  // state matches what they last set.
  registerMethod("calendar.list", async (params) => {
    const { accountId } = (params as { accountId?: string } | null | undefined) ?? {};

    const accounts = accountId
      ? listGmailAccountIds().filter((a) => a.id === accountId)
      : listGmailAccountIds();

    const accountEmails: Record<string, string> = {};
    for (const a of accounts) accountEmails[a.id] = a.email;

    // Fan out to all accounts in parallel — a slow account shouldn't block
    // the rest. listCalendars catches its own errors and returns [].
    const perAccount = await Promise.all(
      accounts.map(async (a) => {
        const cals = await listCalendars(a.id);
        return cals.map((c: CalendarRow) => ({
          accountId: a.id,
          calendarId: c.id,
          calendarName: c.summary,
          calendarColor: c.backgroundColor,
          primary: c.primary,
          visible: isCalendarVisible(a.id, c.id),
        }));
      }),
    );

    return {
      success: true as const,
      calendars: perAccount.flat(),
      accountEmails,
    };
  });

  // Persist the user's visibility toggle. Returns {success:true} so the
  // SettingsPanel's existing IpcResponse-shape consumer is satisfied.
  registerMethod("calendar.setVisibility", (params) => {
    const { accountId, calendarId, visible } =
      (params as {
        accountId?: string;
        calendarId?: string;
        visible?: boolean;
      } | null) ?? {};
    if (!accountId || !calendarId || typeof visible !== "boolean") {
      throw new Error("calendar.setVisibility: requires { accountId, calendarId, visible }");
    }
    setCalendarVisibility(accountId, calendarId, visible);
    return { success: true as const, data: null };
  });

  // Fetch events. Three modes:
  //   1. {accountId, calendarId} → that one calendar.
  //   2. {accountId} → all visible calendars on that account, merged.
  //   3. {} → all visible calendars across all Gmail accounts, merged.
  //
  // Always windowed by the standard today-1d→today+30d range; results
  // are sorted by start time so the renderer can iterate top-to-bottom.
  registerMethod("calendar.getEvents", async (params) => {
    const { accountId, calendarId } =
      (params as { accountId?: string; calendarId?: string } | null) ?? {};
    const { timeMin, timeMax } = defaultWindow();

    // Build the (accountId, calendarId) tuples we need to fetch.
    let targets: Array<{ accountId: string; calendarId: string }> = [];
    if (accountId && calendarId) {
      targets = [{ accountId, calendarId }];
    } else {
      // List calendars for one account (if accountId given) or all Gmail
      // accounts. Filter to visible-only.
      const accounts = accountId
        ? listGmailAccountIds().filter((a) => a.id === accountId)
        : listGmailAccountIds();
      for (const a of accounts) {
        const cals = await listCalendars(a.id);
        for (const c of cals) {
          if (!isCalendarVisible(a.id, c.id)) continue;
          targets.push({ accountId: a.id, calendarId: c.id });
        }
      }
    }

    // Fan out, honoring the 60s in-memory cache.
    const now = Date.now();
    const allRows = await Promise.all(
      targets.map(async (t) => {
        const key = eventCacheKey(t.accountId, t.calendarId, timeMin, timeMax);
        const cached = eventCache.get(key);
        if (cached && cached.expiresAt > now) return cached.rows;
        const rows = await listEvents(t.accountId, t.calendarId, { timeMin, timeMax });
        eventCache.set(key, { rows, expiresAt: now + CACHE_TTL_MS });
        return rows;
      }),
    );

    // Merge + sort across calendars. All rows have the same iso shape so a
    // string comparison is a valid chronological sort for both timed and
    // all-day events. Within the same timestamp Google's order is stable
    // enough for V1.
    const merged: CalendarEventRow[] = ([] as CalendarEventRow[]).concat(...allRows);
    merged.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return merged;
  });

  // Patch the user's responseStatus on the event. Invalidates the cache
  // for that calendar so the next getEvents call sees the new RSVP.
  registerMethod("calendar.respondToEvent", async (params) => {
    const { accountId, calendarId, eventId, response } =
      (params as {
        accountId?: string;
        calendarId?: string;
        eventId?: string;
        response?: RsvpResponse;
      } | null) ?? {};
    if (!accountId || !calendarId || !eventId || !response) {
      throw new Error(
        "calendar.respondToEvent: requires { accountId, calendarId, eventId, response }",
      );
    }
    if (!["accepted", "declined", "tentative"].includes(response)) {
      throw new Error(`calendar.respondToEvent: invalid response "${response}"`);
    }
    try {
      const result = await respondToEvent(accountId, calendarId, eventId, response);
      invalidateEventCache(accountId, calendarId);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("respondToEvent failed", { accountId, calendarId, eventId, err: msg });
      throw new Error(`Failed to RSVP: ${msg}`);
    }
  });
}
