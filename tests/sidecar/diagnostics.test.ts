// Diagnostics RPC tests.
//
// Covers the renderer-error reporting path: a payload with stack +
// componentStack should land in the `error_log` table, be readable via
// diagnostics.recentErrors, and trim past the row cap.
//
// Why these tests exist: this surface is the only way crash data leaves
// the renderer for users who don't enable PostHog. Silently dropping
// records here means we'd lose the bug reports that matter most. Pinning
// the round-trip stops a future schema migration from breaking it.

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSidecar, type Harness } from "./_helpers/sidecar-process.js";

interface OkResult {
  ok: true;
}

interface ErrorRow {
  id: number;
  createdAt: string;
  source: string;
  message: string;
  stack: string;
  componentStack: string;
}

describe("diagnostics.reportError + recentErrors", () => {
  let h: Harness;
  before(async () => {
    h = await spawnSidecar();
  });
  after(async () => {
    await h.close();
  });

  it("persists a renderer error and returns it via recentErrors", async () => {
    await h.call<OkResult>("diagnostics.reportError", {
      message: "Cannot read property 'foo' of undefined",
      stack: "TypeError: Cannot read property 'foo' of undefined\n    at Component.tsx:42",
      componentStack: "    in Component\n    in App",
      source: "renderer:Email detail",
    });
    const rows = await h.call<ErrorRow[]>("diagnostics.recentErrors", { limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "renderer:Email detail");
    assert.equal(rows[0].message, "Cannot read property 'foo' of undefined");
    assert.match(rows[0].stack, /TypeError/);
    assert.match(rows[0].componentStack, /in Component/);
  });

  it("falls back to a default message when none is provided", async () => {
    await h.call<OkResult>("diagnostics.reportError", {});
    const rows = await h.call<ErrorRow[]>("diagnostics.recentErrors", { limit: 1 });
    assert.equal(rows[0].message, "Unknown renderer error");
    assert.equal(rows[0].source, "renderer");
  });

  it("clips overly long stacks at the configured boundary", async () => {
    const huge = "x".repeat(20000);
    await h.call<OkResult>("diagnostics.reportError", {
      message: "boom",
      stack: huge,
    });
    const rows = await h.call<ErrorRow[]>("diagnostics.recentErrors", { limit: 1 });
    // Cap is 8000 — anything longer should be truncated.
    assert.ok(rows[0].stack.length <= 8000, `stack length ${rows[0].stack.length} exceeded cap`);
  });

  it("returns rows in newest-first order", async () => {
    // Three more reports on top of the existing ones from prior tests.
    await h.call<OkResult>("diagnostics.reportError", { message: "first" });
    await h.call<OkResult>("diagnostics.reportError", { message: "second" });
    await h.call<OkResult>("diagnostics.reportError", { message: "third" });
    const rows = await h.call<ErrorRow[]>("diagnostics.recentErrors", { limit: 3 });
    assert.equal(rows[0].message, "third");
    assert.equal(rows[1].message, "second");
    assert.equal(rows[2].message, "first");
  });
});
