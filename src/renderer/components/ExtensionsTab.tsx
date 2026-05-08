// Settings → Extensions tab.
//
// V1 only ships bundled extensions; nothing installs at runtime. The tab
// surfaces:
//   - The bundled list, each with name + description + an on/off toggle.
//     Toggling persists to preferences.json under
//       extensions: { "<id>": { enabled: boolean } }
//     and updates the in-renderer host so panels appear/disappear immediately.
//   - The OpenClaw agent provider config (kept from the legacy tab — it's
//     unrelated to the V1 framework but lives in the same Settings tab).
//
// The sprawling V2 plumbing that previously lived here (install/uninstall,
// agent-provider settings, health-check polling) is gone. Reintroduce when
// V2 ships.

import { useState, useEffect, useCallback } from "react";
import { setExtensionEnabled } from "../extensions/host";
import type { ExtensionManifestSummary } from "../../shared/sidecar-contract";

export function ExtensionsTab() {
  const [bundled, setBundled] = useState<ExtensionManifestSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadExtensions = useCallback(async () => {
    setError(null);
    try {
      const result = await window.api.extensions.list();
      if (result.success && Array.isArray(result.data)) {
        setBundled(result.data);
      } else if (!result.success) {
        setError(result.error ?? "Failed to load extensions");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load extensions");
    }
  }, []);

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  const handleToggle = async (id: string, nextEnabled: boolean) => {
    setBusyId(id);
    setError(null);
    // Optimistic — flip the local state immediately so the toggle feels
    // responsive. Roll back if the persistence call fails.
    setBundled((prev) => prev.map((m) => (m.id === id ? { ...m, enabled: nextEnabled } : m)));
    setExtensionEnabled(id, nextEnabled);
    try {
      const result = (await window.api.extensions.setEnabled(id, nextEnabled)) ?? {
        success: false,
        error: "no setEnabled response",
      };
      if (!result.success) {
        // Roll back optimistic update.
        setBundled((prev) => prev.map((m) => (m.id === id ? { ...m, enabled: !nextEnabled } : m)));
        setExtensionEnabled(id, !nextEnabled);
        setError(result.error ?? "Failed to save extension state");
      }
    } catch (err) {
      setBundled((prev) => prev.map((m) => (m.id === id ? { ...m, enabled: !nextEnabled } : m)));
      setExtensionEnabled(id, !nextEnabled);
      setError(err instanceof Error ? err.message : "Failed to save extension state");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Extensions</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Bundled extensions that add panels and intelligence to AOS Mail. Toggle each one on or
          off; changes take effect immediately.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {bundled.map((ext) => (
          <ExtensionCard
            key={ext.id}
            ext={ext}
            busy={busyId === ext.id}
            onToggle={(next) => handleToggle(ext.id, next)}
          />
        ))}
        {bundled.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">Loading…</p>
        )}
      </div>

      <OpenClawSection />
    </div>
  );
}

function ExtensionCard({
  ext,
  busy,
  onToggle,
}: {
  ext: ExtensionManifestSummary;
  busy: boolean;
  onToggle: (nextEnabled: boolean) => void;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">{ext.name}</h4>
            <span className="text-xs text-gray-400 dark:text-gray-500">v{ext.version}</span>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
              Built-in
            </span>
            {ext.enabled ? (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                Active
              </span>
            ) : (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                Disabled
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{ext.description}</p>
          {ext.panels.length > 0 && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              Panels: {ext.panels.map((p) => `${p.title} (${p.scope})`).join(", ")}
            </p>
          )}
        </div>
        <label className="relative inline-flex items-center cursor-pointer mt-1 shrink-0">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={ext.enabled}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:after:border-gray-600 peer-checked:bg-blue-600 peer-disabled:opacity-50" />
        </label>
      </div>
    </div>
  );
}

// ── OpenClaw section (carried over from the legacy tab) ─────────────────
//
// Kept verbatim except for moving it into its own component to keep the
// main render readable. Same wiring: writes the openclaw config via
// window.api.settings.set and pings the optional gateway via
// settings.testOpenclawConnection. Independent of the V1 extensions
// framework.

function OpenClawSection() {
  const [openclawEnabled, setOpenclawEnabled] = useState(false);
  const [openclawGatewayUrl, setOpenclawGatewayUrl] = useState("");
  const [openclawGatewayToken, setOpenclawGatewayToken] = useState("");
  const [openclawTestResult, setOpenclawTestResult] = useState<{
    success: boolean;
    error?: string;
  } | null>(null);
  const [openclawTesting, setOpenclawTesting] = useState(false);

  useEffect(() => {
    (async () => {
      const result = await window.api.settings.get();
      const config = result.success && result.data ? result.data : {};
      const oc = config.openclaw as Record<string, unknown> | undefined;
      if (oc) {
        setOpenclawEnabled(Boolean(oc.enabled));
        setOpenclawGatewayUrl(String(oc.gatewayUrl ?? ""));
        setOpenclawGatewayToken(String(oc.gatewayToken ?? ""));
      }
    })();
  }, []);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600 p-6">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="text-base font-medium text-gray-900 dark:text-gray-100">OpenClaw Agent</h4>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Connect a local or remote OpenClaw agent for richer context during email drafting.
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={openclawEnabled}
            onChange={async (e) => {
              const val = e.target.checked;
              setOpenclawEnabled(val);
              await window.api.settings.set({
                openclaw: {
                  enabled: val,
                  gatewayUrl: openclawGatewayUrl,
                  gatewayToken: openclawGatewayToken,
                },
              });
            }}
          />
          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:after:border-gray-600 peer-checked:bg-blue-600" />
        </label>
      </div>

      {openclawEnabled && (
        <div className="space-y-3 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Gateway URL{" "}
              <span className="text-gray-400 font-normal">(optional — blank = local)</span>
            </label>
            <input
              type="text"
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400"
              placeholder="ws://192.168.1.50:18789"
              value={openclawGatewayUrl}
              onChange={(e) => setOpenclawGatewayUrl(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Gateway Token <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="password"
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400"
              placeholder="Bearer token"
              value={openclawGatewayToken}
              onChange={(e) => setOpenclawGatewayToken(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 dark:bg-blue-500 rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 transition-colors"
              disabled={openclawTesting}
              onClick={async () => {
                await window.api.settings.set({
                  openclaw: {
                    enabled: openclawEnabled,
                    gatewayUrl: openclawGatewayUrl,
                    gatewayToken: openclawGatewayToken,
                  },
                });
                setOpenclawTesting(true);
                setOpenclawTestResult(null);
                const result = await window.api.settings.testOpenclawConnection();
                setOpenclawTestResult(result);
                setOpenclawTesting(false);
              }}
            >
              {openclawTesting ? "Testing..." : "Test Connection"}
            </button>

            <button
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 dark:bg-blue-500 rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors"
              onClick={async () => {
                await window.api.settings.set({
                  openclaw: {
                    enabled: openclawEnabled,
                    gatewayUrl: openclawGatewayUrl,
                    gatewayToken: openclawGatewayToken,
                  },
                });
              }}
            >
              Save
            </button>

            {openclawTestResult && (
              <span
                className={`text-sm ${openclawTestResult.success ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              >
                {openclawTestResult.success
                  ? "✓ Connected"
                  : (openclawTestResult.error ?? "Connection failed")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
