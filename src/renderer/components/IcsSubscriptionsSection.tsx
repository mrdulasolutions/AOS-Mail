// "Subscribe to a calendar URL" UI inside Settings → Calendar.
//
// Why this exists: provides a calendar story for IMAP-only users (no
// Google Calendar API access) and for users who want to layer external
// calendars (a partner's public schedule, a sports team, a public
// conference's events feed) onto their main view.
//
// The sidecar's `calendar.addIcsSubscription` validates the URL, persists
// it, and immediately fetches+parses the .ics body. New events land in
// the same `calendar_events` table that powers the existing CalendarView,
// so the user sees them in the day view without any further UI plumbing.
//
// Recommended URL forms:
//   * Apple iCloud "Public Calendar":
//       webcal://p<N>-caldav.icloud.com/published/<token>  (we rewrite to https)
//   * Outlook "Publish a calendar to the web" → ICS link
//   * Google Calendar → Settings → Integrate calendar → "Secret address in
//     iCal format"
//   * Anything else that returns RFC 5545 text/calendar over HTTP(S)

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bridge } from "../lib/bridge";
import type { IcsSubscription } from "../../shared/sidecar-contract";

const PRESET_COLORS = ["#7c3aed", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899"];

export function IcsSubscriptionsSection() {
  const queryClient = useQueryClient();
  const { data: subs = [] } = useQuery<IcsSubscription[]>({
    queryKey: ["ics-subscriptions"],
    queryFn: () => bridge.call("calendar.listIcsSubscriptions", undefined),
    refetchInterval: 60_000, // refresh status indicators
  });

  const [showAddForm, setShowAddForm] = useState(false);

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Subscribed calendars
        </h2>
        {!showAddForm && (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            + Subscribe to URL
          </button>
        )}
      </div>
      <p className="text-gray-600 dark:text-gray-400 text-sm mb-4">
        Paste an iCal URL — works for Apple iCloud public shares, Outlook published calendars,
        Google Calendar's secret iCal address, and any RFC 5545 stream. Useful for IMAP-only
        accounts that don't have Google Calendar attached.
      </p>

      {showAddForm && (
        <AddIcsForm
          onAdded={() => {
            setShowAddForm(false);
            void queryClient.invalidateQueries({ queryKey: ["ics-subscriptions"] });
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {subs.length === 0 && !showAddForm ? (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-600 text-center text-gray-500 dark:text-gray-400">
          No subscribed calendars yet.
        </div>
      ) : subs.length > 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600 divide-y divide-gray-200 dark:divide-gray-700 mt-3">
          {subs.map((sub) => (
            <IcsRow
              key={sub.id}
              sub={sub}
              onChanged={() => queryClient.invalidateQueries({ queryKey: ["ics-subscriptions"] })}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AddIcsForm({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[0]!);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!url.trim() || !name.trim()) {
      setError("URL and name are required.");
      return;
    }
    setSubmitting(true);
    try {
      await bridge.call("calendar.addIcsSubscription", {
        url: url.trim(),
        name: name.trim(),
        color,
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600 p-4 mb-3 space-y-3">
      <div>
        <label className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1 block">
          Calendar URL
        </label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… or webcal://…"
          autoFocus
          className="w-full px-3 py-2 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:border-blue-500"
        />
      </div>
      <div>
        <label className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1 block">
          Display name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My iCloud Calendar"
          className="w-full px-3 py-2 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:border-blue-500"
        />
      </div>
      <div>
        <label className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1 block">
          Color
        </label>
        <div className="flex items-center gap-2">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`w-6 h-6 rounded-full transition-transform ${
                color === c ? "ring-2 ring-offset-2 ring-blue-500 scale-110" : ""
              }`}
              style={{ backgroundColor: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm px-3 py-1.5 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className="text-sm px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
        >
          {submitting ? "Subscribing…" : "Subscribe"}
        </button>
      </div>
    </div>
  );
}

function IcsRow({ sub, onChanged }: { sub: IcsSubscription; onChanged: () => void }) {
  const [busy, setBusy] = useState<"refresh" | "remove" | null>(null);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  const refresh = async () => {
    setBusy("refresh");
    try {
      await bridge.call("calendar.refreshIcsSubscription", { id: sub.id });
      onChanged();
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("remove");
    try {
      await bridge.call("calendar.removeIcsSubscription", { id: sub.id });
      onChanged();
    } finally {
      setBusy(null);
      setShowRemoveConfirm(false);
    }
  };
  const toggleVisible = async () => {
    await bridge.call("calendar.setIcsVisibility", { id: sub.id, visible: !sub.visible });
    onChanged();
  };

  // Dismiss the inline confirm if the user clicks anywhere else
  useEffect(() => {
    if (!showRemoveConfirm) return;
    const onClick = () => setShowRemoveConfirm(false);
    const t = setTimeout(() => window.addEventListener("click", onClick, { once: true }), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", onClick);
    };
  }, [showRemoveConfirm]);

  return (
    <div className="p-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div
          className="w-3 h-3 rounded-full flex-shrink-0"
          style={{ backgroundColor: sub.color }}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {sub.name}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate" title={sub.url}>
            {sub.url}
          </div>
          {sub.lastError ? (
            <div className="text-xs text-red-600 dark:text-red-400 mt-0.5" title={sub.lastError}>
              Last sync failed: {sub.lastError}
            </div>
          ) : sub.lastSyncedAt ? (
            <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              Last synced {new Date(sub.lastSyncedAt).toLocaleString()}
            </div>
          ) : (
            <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Not yet synced</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={toggleVisible}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            sub.visible ? "bg-blue-600 dark:bg-blue-500" : "bg-gray-200 dark:bg-gray-700"
          }`}
          aria-label={sub.visible ? "Hide" : "Show"}
          title={sub.visible ? "Hide events from this calendar" : "Show events from this calendar"}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              sub.visible ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy !== null}
          className="text-xs px-2 py-1 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-50"
          title="Refresh now"
        >
          {busy === "refresh" ? "…" : "Refresh"}
        </button>
        {showRemoveConfirm ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void remove();
            }}
            disabled={busy !== null}
            className="text-xs px-2 py-1 bg-red-600 hover:bg-red-500 text-white rounded disabled:opacity-50"
          >
            {busy === "remove" ? "…" : "Confirm"}
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowRemoveConfirm(true);
            }}
            className="text-xs px-2 py-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
