// Google Calendar fetch helpers — sidecar implementation.
//
// Mirrors the pattern used by services/sync.ts (which handles Gmail/IMAP
// mail sync): a thin wrapper around googleapis that returns plain
// camelCased objects the renderer can consume directly. We keep state out
// of this module — visibility preferences live in preferences.json
// (managed by methods/calendar.ts), and event caching happens at the
// method level, not here.
//
// Scope: V1 surface is read-only event display + RSVP. The Gmail OAuth
// flow already requests `calendar.readonly` so existing tokens work for
// list/get; RSVP uses calendar.events.patch which requires the broader
// `calendar.events` scope. We attempt RSVP and surface a readable error
// when the user hasn't re-consented for write access yet.
//
// All times come from Google as either dateTime (ISO string with timezone)
// or date (YYYY-MM-DD for all-day events). We return both shapes verbatim;
// the renderer normalizes for display.

import { google } from "googleapis";
import { authedClientForAccount } from "./oauth-gmail.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("calendar-sync");

// ── Types ───────────────────────────────────────────────────────────────

/**
 * Calendar metadata as returned by users.calendarList. We keep the fields
 * the UI actually uses; the rest are dropped to keep the wire payload
 * lean.
 */
export interface CalendarRow {
  /** Stable Google calendar id, e.g. "primary" or an email-shaped string. */
  id: string;
  /** Display name. Google returns this as `summary`. */
  summary: string;
  /** True for the user's main calendar. */
  primary: boolean;
  /** Hex color (e.g. "#4285F4"). Defaults to a neutral gray when missing. */
  backgroundColor: string;
  /**
   * Whether the user has selected this calendar in Google Calendar's own
   * UI. We honor it as the default visibility, but local visibility
   * overrides via setVisibility take precedence.
   */
  selected: boolean;
}

/**
 * Single event row — mirrors `calendar_events` columns but shaped for the
 * renderer (camelCase, structured start/end). The DB columns are split
 * between start_time/end_time strings + is_all_day flag; we preserve that
 * shape here so the renderer can render both timed and all-day events
 * uniformly.
 */
export interface CalendarEventRow {
  /** Google event id. Unique within a calendar. */
  id: string;
  accountId: string;
  calendarId: string;
  /** Display name of the calendar this event belongs to. */
  calendarName: string;
  /** Calendar background color (hex). */
  calendarColor: string;
  /** Event title. Google may return empty string for "(No title)" events. */
  summary: string;
  /** Long description (may include HTML). Optional. */
  description: string | null;
  /** Free-form location. Optional. */
  location: string | null;
  /** ISO timestamp for timed events; YYYY-MM-DD for all-day. */
  start: string;
  /** ISO timestamp for timed events; YYYY-MM-DD for all-day. */
  end: string;
  /** True when start/end are date-only (all-day or multi-day). */
  isAllDay: boolean;
  /** "confirmed" | "tentative" | "cancelled". */
  status: "confirmed" | "tentative" | "cancelled";
  /** Public URL to open the event in Google Calendar. */
  htmlLink: string | null;
  /** Google Meet / Hangouts link if the event has a video conference. */
  hangoutLink: string | null;
  /** Attendees, or null for solo events. Self-status is derived per call. */
  attendees: Array<{
    email: string;
    displayName: string | null;
    /** "needsAction" | "declined" | "tentative" | "accepted" */
    responseStatus: string;
    /** True for the calendar owner's own attendee row. */
    self: boolean;
    /** True for the event organizer. */
    organizer: boolean;
  }> | null;
  /**
   * The calendar owner's own response status, or null if the user isn't
   * an invitee (e.g. they own the event, or it's solo). Lifted out of
   * `attendees` so the UI can highlight it without re-deriving.
   */
  selfResponseStatus: "needsAction" | "declined" | "tentative" | "accepted" | null;
  /** True when the calendar owner created the event. */
  isOrganizer: boolean;
}

export interface ListEventsOptions {
  /** Lower bound, ISO timestamp. Default: today - 1 day. */
  timeMin?: string;
  /** Upper bound, ISO timestamp. Default: today + 30 days. */
  timeMax?: string;
  /** Page size cap. Default 250 (Google's max for events.list). */
  maxResults?: number;
}

export type RsvpResponse = "accepted" | "declined" | "tentative";

// ── List calendars ──────────────────────────────────────────────────────

/**
 * Fetch the calendar list for one Gmail account. Returns an empty array
 * (logged at warn) if the account's OAuth token doesn't include the
 * calendar scope or the API call otherwise fails — better to render the
 * empty state than crash the panel.
 */
