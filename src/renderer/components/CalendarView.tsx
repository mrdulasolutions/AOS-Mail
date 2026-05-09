// CalendarView — V1 list-style calendar accessory for AOS Mail.
//
// Layout:
//   ┌──────────────────────────────────────────────────────────────────┐
//   │  Date strip: [Today] May 7  •  31-day window                     │
//   │  Tomorrow ─────────────────────────────────────────────────       │
//   │   • 9:30am   Standup                ⬤ blue   📹 Google Meet      │
//   │   • 11:00am  1:1 with Alice         ⬤ green                       │
//   │  Friday ───────────────────────────────────────────────────       │
//   │   …                                                              │
//   └──────────────────────────────────────────────────────────────────┘
//
// Click an event row → expands to show description, attendees, an
// "Open in Google Calendar" link, and (when the user is an invitee)
// RSVP buttons that hit calendar.respondToEvent.
//
// V1 explicitly does NOT render a month grid — this is a sidebar
// accessory, not a full calendar app. The 31-day window is fetched once,
// cached server-side for 60s, and streamed back to the renderer as a flat
// pre-sorted array of events.

import { useEffect, useMemo, useState } from "react";
import type { CalendarEventRow } from "../../shared/sidecar-contract";
import { openExternalUrl } from "../lib/external-url";

type RsvpResponse = "accepted" | "declined" | "tentative";

// ── Date helpers ────────────────────────────────────────────────────────
//
// We deliberately avoid pulling a date library here. The renderer already
// uses Intl.DateTimeFormat in plenty of places and these helpers are
// cheap. Everything works in the user's local timezone — Google returns
// either timezone-aware ISO strings (timed events) or YYYY-MM-DD (all-day);
// both are interpreted as local for display.

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function dayKey(d: Date): string {
  // YYYY-MM-DD string in local TZ — used as the grouping key.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseEventStart(event: CalendarEventRow): Date {
  // All-day events use YYYY-MM-DD; new Date("2026-05-07") parses as UTC,
  // which can shift to the prior day in negative-offset timezones. Force
  // local interpretation by appending a midnight time.
  if (event.isAllDay) {
    return new Date(event.start + "T00:00:00");
  }
  return new Date(event.start);
}

function formatDayHeader(date: Date): string {
  const today = startOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const target = startOfDay(date);
  if (target.getTime() === today.getTime()) return "Today";
  if (target.getTime() === tomorrow.getTime()) return "Tomorrow";
  // Within the next 7 days → weekday name; otherwise full date.
  const diffDays = Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays > 1 && diffDays < 7) {
    return target.toLocaleDateString(undefined, { weekday: "long" });
  }
  return target.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatEventTime(event: CalendarEventRow): string {
  if (event.isAllDay) return "All day";
  const start = parseEventStart(event);
  return start.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatEventTimeRange(event: CalendarEventRow): string {
  if (event.isAllDay) return "All day";
  const start = parseEventStart(event);
  const end = new Date(event.end);
  const fmt: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  return `${start.toLocaleTimeString(undefined, fmt)} – ${end.toLocaleTimeString(undefined, fmt)}`;
}

// ── Group events by day ─────────────────────────────────────────────────

interface DayGroup {
  key: string;
  date: Date;
  events: CalendarEventRow[];
}

function groupByDay(events: CalendarEventRow[]): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const e of events) {
    const date = startOfDay(parseEventStart(e));
    const key = dayKey(date);
    let group = map.get(key);
    if (!group) {
      group = { key, date, events: [] };
      map.set(key, group);
    }
    group.events.push(e);
  }
  // Map iteration order isn't guaranteed chronological since events come in
  // sorted but the grouping rebuilds. Sort by key (YYYY-MM-DD sorts
  // lexicographically the same way it sorts chronologically).
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ── Subcomponents ───────────────────────────────────────────────────────

interface AttendeeListProps {
  attendees: NonNullable<CalendarEventRow["attendees"]>;
}

