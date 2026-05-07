import { useState, useEffect, useCallback } from "react";
import type { IpcResponse } from "../../shared/types";
import { reconfigurePostHog } from "../services/posthog";
import { AddImapAccount } from "./AddImapAccount";

interface SetupWizardProps {
  onComplete: () => void;
}

type Step =
  | "loading"
  | "credentials"
  | "apikey"
  | "oauth"
  | "extensions"
  | "analytics"
  | "imap";

interface ExtensionAuthInfo {
  extensionId: string;
  displayName: string;
  needsAuth: boolean;
  authType: "extension" | "agent";
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>("loading");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Track which steps are in the flow (determined at init)
  const [visibleSteps, setVisibleSteps] = useState<Step[]>([]);

  // Google OAuth credentials input
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");

  // API key input
  const [apiKey, setApiKey] = useState("");

  // Extension auth state
  const [extensionAuths, setExtensionAuths] = useState<ExtensionAuthInfo[]>([]);
  const [authenticatingExtension, setAuthenticatingExtension] = useState<string | null>(null);

  // Analytics opt-in (default ON — session replay is bundled under analytics)
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);

  // Check what's already configured and skip to the right step.
  useEffect(() => {
    (
      window.api.gmail.checkAuth() as Promise<
        IpcResponse<{ hasCredentials: boolean; hasTokens: boolean; hasAnthropicKey: boolean }>
      >
    )
      .then((authResult) => {
        if (authResult.success) {
          const { hasCredentials, hasAnthropicKey, hasTokens } = authResult.data;

          const flow: Step[] = [];
          if (!hasCredentials) flow.push("credentials");
          if (!hasAnthropicKey) flow.push("apikey");
          if (!hasTokens) flow.push("oauth");
          flow.push("extensions");
          flow.push("analytics");
          setVisibleSteps(flow);

          if (!hasCredentials) {
            setStep("credentials");
          } else if (!hasAnthropicKey) {
            setStep("apikey");
          } else if (!hasTokens) {
            setStep("oauth");
          } else {
            enterExtensionsStep();
          }
        } else {
          setVisibleSteps(["credentials", "apikey", "oauth", "extensions", "analytics"]);
          setStep("credentials");
        }
      })
      .catch(() => {
        setVisibleSteps(["credentials", "apikey", "oauth", "extensions", "analytics"]);
        setStep("credentials");
      });
  }, []);

  const handleSaveCredentials = async () => {
    if (!googleClientId.trim() || !googleClientSecret.trim()) {
      setError("Both Client ID and Client Secret are required");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = (await window.api.gmail.saveCredentials(
        googleClientId.trim(),
        googleClientSecret.trim(),
      )) as IpcResponse<void>;
      if (result.success) {
        const credIdx = visibleSteps.indexOf("credentials");
        const next = visibleSteps[credIdx + 1];
        if (next) {
          setStep(next);
        } else {
          setStep("apikey");
        }
      } else {
        setError(result.error ?? "Failed to save credentials");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) {
      setError("Please enter your Anthropic API key");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Validate the key with a real API call before saving
      const validation = (await window.api.settings.validateApiKey(
        apiKey.trim(),
      )) as IpcResponse<void>;
      if (!validation.success) {
        setError(validation.error ?? "Invalid API key");
        return;
      }

      const result = (await window.api.settings.set({
        anthropicApiKey: apiKey.trim(),
      })) as IpcResponse<void>;
      if (result.success) {
        const authResult = (await window.api.gmail.checkAuth()) as IpcResponse<{
          hasCredentials: boolean;
          hasTokens: boolean;
          hasAnthropicKey: boolean;
        }>;
        if (authResult.success && authResult.data.hasTokens) {
          await enterExtensionsStep();
        } else {
          setStep("oauth");
        }
      } else {
        setError(result.error ?? "Failed to save API key");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartOAuth = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await window.api.gmail.startOAuth();
      if (result.success) {
        await enterExtensionsStep();
      } else {
        if (result.error === "Authorization cancelled") {
          // User cancelled — don't show as an error, just reset
          setIsLoading(false);
          return;
        }
        setError(result.error);
        setIsLoading(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Authorization failed. Please try again.";
      if (msg === "Authorization cancelled") {
        setIsLoading(false);
        return;
      }
      setError(msg);
      setIsLoading(false);
    }
  };

  const handleCancelOAuth = async () => {
    await window.api.gmail.cancelOAuth();
    setIsLoading(false);
  };

  const enterExtensionsStep = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = (await window.api.extensions.getPendingAuths()) as IpcResponse<
        ExtensionAuthInfo[]
      >;
      if (result.success && result.data.length > 0 && result.data.some((ext) => ext.needsAuth)) {
        setExtensionAuths(result.data.filter((ext) => ext.needsAuth));
        setStep("extensions");
        setIsLoading(false);
      } else {
        // No extensions need auth (or IPC failed) — skip extensions step entirely
        if (!result.success) {
          console.error("[SetupWizard] getPendingAuths failed:", result.error);
        }
        setVisibleSteps((prev) => prev.filter((s) => s !== "extensions"));
        setIsLoading(false);
        setStep("analytics");
      }
    } catch (err) {
      console.error("[SetupWizard] getPendingAuths failed:", err);
      setVisibleSteps((prev) => prev.filter((s) => s !== "extensions"));
      setIsLoading(false);
      setStep("analytics");
    }
  }, []);

  const handleExtensionAuth = async (extensionId: string, authType: "extension" | "agent") => {
    setAuthenticatingExtension(extensionId);
    setError(null);

    try {
      let success = false;
      if (authType === "agent") {
        const result = (await window.api.agent.authenticate(extensionId)) as IpcResponse<{
          success: boolean;
        }>;
        if (result.success) {
          success = result.data.success;
        }
        if (!success) {
          setError(
            !result.success
              ? (result.error ?? "Authentication failed")
              : "Authentication failed or was cancelled",
          );
        }
      } else {
        const result = (await window.api.extensions.authenticate(extensionId)) as IpcResponse<void>;
        success = result.success;
        if (!result.success) {
          setError(result.error ?? "Authentication failed");
        }
      }

      if (success) {
        setExtensionAuths((prev) =>
          prev.map((ext) => (ext.extensionId === extensionId ? { ...ext, needsAuth: false } : ext)),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setAuthenticatingExtension(null);
    }
  };

  // Step indicator — only show steps the user will actually visit
  const currentStepIndex = visibleSteps.indexOf(step);

  return (
    <div className="h-screen flex flex-col bg-aos-bg-soft">
      {/* Titlebar */}
      <div className="titlebar-drag h-12 bg-white border-b border-aos-line flex items-center px-4">
        <div className="w-20" /> {/* Space for traffic lights */}
        <h1 className="text-lg font-semibold text-aos-text">AOS Mail Setup</h1>
        <div className="ml-auto titlebar-no-drag">
          <button
            type="button"
            onClick={onComplete}
            className="text-xs px-3 py-1 rounded-md text-aos-text-muted hover:text-aos-text hover:bg-aos-bg-soft border border-transparent hover:border-aos-line transition-colors"
            aria-label="Skip setup and use AOS Mail without an account"
            title="Skip setup — you can finish later from Settings"
          >
            Skip for now
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center px-8 py-12 overflow-auto">
        <div className="max-w-xl w-full aos-card aos-fade-in p-10">
          {step === "loading" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="aos-spinner aos-spinner-lg" />
              <p className="text-sm text-aos-text-muted">Checking your setup…</p>
            </div>
          )}

          {step === "imap" && (
            <AddImapAccount
              onCancel={() => setStep("credentials")}
              onComplete={() => onComplete()}
            />
          )}

          {step === "credentials" && (
            <>
              <h2 className="text-2xl font-semibold text-aos-text mb-2 tracking-tight">
                Google Cloud credentials
              </h2>
              <p className="text-aos-text-soft mb-6 leading-relaxed">
                AOS Mail needs Google OAuth credentials to access your Gmail. Create a Google
                Cloud project with the Gmail API enabled, then paste the keys below.
              </p>

              {/* Alternative path — IMAP for non-Gmail providers. */}
              <div className="aos-callout-info mb-6 flex items-center justify-between">
                <span className="text-sm">
                  Not using Gmail? Connect iCloud, Fastmail, Yahoo, Outlook, or any IMAP server
                  instead.
                </span>
                <button
                  type="button"
                  onClick={() => setStep("imap")}
                  className="aos-btn-secondary text-sm py-1.5 px-3 flex-shrink-0 ml-3"
                >
                  Use IMAP
                </button>
              </div>

              <div className="aos-callout-info mb-6">
                <h3 className="font-semibold mb-2">Setup steps</h3>
                <ol className="text-sm space-y-1.5 list-decimal list-inside marker:text-aos-text-muted">
                  <li>
                    Open the{" "}
                    <a
                      href="https://console.cloud.google.com/apis/credentials"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 hover:no-underline"
                    >
                      Google Cloud Console
                    </a>
                  </li>
                  <li>Create a project (or select an existing one)</li>
                  <li>
                    Enable the <strong>Gmail API</strong> and <strong>Google Calendar API</strong>
                  </li>
                  <li>Credentials → Create Credentials → OAuth client ID</li>
                  <li>
                    Choose <strong>Desktop app</strong> as the application type
                  </li>
                  <li>Copy the Client ID and Client Secret below</li>
                </ol>
              </div>

              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-sm font-medium text-aos-text mb-1.5">
                    Client ID
                  </label>
                  <input
                    type="text"
                    value={googleClientId}
                    onChange={(e) => setGoogleClientId(e.target.value)}
                    placeholder="your-client-id.apps.googleusercontent.com"
                    className="aos-input"
                    autoComplete="off"
                    spellCheck="false"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-aos-text mb-1.5">
                    Client Secret
                  </label>
                  <input
                    type="password"
                    value={googleClientSecret}
                    onChange={(e) => setGoogleClientSecret(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !isLoading && handleSaveCredentials()}
                    placeholder="GOCSPX-…"
                    className="aos-input"
                    autoComplete="off"
                  />
                </div>
              </div>

              {error && <div className="aos-callout-danger mb-4 text-sm">{error}</div>}

              <button
                onClick={handleSaveCredentials}
                disabled={isLoading || !googleClientId.trim() || !googleClientSecret.trim()}
                className="aos-btn-primary w-full py-3"
              >
                {isLoading ? "Saving…" : "Continue"}
              </button>
            </>
          )}

          {step === "apikey" && (
            <>
              <h2 className="text-2xl font-semibold text-aos-text mb-2 tracking-tight">
                Anthropic API key
              </h2>
              <p className="text-aos-text-soft mb-6 leading-relaxed">
                Claude powers triage, drafts, and sender lookups. Paste an Anthropic API key to
                turn those features on.
              </p>

              <div className="aos-callout-info mb-6">
                <h3 className="font-semibold mb-2">Get your API key</h3>
                <ol className="text-sm space-y-1.5 list-decimal list-inside marker:text-aos-text-muted">
                  <li>
                    Open{" "}
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 hover:no-underline"
                    >
                      console.anthropic.com
                    </a>
                  </li>
                  <li>Create a new API key (or use an existing one)</li>
                  <li>Paste it below</li>
                </ol>
              </div>

              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-sm font-medium text-aos-text mb-1.5">
                    API key
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !isLoading && handleSaveApiKey()}
                    placeholder="sk-ant-api03-…"
                    className="aos-input"
                    autoComplete="off"
                  />
                </div>
              </div>

              {error && <div className="aos-callout-danger mb-4 text-sm">{error}</div>}

              <button
                onClick={handleSaveApiKey}
                disabled={isLoading}
                className="aos-btn-primary w-full py-3"
              >
                {isLoading ? "Saving…" : "Continue"}
              </button>
            </>
          )}

          {step === "oauth" && (
            <>
              <h2 className="text-2xl font-semibold text-aos-text mb-2 tracking-tight">
                Authorize Gmail
              </h2>
              <p className="text-aos-text-soft mb-6 leading-relaxed">
                A browser window will open so you can sign in with Google. AOS Mail will receive
                read &amp; modify access to your messages and read access to your calendar.
              </p>

              <div className="aos-callout-warning mb-6 text-sm">
                These scopes are required for triage and reply drafting. You can revoke access
                anytime from your Google account.
              </div>

              {error && <div className="aos-callout-danger mb-4 text-sm">{error}</div>}

              <button
                onClick={handleStartOAuth}
                disabled={isLoading}
                className="aos-btn-primary w-full py-3"
              >
                {isLoading ? "Authorizing…" : "Authorize with Google"}
              </button>

              {isLoading && (
                <button onClick={handleCancelOAuth} className="aos-btn-quiet w-full mt-2 py-2">
                  Cancel
                </button>
              )}
            </>
          )}

          {step === "extensions" && (
            <>
              <h2 className="text-2xl font-semibold text-aos-text mb-2 tracking-tight">
                Connect services
              </h2>
              <p className="text-aos-text-soft mb-6 leading-relaxed">
                Some extensions enrich your emails with extra context. Connect them now or skip —
                you can hook them up later from Settings.
              </p>

              <div className="space-y-2 mb-6">
                {extensionAuths.map((ext) => (
                  <div
                    key={ext.extensionId}
                    className="flex items-center justify-between px-4 py-3 border border-aos-line rounded-aos bg-white"
                  >
                    <span className="font-medium text-aos-text">{ext.displayName}</span>
                    {ext.needsAuth ? (
                      <button
                        onClick={() => handleExtensionAuth(ext.extensionId, ext.authType)}
                        disabled={authenticatingExtension !== null}
                        className="aos-btn-secondary"
                      >
                        {authenticatingExtension === ext.extensionId ? (
                          <span className="flex items-center gap-2">
                            <span className="aos-spinner" style={{ width: 14, height: 14 }} />
                            Connecting…
                          </span>
                        ) : (
                          "Connect"
                        )}
                      </button>
                    ) : (
                      <span className="flex items-center gap-1.5 text-sm font-medium text-aos-success">
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2.5}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        Connected
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {error && <div className="aos-callout-danger mb-4 text-sm">{error}</div>}

              <button
                onClick={() => setStep("analytics")}
                disabled={authenticatingExtension !== null}
                className="aos-btn-primary w-full py-3"
              >
                Continue
              </button>
            </>
          )}

          {step === "analytics" && (
            <>
              <h2 className="text-2xl font-semibold text-aos-text mb-2 tracking-tight">
                Help improve AOS Mail
              </h2>
              <p className="text-aos-text-soft mb-6 leading-relaxed">
                Optional: send anonymized usage data and crash reports so we can spot real
                problems. <strong>No email content is ever sent.</strong> Toggle anytime from
                Settings.
              </p>

              <label className="flex items-center justify-between p-4 border border-aos-line rounded-aos bg-white cursor-pointer mb-6">
                <div className="pr-4">
                  <div className="font-medium text-aos-text">Usage analytics</div>
                  <div className="text-sm text-aos-text-muted mt-0.5">
                    App interactions, crash diagnostics, session recordings for debugging.
                  </div>
                </div>
                <div
                  role="switch"
                  aria-checked={analyticsEnabled}
                  onClick={() => setAnalyticsEnabled(!analyticsEnabled)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    analyticsEnabled ? "bg-aos-text" : "bg-aos-line-strong"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      analyticsEnabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </div>
              </label>

              <button
                onClick={async () => {
                  setIsLoading(true);
                  try {
                    const result = (await window.api.settings.set({
                      posthog: { enabled: analyticsEnabled, sessionReplay: analyticsEnabled },
                    })) as IpcResponse<void>;
                    if (!result.success) {
                      console.error("[SetupWizard] Failed to save analytics config");
                    }
                    const apiKey = import.meta.env.VITE_POSTHOG_API_KEY;
                    const host = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
                    if (apiKey && result.success) {
                      reconfigurePostHog({
                        enabled: analyticsEnabled,
                        apiKey,
                        host,
                        sessionReplay: analyticsEnabled,
                      });
                    }
                    onComplete();
                  } finally {
                    setIsLoading(false);
                  }
                }}
                disabled={isLoading}
                className="aos-btn-primary w-full py-3"
              >
                {isLoading ? "Finishing…" : "Get started"}
              </button>
            </>
          )}

          {/* Step indicator — only shows steps the user will actually visit */}
          {step !== "loading" && visibleSteps.length > 0 && (
            <div className="flex justify-center gap-1.5 mt-8">
              {visibleSteps.map((s, i) => (
                <div
                  key={s}
                  className={`h-1.5 rounded-full transition-all ${
                    i === currentStepIndex
                      ? "bg-aos-text w-6"
                      : i < currentStepIndex
                        ? "bg-aos-text-soft w-1.5"
                        : "bg-aos-line-strong w-1.5"
                  }`}
                  aria-hidden="true"
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