export async function listCalendars(accountId: string): Promise<CalendarRow[]> {
  let auth;
  try {
    auth = authedClientForAccount(accountId);
  } catch (err) {
    log.warn("listCalendars: no auth for account", {
      accountId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const calendar = google.calendar({ version: "v3", auth });
  try {
    // Note: it's `calendar.calendarList.list`, NOT `users.calendarList.list`.
    // The v3 API exposes calendarList directly.
    const res = await calendar.calendarList.list({ maxResults: 250 });
    const items = res.data.items ?? [];
    return items
      .filter((it): it is NonNullable<typeof it> & { id: string } => typeof it.id === "string")
      .map((it) => ({
        id: it.id,
        summary: it.summary ?? it.id,
        primary: !!it.primary,
        backgroundColor: it.backgroundColor ?? "#9aa0a6",
        // Google's `selected` is true by default for the primary calendar
        // and any calendar the user has explicitly toggled on. Treat
        // missing as `true` (Google Calendar's actual default UX).
        selected: it.selected !== false,
      }));
  } catch (err) {
    log.warn("listCalendars failed", {
      accountId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ── List events ─────────────────────────────────────────────────────────

function normalizeEventDate(raw: { date?: string | null; dateTime?: string | null }): {
  iso: string;
  isAllDay: boolean;
} {
  // Google returns either {dateTime, timeZone} for timed events or {date}
  // for all-day. We coerce to a single ISO string and an isAllDay flag.
  if (raw.dateTime) return { iso: raw.dateTime, isAllDay: false };
  if (raw.date) return { iso: raw.date, isAllDay: true };
  // Defensive: if Google returns a malformed event we'd rather skip it
  // than crash. Caller filters out items with empty iso below.
  return { iso: "", isAllDay: false };
}

/**
 * Fetch events for one calendar within a time window. Defaults:
 *   timeMin = today - 1 day (so the strip can show "today + recent past")
 *   timeMax = today + 30 days
 *   maxResults = 250 (Google's hard cap for events.list)
 *
 * `singleEvents=true` expands recurring events into their concrete
 * instances; `orderBy=startTime` gives us pre-sorted results so the
 * renderer can avoid a second sort pass.
 *
 * Errors are caught and logged — same rationale as listCalendars.
 */
export async function listEvents(
  accountId: string,
  calendarId: string,
  opts: ListEventsOptions = {},
): Promise<CalendarEventRow[]> {
  let auth;
  try {
    auth = authedClientForAccount(accountId);
  } catch (err) {
    log.warn("listEvents: no auth for account", {
      accountId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const now = new Date();
  const timeMin = opts.timeMin ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = opts.timeMax ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const maxResults = opts.maxResults ?? 250;

  const calendar = google.calendar({ version: "v3", auth });

  // Resolve the calendar's name + color so we can stamp it on every event
  // row. The renderer wants this denormalized for fast rendering.
  let calendarName = calendarId;
  let calendarColor = "#9aa0a6";
  try {
    const meta = await calendar.calendarList.get({ calendarId });
    calendarName = meta.data.summary ?? calendarId;
    calendarColor = meta.data.backgroundColor ?? "#9aa0a6";
  } catch {
    // Non-fatal — fall back to the id and a neutral color.
  }

  try {
    const res = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults,
    });
    const items = res.data.items ?? [];

    const rows: CalendarEventRow[] = [];
    for (const e of items) {
      if (!e.id) continue;
      const start = normalizeEventDate(e.start ?? {});
      const end = normalizeEventDate(e.end ?? {});
      if (!start.iso || !end.iso) continue;

      const attendees =
        e.attendees && e.attendees.length > 0
          ? e.attendees.map((a) => ({
              email: a.email ?? "",
              displayName: a.displayName ?? null,
              responseStatus: a.responseStatus ?? "needsAction",
              self: !!a.self,
              organizer: !!a.organizer,
            }))
          : null;

      const selfAttendee = attendees?.find((a) => a.self) ?? null;
      const selfResponseStatus = selfAttendee
        ? ((selfAttendee.responseStatus as "needsAction" | "declined" | "tentative" | "accepted") ??
          null)
        : null;

      rows.push({
        id: e.id,
        accountId,
        calendarId,
        calendarName,
        calendarColor,
        summary: e.summary ?? "(No title)",
        description: e.description ?? null,
        location: e.location ?? null,
        start: start.iso,
        end: end.iso,
        isAllDay: start.isAllDay,
        status: (e.status as "confirmed" | "tentative" | "cancelled") ?? "confirmed",
        htmlLink: e.htmlLink ?? null,
        hangoutLink: e.hangoutLink ?? null,
        attendees,
        selfResponseStatus,
        isOrganizer: !!e.organizer?.self,
      });
    }
    return rows;
  } catch (err) {
    log.warn("listEvents failed", {
      accountId,
      calendarId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ── RSVP ────────────────────────────────────────────────────────────────

/**
 * Update the calendar owner's `responseStatus` on an event they're
 * invited to.
 *
 * Google's events.patch with `sendUpdates="none"` is the standard way to
 * RSVP without spamming other attendees. We patch only the matching
 * `attendees[i]` row — the rest of the event stays untouched.
 *
 * Returns `{ ok: true }` on success or throws — the method-layer wrapper
 * surfaces the error string to the renderer.
 */
export async function respondToEvent(
  accountId: string,
  calendarId: string,
  eventId: string,
  response: RsvpResponse,
): Promise<{ ok: true }> {
  const auth = authedClientForAccount(accountId);
  const calendar = google.calendar({ version: "v3", auth });

  // Read the event to find the self attendee row, then patch with an
  // updated attendees array. We patch the full attendees array (not just
  // one entry) because Google's API doesn't expose a per-row patch.
  const existing = await calendar.events.get({ calendarId, eventId });
  const attendees = existing.data.attendees ?? [];
  if (attendees.length === 0) {
    throw new Error("respondToEvent: event has no attendees to RSVP for");
  }
  const updated = attendees.map((a) => (a.self ? { ...a, responseStatus: response } : a));

  await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: { attendees: updated },
    sendUpdates: "none",
  });
  return { ok: true };
}
