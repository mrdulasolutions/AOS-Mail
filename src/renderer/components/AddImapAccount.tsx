// Stand-alone "Add IMAP / SMTP account" flow.
//
// Used both from the SetupWizard's first step (as an alternative to
// Gmail OAuth) and — eventually — from Settings → Accounts. Self-contained
// so neither caller needs to track step state.
//
// Flow:
//   1. User types their email. We suggest a preset (iCloud, Fastmail, ...)
//      based on the domain. They can keep it or switch to "Custom server".
//   2. User enters their password (or app-specific password where the
//      provider requires one — the form surfaces a help link).
//   3. We send the credentials to the sidecar's imap.addAccount, which
//      tests the connection and only persists if it works.
//
// Security note: passwords land in the JSON file at
// <dataDir>/imap-creds-<email>.json — same risk model as the existing
// Gmail OAuth tokens. Production should escalate to OS Keychain.

import { useEffect, useMemo, useState } from "react";
import type { IpcResponse } from "../../shared/types";

interface ImapPreset {
  id: string;
  label: string;
  hint: string;
  domains?: string[];
  imap: { host: string; port: number; tls: true };
  smtp: { host: string; port: number; tls: true };
  appPasswordRequired?: boolean;
  appPasswordHelp?: string;
}

interface AddImapAccountProps {
  onComplete: (account: { accountId: string; email: string }) => void;
  onCancel: () => void;
}

const CUSTOM_PRESET_ID = "__custom__";

