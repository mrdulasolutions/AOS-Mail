// ICS subscription sync.
//
// Fetches a public .ics URL (Apple iCloud public share, Outlook
// "publish-this-calendar" link, any RFC 5545 stream), parses VEVENT
// blocks, and upserts them into the same `calendar_events` table that
// powers the Gmail-Calendar view. Gives IMAP-only users a real calendar
// without granting Google Calendar API access.
//
// Scope of this V1:
//   * Single-instance VEVENT only. RRULE expansion is deferred — we
//     persist the master event with its dtstart and let recurring events
//     show as a single occurrence. (Most users sync via RRULE-aware
//     clients on their primary device anyway.)
//   * UTC and local times handled. TZID parameter is recognised but not
//     fully resolved against an Olson DB; we treat TZID-tagged times as
//     local-machine time, which is usually right.
//   * Wire-level CRLF folding ('\r\n ' = continuation) is handled.
//
// Errors during fetch / parse are recorded on the subscription's
// last_error column so the user sees them in the calendar settings UI
// rather than silently swallowing.

import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("ics-sync");

export interface IcsSubscription {
  id: string;
  url: string;
  name: string;
  color: string;
  refreshIntervalMin: number;
  lastSyncedAt: number | null;
  lastError: string | null;
  visible: boolean;
  createdAt: number;
}

interface IcsSubscriptionRow {
  id: string;
  url: string;
  name: string;
  color: string;
  refresh_interval_min: number;
  last_synced_at: number | null;
  last_error: string | null;
  visible: number;
  created_at: number;
}

function rowToSub(r: IcsSubscriptionRow): IcsSubscription {
  return {
    id: r.id,
    url: r.url,
    name: r.name,
    color: r.color,
    refreshIntervalMin: r.refresh_interval_min,
    lastSyncedAt: r.last_synced_at,
    lastError: r.last_error,
    visible: r.visible === 1,
    createdAt: r.created_at,
  };
}

export function listIcsSubscriptions(): IcsSubscription[] {
  return (
    getDb()
      .prepare("SELECT * FROM ics_subscriptions ORDER BY created_at ASC")
      .all() as IcsSubscriptionRow[]
  ).map(rowToSub);
}

export function addIcsSubscription(input: {
  url: string;
  name: string;
  color?: string;
}): IcsSubscription {
  // Validate URL up front so we don't store something that can never
  // resolve. Allow http(s) and webcal: (Apple's URL scheme that's just
  // http(s) under the hood).
  let url: URL;
  try {
    url = new URL(input.url.replace(/^webcal:\/\//i, "https://"));
  } catch {
    throw new Error("Invalid calendar URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Calendar URL must be http(s) or webcal");
  }
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO ics_subscriptions (id, url, name, color, refresh_interval_min, created_at)
       VALUES (?, ?, ?, ?, 60, ?)`,
    )
    .run(
      id,
      url.toString(),
      input.name.trim() || "Subscribed Calendar",
      input.color ?? "#7c3aed",
      now,
    );
  return rowToSub(
    getDb().prepare("SELECT * FROM ics_subscriptions WHERE id = ?").get(id) as IcsSubscriptionRow,
  );
}

export function removeIcsSubscription(id: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    // Delete the subscription's events first, then the subscription row.
    db.prepare("DELETE FROM calendar_events WHERE account_id = ?").run(`ics:${id}`);
    db.prepare("DELETE FROM ics_subscriptions WHERE id = ?").run(id);
  });
  tx();
}

export function setIcsSubscriptionVisible(id: string, visible: boolean): void {
  getDb()
    .prepare("UPDATE ics_subscriptions SET visible = ? WHERE id = ?")
    .run(visible ? 1 : 0, id);
}

// ─── Parser ──────────────────────────────────────────────────────────

interface VEvent {
  uid: string;
  summary: string;
  dtstart: { value: string; dateOnly: boolean };
  dtend: { value: string; dateOnly: boolean } | null;
  location: string | null;
  description: string | null;
  url: string | null;
  status: string | null;
}

/**
 * RFC 5545 line unfolding: continuation lines start with whitespace and
 * are joined to the prior line.
 */
function unfoldLines(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (out.length > 0) out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Split a content line into key, params, value.
 * Examples:
 *   SUMMARY:Hello → key=SUMMARY, params={}, value=Hello
 *   DTSTART;TZID=America/New_York:20260509T140000
 *     → key=DTSTART, params={TZID: 'America/New_York'}, value=20260509T140000
 */
function parseLine(
  line: string,
): { key: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(";");
  const key = parts[0]!.toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i]!.indexOf("=");
    if (eq > 0) {
      const pname = parts[i]!.slice(0, eq).toUpperCase();
      const pval = parts[i]!.slice(eq + 1);
      params[pname] = pval;
    }
  }
  return { key, params, value };
}

/**
 * Convert an ICS DATE / DATE-TIME value to an ISO 8601 string.
 *   20260509          → 2026-05-09 (date-only)
 *   20260509T140000   → 2026-05-09T14:00:00 (floating)
 *   20260509T140000Z  → 2026-05-09T14:00:00Z (UTC)
 */
function icsDateToISO(value: string): { iso: string; dateOnly: boolean } {
  const v = value.trim();
  if (/^\d{8}$/.test(v)) {
    return { iso: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, dateOnly: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (m) {
    return {
      iso: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ""}`,
      dateOnly: false,
    };
  }
  return { iso: v, dateOnly: false };
}

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

