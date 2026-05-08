// React error boundary.
//
// Catches render-phase errors thrown anywhere in its subtree and replaces
// the crashed surface with a small "Something went wrong" panel. The point
// is *containment* — by wrapping each major surface separately (titlebar,
// left rail, email list, etc.) one component crashing no longer takes the
// whole window down with it.
//
// Reporting: every catch posts a structured payload to the sidecar via
// `diagnostics.reportError`. The sidecar persists it to its `error_log`
// table for triage. We swallow the report-side error so a sidecar outage
// doesn't loop the boundary.
//
// Reset: each ErrorBoundary keeps a numeric `resetKey` in state. Clicking
// "Reload" bumps it and re-mounts the children, which gives the rest of
// the app a chance to recover after the user dismisses the error.
//
// Why a class component: getDerivedStateFromError + componentDidCatch are
// only available on classes. There is no equivalent hook in React 18.

import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { bridge } from "../lib/bridge";

export function reportRendererError(payload: {
  message: string;
  stack?: string;
  componentStack?: string;
  source?: string;
}): void {
  // Best-effort. If the sidecar is down we still want the user-facing
  // boundary to render — never let a transport failure cascade into a
  // re-throw that would unmount the boundary itself.
  bridge
    .call("diagnostics.reportError", {
      message: payload.message,
      stack: payload.stack,
      componentStack: payload.componentStack,
      source: payload.source ?? "renderer",
    })
    .catch((e: unknown) => {
      console.warn("[ErrorBoundary] failed to forward error to sidecar", e);
    });
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Human-friendly label for the surface. Shown inside the fallback so the
   * user can tell which surface crashed when several are wrapped.
   */
  label?: string;
  /**
   * Optional custom fallback. When provided, replaces the default panel.
   * Receives the captured error and a reset callback.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  resetKey: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, componentStack: null, resetKey: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    reportRendererError({
      message: error.message || String(error),
      stack: error.stack ?? "",
      componentStack: info.componentStack ?? "",
      source: this.props.label ? `renderer:${this.props.label}` : "renderer",
    });
  }

  private handleReload = (): void => {
    // Bump resetKey to force remount of children, then clear the error
    // so the boundary lets the subtree render again. If the underlying
    // problem is persistent the boundary will simply re-trip.
    this.setState((s) => ({
      error: null,
      componentStack: null,
      resetKey: s.resetKey + 1,
    }));
  };

  private handleCopy = async (): Promise<void> => {
    const { error, componentStack } = this.state;
    if (!error) return;
    const payload = [
      `Surface: ${this.props.label ?? "(unlabeled)"}`,
      `Message: ${error.message}`,
      "",
      "Stack:",
      error.stack ?? "(no stack)",
      "",
      "Component stack:",
      componentStack ?? "(none)",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      // Fallback: open a textarea + select. Some sandbox configurations
      // block clipboard API; this still works as a stopgap.
      const ta = document.createElement("textarea");
      ta.value = payload;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing else we can do */
      }
      document.body.removeChild(ta);
    }
  };

  render(): ReactNode {
    const { error, resetKey } = this.state;
    if (!error) {
      // Keying on resetKey forces React to remount the subtree on reset.
      // Fragment (vs. div/span) avoids breaking parent flex/grid layouts.
      return <Fragment key={resetKey}>{this.props.children}</Fragment>;
    }
    if (this.props.fallback) {
      return this.props.fallback(error, this.handleReload);
    }
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="m-3 rounded-lg border border-red-200 dark:border-red-800/60 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-800 dark:text-red-200 flex flex-col gap-2"
      >
        <div className="font-medium">
          Something went wrong
          {this.props.label ? <span className="opacity-80"> · {this.props.label}</span> : null}
        </div>
        <div className="opacity-90 break-words">
          {error.message || "An unexpected error occurred."}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <button
            type="button"
            onClick={this.handleReload}
            className="px-3 py-1 text-xs font-medium rounded bg-red-200 dark:bg-red-800 text-red-900 dark:text-red-100 hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={() => {
              void this.handleCopy();
            }}
            className="px-3 py-1 text-xs font-medium rounded border border-red-300 dark:border-red-700 text-red-800 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
          >
            Copy error
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
