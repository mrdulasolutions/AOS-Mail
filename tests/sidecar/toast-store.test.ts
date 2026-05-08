// Unit tests for the unified renderer toast store.
//
// Lives under tests/sidecar/ because that's the only directory wired into
// `npm run test:sidecar` — the toast store is renderer code (zustand only,
// no DOM), so it runs fine in the same Node test runner as the sidecar
// suites. No relation to the sidecar process itself.
//
// Coverage:
//   - pushToast returns a stable id and registers in the queue
//   - dismissToast drops the entry by id
//   - mergeKey collapses same-key undo pushes into one row, advances expiry
//   - peekLatestUndo returns the most-recent undo for the Cmd+Z dispatcher
//   - getSuppressedEmailIds aggregates across all live undo toasts
//   - non-undo toasts (info/progress/error) don't affect the undo lookup
//
// We don't mount the React component here — a behavior-level test of the
// keydown listener belongs in playwright-driven e2e. This file exercises
// the data layer.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  useToastStore,
  peekLatestUndo,
  getSuppressedEmailIds,
} from "../../src/renderer/lib/toast-store";

describe("toast-store", () => {
  beforeEach(() => {
    // Each test starts with an empty queue. Using the test-only helper
    // keeps the public API surface minimal.
    useToastStore.getState()._resetForTesting();
  });

  test("pushToast returns a stable id and registers the toast", () => {
    const id = useToastStore.getState().pushToast({ kind: "info", text: "hi" });
    assert.equal(typeof id, "string");
    assert.equal(useToastStore.getState().toasts.length, 1);
    assert.equal(useToastStore.getState().toasts[0].id, id);
    assert.equal(useToastStore.getState().toasts[0].text, "hi");
  });

  test("dismissToast removes the toast by id", () => {
    const a = useToastStore.getState().pushToast({ kind: "info", text: "a" });
    const b = useToastStore.getState().pushToast({ kind: "info", text: "b" });
    assert.equal(useToastStore.getState().toasts.length, 2);
    useToastStore.getState().dismissToast(a);
    const remaining = useToastStore.getState().toasts;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, b);
  });

  test("mergeKey collapses same-key undo pushes into one row", () => {
    const expiresAt1 = Date.now() + 5_000;
    const id1 = useToastStore.getState().pushToast({
      kind: "undo",
      text: "Thread archived.",
      undoable: () => {},
      expiresAt: expiresAt1,
      suppressEmailIds: ["e1"],
      mergeKey: "archive:acct-1",
    });
    const expiresAt2 = Date.now() + 6_000;
    const id2 = useToastStore.getState().pushToast({
      kind: "undo",
      text: "2 threads archived.",
      undoable: () => {},
      expiresAt: expiresAt2,
      suppressEmailIds: ["e2"],
      mergeKey: "archive:acct-1",
    });
    // Same id — second push merged into the first row.
    assert.equal(id1, id2);
    const queue = useToastStore.getState().toasts;
    assert.equal(queue.length, 1);
    const merged = queue[0];
    assert.equal(merged.kind, "undo");
    if (merged.kind !== "undo") throw new Error("type guard");
    assert.deepEqual(merged.suppressEmailIds, ["e1", "e2"]);
    assert.equal(merged.expiresAt, expiresAt2, "expiry advances on merge");
  });

  test("mergeKey does NOT merge across different mergeKeys", () => {
    useToastStore.getState().pushToast({
      kind: "undo",
      text: "Archive.",
      undoable: () => {},
      expiresAt: Date.now() + 5_000,
      mergeKey: "archive:acct-1",
    });
    useToastStore.getState().pushToast({
      kind: "undo",
      text: "Trash.",
      undoable: () => {},
      expiresAt: Date.now() + 5_000,
      mergeKey: "trash:acct-1",
    });
    assert.equal(useToastStore.getState().toasts.length, 2);
  });

  test("mergeKey does NOT merge into an already-expired entry", () => {
    // Push with an already-expired timestamp — a fresh push should NOT
    // merge into it (the legacy code's invariant: expired entries are
    // committing or about to commit, treat the new press as fresh).
    useToastStore.getState().pushToast({
      kind: "undo",
      text: "stale",
      undoable: () => {},
      expiresAt: Date.now() - 1_000, // already expired
      mergeKey: "archive:acct-1",
    });
    useToastStore.getState().pushToast({
      kind: "undo",
      text: "fresh",
      undoable: () => {},
      expiresAt: Date.now() + 5_000,
      mergeKey: "archive:acct-1",
    });
    // Two distinct entries — no merge.
    assert.equal(useToastStore.getState().toasts.length, 2);
  });

  test("peekLatestUndo returns the most-recent undo (Cmd+Z order)", () => {
    useToastStore.getState().pushToast({ kind: "info", text: "info" });
    const undoA = useToastStore.getState().pushToast({
      kind: "undo",
      text: "A",
      undoable: () => {},
      expiresAt: Date.now() + 5_000,
    });
    useToastStore.getState().pushToast({ kind: "info", text: "later info" });
    const undoB = useToastStore.getState().pushToast({
      kind: "undo",
      text: "B",
      undoable: () => {},
      expiresAt: Date.now() + 5_000,
    });
    const latest = peekLatestUndo();
    assert.ok(latest);
    assert.equal(latest.id, undoB, "most recent undo wins");
    // Removing B promotes A to most-recent — the property we depend on
    // when chaining undos via repeated Cmd+Z.
    useToastStore.getState().dismissToast(undoB);
    const next = peekLatestUndo();
    assert.ok(next);
    assert.equal(next.id, undoA);
  });

  test("peekLatestUndo skips info/progress/error rows", () => {
    useToastStore.getState().pushToast({ kind: "progress", text: "Triaging…" });
    useToastStore.getState().pushToast({ kind: "info", text: "Draft opened" });
    useToastStore.getState().pushToast({ kind: "error", text: "Failed" });
    assert.equal(peekLatestUndo(), null, "no undo entries → null");
  });

  test("getSuppressedEmailIds unions across all undo toasts", () => {
    useToastStore.getState().pushToast({
      kind: "undo",
      text: "a",
      undoable: () => {},
      expiresAt: Date.now() + 5_000,
      suppressEmailIds: ["e1", "e2"],
    });
    useToastStore.getState().pushToast({
      kind: "undo",
      text: "b",
      undoable: () => {},
      expiresAt: Date.now() + 5_000,
      suppressEmailIds: ["e2", "e3"],
    });
    // info toast has no suppressEmailIds field — must not crash.
    useToastStore.getState().pushToast({ kind: "info", text: "c" });

    const ids = getSuppressedEmailIds();
    assert.deepEqual([...ids].sort(), ["e1", "e2", "e3"]);
  });

  test("dismissed undo toasts no longer suppress their emails", () => {
    const id = useToastStore.getState().pushToast({
      kind: "undo",
      text: "a",
      undoable: () => {},
      expiresAt: Date.now() + 5_000,
      suppressEmailIds: ["e1"],
    });
    assert.deepEqual([...getSuppressedEmailIds()], ["e1"]);
    useToastStore.getState().dismissToast(id);
    assert.equal(getSuppressedEmailIds().size, 0);
  });

  test("merged undo composes both undoable callbacks", async () => {
    let aCalled = false;
    let bCalled = false;
    const id = useToastStore.getState().pushToast({
      kind: "undo",
      text: "1",
      undoable: () => {
        aCalled = true;
      },
      expiresAt: Date.now() + 5_000,
      mergeKey: "merge:test",
    });
    const id2 = useToastStore.getState().pushToast({
      kind: "undo",
      text: "2",
      undoable: () => {
        bCalled = true;
      },
      expiresAt: Date.now() + 6_000,
      mergeKey: "merge:test",
    });
    assert.equal(id, id2);

    const merged = useToastStore.getState().toasts.find((t) => t.id === id);
    assert.ok(merged);
    if (merged.kind !== "undo") throw new Error("type guard");
    await merged.undoable();
    assert.equal(aCalled, true);
    assert.equal(bCalled, true);
  });

  test("updateToast patches text and pct on a progress toast", () => {
    const id = useToastStore.getState().pushToast({ kind: "progress", text: "Working…" });
    useToastStore.getState().updateToast(id, { text: "Almost done", pct: 75 });
    const t = useToastStore.getState().toasts[0];
    assert.equal(t.text, "Almost done");
    if (t.kind !== "progress") throw new Error("type guard");
    assert.equal(t.pct, 75);
  });
});