export function AddImapAccount({ onComplete, onCancel }: AddImapAccountProps) {
  const [presets, setPresets] = useState<ImapPreset[]>([]);
  const [presetId, setPresetId] = useState<string>(CUSTOM_PRESET_ID);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [tls, setTls] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authFailure, setAuthFailure] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Load presets on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = (await window.api.imap.presets()) as IpcResponse<{
        presets: ImapPreset[];
      }>;
      if (cancelled || !result.success) return;
      setPresets(result.data.presets);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-suggest a preset based on the email domain
  useEffect(() => {
    if (!email.includes("@")) return;
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    const match = presets.find((p) => p.domains?.includes(domain));
    if (match && presetId === CUSTOM_PRESET_ID) {
      setPresetId(match.id);
    }
  }, [email, presets, presetId]);

  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === presetId) ?? null,
    [presets, presetId],
  );

  // Apply preset → host/port fields
  useEffect(() => {
    if (!selectedPreset) return;
    setImapHost(selectedPreset.imap.host);
    setImapPort(selectedPreset.imap.port);
    setSmtpHost(selectedPreset.smtp.host);
    setSmtpPort(selectedPreset.smtp.port);
    setTls(true);
  }, [selectedPreset]);

  const isCustom = presetId === CUSTOM_PRESET_ID;
  const requiresAppPassword = !!selectedPreset?.appPasswordRequired;

  const canSubmit =
    email.trim().includes("@") &&
    password.trim().length > 0 &&
    imapHost.trim().length > 0 &&
    smtpHost.trim().length > 0 &&
    !isLoading;

  const handleSubmit = async () => {
    setIsLoading(true);
    setError(null);
    setAuthFailure(false);
    try {
      const input = {
        email: email.trim(),
        password: password,
        displayName: displayName.trim() || undefined,
        imapHost: imapHost.trim(),
        imapPort,
        imapUsername: email.trim(),
        smtpHost: smtpHost.trim(),
        smtpPort,
        tls,
      };
      const result = (await window.api.imap.addAccount(input)) as IpcResponse<{
        accountId: string;
        email: string;
      }>;
      if (!result.success) {
        setError(result.error ?? "Failed to add IMAP account");
        if (
          /(?:auth|login|password|denied|invalid credentials)/i.test(result.error ?? "")
        ) {
          setAuthFailure(true);
        }
        return;
      }
      onComplete({ accountId: result.data.accountId, email: result.data.email });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add IMAP account");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-2xl font-semibold text-aos-text tracking-tight">
          Add IMAP account
        </h2>
        <button onClick={onCancel} className="aos-btn-quiet" type="button">
          Back
        </button>
      </div>
      <p className="text-aos-text-soft mb-6 leading-relaxed">
        Connect iCloud, Fastmail, Yahoo, Outlook, AOL, or any IMAP-compatible mailbox.
        Most providers require an app-specific password — we'll surface a link to the
        right setup page when you pick one.
      </p>

      {/* Provider preset picker */}
      <label className="block text-sm font-medium text-aos-text mb-1.5">
        Provider
      </label>
      <select
        value={presetId}
        onChange={(e) => setPresetId(e.target.value)}
        className="aos-input mb-4 cursor-pointer"
      >
        <option value={CUSTOM_PRESET_ID}>Custom IMAP server</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      {selectedPreset?.hint && (
        <p className="text-xs text-aos-text-muted -mt-2 mb-4">{selectedPreset.hint}</p>
      )}

      {/* Email + display name */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-aos-text mb-1.5">
            Email address
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="aos-input"
            autoComplete="email"
            spellCheck="false"
            autoCapitalize="off"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-aos-text mb-1.5">
            Display name <span className="text-aos-text-faint">(optional)</span>
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Casey Doe"
            className="aos-input"
            autoComplete="name"
          />
        </div>
      </div>

      {/* Password */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-aos-text mb-1.5">
          {requiresAppPassword ? "App-specific password" : "Password"}
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && canSubmit && void handleSubmit()}
          placeholder={requiresAppPassword ? "abcd-efgh-ijkl-mnop" : "Password"}
          className="aos-input"
          autoComplete="current-password"
        />
        {requiresAppPassword && selectedPreset?.appPasswordHelp && (
          <p className="mt-1.5 text-xs text-aos-text-muted">
            {selectedPreset.label} requires an app-specific password.{" "}
            <a
              href={selectedPreset.appPasswordHelp}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:no-underline text-aos-text"
            >
              How to create one ↗
            </a>
          </p>
        )}
      </div>

      {/* Advanced — server + port + TLS */}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="text-xs text-aos-text-muted hover:text-aos-text transition-colors mb-3"
      >
        {showAdvanced ? "▾" : "▸"} Server settings{" "}
        <span className="text-aos-text-faint">
          ({isCustom ? "required" : "auto-filled — change if needed"})
        </span>
      </button>

      {(showAdvanced || isCustom) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4 p-4 rounded-aos border border-aos-line bg-aos-bg-soft">
          <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-aos-text-soft mb-1">
                IMAP host
              </label>
              <input
                type="text"
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                placeholder="imap.example.com"
                className="aos-input"
                spellCheck="false"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-aos-text-soft mb-1">
                IMAP port
              </label>
              <input
                type="number"
                value={imapPort}
                onChange={(e) => setImapPort(Number(e.target.value))}
                className="aos-input"
              />
            </div>
          </div>

          <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-aos-text-soft mb-1">
                SMTP host
              </label>
              <input
                type="text"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.example.com"
                className="aos-input"
                spellCheck="false"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-aos-text-soft mb-1">
                SMTP port
              </label>
              <input
                type="number"
                value={smtpPort}
                onChange={(e) => setSmtpPort(Number(e.target.value))}
                className="aos-input"
              />
            </div>
          </div>

          <label className="sm:col-span-2 flex items-center gap-2 text-sm text-aos-text-soft cursor-pointer select-none">
            <input
              type="checkbox"
              checked={tls}
              onChange={(e) => setTls(e.target.checked)}
              className="rounded border-aos-line-strong text-aos-text focus:ring-aos-text"
            />
            Use TLS / SSL
          </label>
        </div>
      )}

      {error && (
        <div className="aos-callout-danger mb-4 text-sm">
          {authFailure
            ? "The mail server rejected those credentials. If your provider requires an app-specific password, use that instead of your normal one."
            : error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          className="aos-btn-primary flex-1 py-3"
        >
          {isLoading ? (
            <span className="inline-flex items-center gap-2">
              <span
                className="aos-spinner"
                style={{ width: 14, height: 14, borderColor: "rgba(255,255,255,0.3)", borderTopColor: "white" }}
              />
              Connecting…
            </span>
          ) : (
            "Test &amp; add account"
          )}
        </button>
      </div>
    </>
  );
}