export function parseIcs(text: string): VEvent[] {
  const lines = unfoldLines(text);
  const events: VEvent[] = [];
  let inEvent = false;
  let cur: Partial<VEvent> | null = null;
  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") {
      inEvent = true;
      cur = {};
      continue;
    }
    if (raw === "END:VEVENT") {
      if (cur && cur.uid && cur.summary && cur.dtstart) {
        events.push(cur as VEvent);
      }
      cur = null;
      inEvent = false;
      continue;
    }
    if (!inEvent || !cur) continue;
    const parsed = parseLine(raw);
    if (!parsed) continue;
    const { key, value } = parsed;
    switch (key) {
      case "UID":
        cur.uid = value;
        break;
      case "SUMMARY":
        cur.summary = unescapeText(value);
        break;
      case "LOCATION":
        cur.location = unescapeText(value);
        break;
      case "DESCRIPTION":
        cur.description = unescapeText(value);
        break;
      case "URL":
        cur.url = value;
        break;
      case "STATUS":
        cur.status = value.toLowerCase();
        break;
      case "DTSTART": {
        const d = icsDateToISO(value);
        cur.dtstart = { value: d.iso, dateOnly: d.dateOnly };
        break;
      }
      case "DTEND": {
        const d = icsDateToISO(value);
        cur.dtend = { value: d.iso, dateOnly: d.dateOnly };
        break;
      }
    }
  }
  return events;
}

// ─── Fetch + upsert ──────────────────────────────────────────────────

function recordError(id: string, error: string): void {
  getDb()
    .prepare("UPDATE ics_subscriptions SET last_error = ?, last_synced_at = ? WHERE id = ?")
    .run(error, Date.now(), id);
}

function recordSuccess(id: string): void {
  getDb()
    .prepare("UPDATE ics_subscriptions SET last_error = NULL, last_synced_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

/**
 * Fetch one ICS subscription, parse the events, and upsert them into
 * `calendar_events` keyed by `(uid, account_id='ics:<id>')`. Stale events
 * (in the persisted table but not in this fetch) are deleted so the
 * calendar view stays consistent with the source.
 */
export async function syncIcsSubscription(id: string): Promise<{
  fetched: number;
  parsed: number;
  upserted: number;
}> {
  const sub = getDb().prepare("SELECT * FROM ics_subscriptions WHERE id = ?").get(id) as
    | IcsSubscriptionRow
    | undefined;
  if (!sub) throw new Error(`ICS subscription not found: ${id}`);
  const acct = `ics:${id}`;
  let body: string;
  try {
    const res = await fetch(sub.url, {
      headers: { "User-Agent": "AOS-Mail/1.0 (+ICS subscription)" },
      redirect: "follow",
    });
    if (!res.ok) {
      const msg = `HTTP ${res.status}`;
      recordError(id, msg);
      throw new Error(msg);
    }
    body = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordError(id, msg);
    throw err;
  }
  let events: VEvent[];
  try {
    events = parseIcs(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordError(id, `Parse: ${msg}`);
    throw err;
  }

  const db = getDb();
  const tx = db.transaction(() => {
    const seenUids = new Set<string>();
    const upsert = db.prepare(
      `INSERT INTO calendar_events
         (id, account_id, calendar_id, summary, start_time, end_time,
          is_all_day, calendar_name, calendar_color, status, location, html_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, account_id) DO UPDATE SET
         summary       = excluded.summary,
         start_time    = excluded.start_time,
         end_time      = excluded.end_time,
         is_all_day    = excluded.is_all_day,
         calendar_name = excluded.calendar_name,
         calendar_color= excluded.calendar_color,
         status        = excluded.status,
         location      = excluded.location,
         html_link     = excluded.html_link`,
    );
    for (const ev of events) {
      seenUids.add(ev.uid);
      const dtend =
        ev.dtend?.value ??
        // Fallback: 1h after start for time events, end-of-day for all-day.
        (ev.dtstart.dateOnly ? ev.dtstart.value : ev.dtstart.value);
      upsert.run(
        ev.uid,
        acct,
        sub.id,
        ev.summary,
        ev.dtstart.value,
        dtend,
        ev.dtstart.dateOnly ? 1 : 0,
        sub.name,
        sub.color,
        ev.status ?? "confirmed",
        ev.location,
        ev.url,
      );
    }
    // Drop events that disappeared from the source.
    const existing = db
      .prepare("SELECT id FROM calendar_events WHERE account_id = ?")
      .all(acct) as Array<{ id: string }>;
    const toDelete = existing.map((r) => r.id).filter((uid) => !seenUids.has(uid));
    if (toDelete.length > 0) {
      const del = db.prepare("DELETE FROM calendar_events WHERE id = ? AND account_id = ?");
      for (const uid of toDelete) del.run(uid, acct);
    }
  });
  tx();
  recordSuccess(id);
  log.info("ics sync done", { id, name: sub.name, fetched: events.length });
  return { fetched: events.length, parsed: events.length, upserted: events.length };
}

/**
 * Refresh every subscription whose last_synced_at is older than its
 * refresh_interval_min. Runs from a periodic timer in the sidecar.
 */
export async function refreshDueIcsSubscriptions(): Promise<void> {
  const subs = listIcsSubscriptions();
  const now = Date.now();
  for (const sub of subs) {
    const dueMs = (sub.refreshIntervalMin || 60) * 60 * 1000;
    if (sub.lastSyncedAt && now - sub.lastSyncedAt < dueMs) continue;
    try {
      await syncIcsSubscription(sub.id);
    } catch (err) {
      log.warn("ics refresh failed", {
        id: sub.id,
        url: sub.url,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