function AttendeeList({ attendees }: AttendeeListProps): JSX.Element {
  return (
    <div className="space-y-1">
      {attendees.map((a) => (
        <div key={a.email} className="flex items-center gap-2 text-xs">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              a.responseStatus === "accepted"
                ? "bg-green-500"
                : a.responseStatus === "declined"
                  ? "bg-red-500"
                  : a.responseStatus === "tentative"
                    ? "bg-amber-500"
                    : "bg-gray-400"
            }`}
            title={a.responseStatus}
          />
          <span className="text-gray-800 dark:text-gray-200 truncate">
            {a.displayName ?? a.email}
            {a.organizer && (
              <span className="ml-1 text-gray-400 dark:text-gray-500">(organizer)</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

interface RsvpButtonsProps {
  current: "accepted" | "declined" | "tentative" | "needsAction" | null;
  onRespond: (response: RsvpResponse) => void;
  pending: boolean;
}

function RsvpButtons({ current, onRespond, pending }: RsvpButtonsProps): JSX.Element {
  const buttonClass = (active: boolean): string =>
    `px-2.5 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50 ${
      active
        ? "bg-blue-600 text-white"
        : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
    }`;
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => onRespond("accepted")}
        disabled={pending}
        className={buttonClass(current === "accepted")}
      >
        Accept
      </button>
      <button
        onClick={() => onRespond("tentative")}
        disabled={pending}
        className={buttonClass(current === "tentative")}
      >
        Maybe
      </button>
      <button
        onClick={() => onRespond("declined")}
        disabled={pending}
        className={buttonClass(current === "declined")}
      >
        Decline
      </button>
    </div>
  );
}

// ── Event row + expanded panel ──────────────────────────────────────────

interface EventRowProps {
  event: CalendarEventRow;
  expanded: boolean;
  onToggle: () => void;
  onRespond: (event: CalendarEventRow, response: RsvpResponse) => Promise<void>;
}

function EventRow({ event, expanded, onToggle, onRespond }: EventRowProps): JSX.Element {
  const [pendingRsvp, setPendingRsvp] = useState(false);
  const [rsvpError, setRsvpError] = useState<string | null>(null);

  const handleRespond = async (response: RsvpResponse): Promise<void> => {
    setPendingRsvp(true);
    setRsvpError(null);
    try {
      await onRespond(event, response);
    } catch (err) {
      setRsvpError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingRsvp(false);
    }
  };

  // Show RSVP controls only when the user is an invitee (not the
  // organizer of a self-event with no other attendees).
  const isInvitee = event.selfResponseStatus !== null;

  return (
    <div className="border-b border-gray-100 dark:border-gray-800 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors focus:outline-none"
      >
        <span
          className="w-3 h-3 rounded-sm flex-shrink-0"
          style={{ backgroundColor: event.calendarColor }}
          title={event.calendarName}
        />
        <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums w-20 flex-shrink-0">
          {formatEventTime(event)}
        </span>
        <span
          className={`flex-1 text-sm truncate ${
            event.status === "cancelled"
              ? "line-through text-gray-400 dark:text-gray-500"
              : "text-gray-900 dark:text-gray-100"
          }`}
        >
          {event.summary}
        </span>
        {event.hangoutLink && (
          <span
            className="text-xs px-1.5 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded flex-shrink-0"
            title="Has video call"
          >
            Video
          </span>
        )}
        {event.selfResponseStatus === "needsAction" && (
          <span
            className="text-xs px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded flex-shrink-0"
            title="No response yet"
          >
            New
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 pt-1 ml-6 space-y-3 text-sm">
          <div className="text-gray-600 dark:text-gray-400">{formatEventTimeRange(event)}</div>
          {event.location && (
            <div className="text-xs text-gray-700 dark:text-gray-300">
              <span className="text-gray-400 dark:text-gray-500">Location: </span>
              {event.location}
            </div>
          )}
          {event.description && (
            <div className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap line-clamp-6">
              {event.description}
            </div>
          )}
          {event.attendees && event.attendees.length > 0 && (
            <div>
              <div className="text-xs text-gray-400 dark:text-gray-500 mb-1">
                Attendees ({event.attendees.length})
              </div>
              <AttendeeList attendees={event.attendees} />
            </div>
          )}
          {isInvitee && (
            <div>
              <RsvpButtons
                current={event.selfResponseStatus}
                onRespond={handleRespond}
                pending={pendingRsvp}
              />
              {rsvpError && (
                <div className="mt-1 text-xs text-red-600 dark:text-red-400">{rsvpError}</div>
              )}
            </div>
          )}
          {event.htmlLink && (
            <button
              type="button"
              onClick={() => openExternalUrl(event.htmlLink!)}
              className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
            >
              Open in Google Calendar
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main view ───────────────────────────────────────────────────────────

interface CalendarApiShape {
  getEvents: (params?: {
    accountId?: string;
    calendarId?: string;
  }) => Promise<{ success: boolean; data?: unknown[]; error?: string }>;
  respondToEvent: (
    accountId: string,
    calendarId: string,
    eventId: string,
    response: RsvpResponse,
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  getCalendars: () => Promise<{
    success: boolean;
    calendars?: unknown[];
    accountEmails?: Record<string, string>;
    error?: string;
  }>;
}

function getCalendarApi(): CalendarApiShape {
  return (window as unknown as { api: { calendar: CalendarApiShape } }).api.calendar;
}

export function CalendarView(): JSX.Element {
  const [events, setEvents] = useState<CalendarEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [visibleCalendarCount, setVisibleCalendarCount] = useState<number | null>(null);

  // Fetch events on mount + whenever a refresh is triggered.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getCalendarApi()
      .getEvents()
      .then((result) => {
        if (cancelled) return;
        if (result.success && Array.isArray(result.data)) {
          setEvents(result.data as CalendarEventRow[]);
        } else if (!result.success) {
          setError(result.error ?? "Failed to load events");
          setEvents([]);
        } else {
          setEvents([]);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // Pull the visible-calendar count once for the empty-state hint.
  useEffect(() => {
    let cancelled = false;
    void getCalendarApi()
      .getCalendars()
      .then((result) => {
        if (cancelled) return;
        const cals = (result.calendars ?? []) as Array<{ visible: boolean }>;
        const visible = cals.filter((c) => c.visible).length;
        setVisibleCalendarCount(visible);
      })
      .catch(() => {
        // Non-fatal — empty state will just omit the hint.
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const grouped = useMemo(() => groupByDay(events), [events]);

  const handleRespond = async (event: CalendarEventRow, response: RsvpResponse): Promise<void> => {
    const result = await getCalendarApi().respondToEvent(
      event.accountId,
      event.calendarId,
      event.id,
      response,
    );
    if (!result.success) {
      throw new Error(result.error ?? "RSVP failed");
    }
    // Optimistic local update so the UI reflects the new status without a
    // refetch round-trip. The server-side cache invalidation in the
    // sidecar means a full refresh would also pick this up, but mutating
    // the local copy avoids the flicker.
    setEvents((prev) =>
      prev.map((e) =>
        e.id === event.id && e.calendarId === event.calendarId
          ? {
              ...e,
              selfResponseStatus: response,
              attendees:
                e.attendees?.map((a) => (a.self ? { ...a, responseStatus: response } : a)) ?? null,
            }
          : e,
      ),
    );
  };

  return (
    <div className="flex-1 min-w-0 bg-white dark:bg-gray-800 flex flex-col overflow-hidden">
      {/* Date strip */}
      <div className="h-10 px-4 flex items-center justify-between border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Calendar</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}{" "}
            • next 30 days
          </span>
        </div>
        <button
          onClick={() => setRefreshTick((n) => n + 1)}
          disabled={loading}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50 transition-colors"
          title="Refresh calendar"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="px-4 py-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-900/40">
            {error}
          </div>
        )}

        {loading && events.length === 0 && !error && (
          <div className="px-4 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
            Loading events…
          </div>
        )}

        {!loading && events.length === 0 && !error && (
          <div className="px-4 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
            <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">
              No upcoming events
            </div>
            <div className="text-xs">
              {visibleCalendarCount !== null && visibleCalendarCount === 0
                ? "No calendars are visible. Toggle them in Settings → Calendar."
                : visibleCalendarCount !== null
                  ? `Showing ${visibleCalendarCount} calendar${visibleCalendarCount === 1 ? "" : "s"}. Adjust visibility in Settings → Calendar.`
                  : "Connect a Google account to see events here."}
            </div>
          </div>
        )}

        {grouped.map((group) => (
          <section key={group.key}>
            <div className="px-4 py-1.5 bg-gray-50 dark:bg-gray-900/40 border-y border-gray-100 dark:border-gray-800 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 sticky top-0 z-10">
              {formatDayHeader(group.date)}
              <span className="ml-2 text-gray-400 dark:text-gray-500 normal-case font-normal">
                {group.date.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
            <div>
              {group.events.map((event) => {
                const id = `${event.accountId}|${event.calendarId}|${event.id}`;
                return (
                  <EventRow
                    key={id}
                    event={event}
                    expanded={expandedId === id}
                    onToggle={() => setExpandedId((prev) => (prev === id ? null : id))}
                    onRespond={handleRespond}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
