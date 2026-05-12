// `splits` IPC namespace — user-defined inbox splits / smart folders.
//
// Same shape as snippets: electron-store in the Electron path; sidecar
// uses the generic openStore() helper. CRUD methods lift cleanly.

import { randomUUID } from "node:crypto";
import { registerMethod } from "../rpc.js";
import { openStore } from "../lib/json-store.js";

export interface InboxSplit {
  id: string;
  accountId: string;
  name: string;
  query: string;
  order?: number;
  // Schema lives in src/shared/types.ts; allow forward-compatible fields.
  [key: string]: unknown;
}

interface SplitsShape {
  splits: InboxSplit[];
}

const store = openStore<SplitsShape>("splits", { splits: [] });

export function registerSplitsMethods(): void {
  registerMethod("splits.getAll", () => store.read().splits);

  registerMethod("splits.save", (params) => {
    const list = ((params as { splits?: unknown })?.splits ?? []) as InboxSplit[];
    store.write({ splits: list });
    return { count: list.length };
  });

  registerMethod("splits.create", (params) => {
    const incoming = (params as { split?: Partial<InboxSplit> })?.split ?? {};
    const created: InboxSplit = {
      ...(incoming as InboxSplit),
      id: randomUUID(),
    };
    store.patch((s) => ({ splits: [...s.splits, created] }));
    return created;
  });

  registerMethod("splits.update", (params) => {
    const { id, updates } = (params as { id?: string; updates?: Partial<InboxSplit> }) ?? {};
    if (!id) throw new Error("splits.update: missing id");
    let updated: InboxSplit | null = null;
    store.patch((s) => {
      const next = s.splits.map((sp) => {
        if (sp.id !== id) return sp;
        updated = { ...sp, ...(updates ?? {}) };
        return updated;
      });
      return { splits: next };
    });
    if (!updated) throw new Error(`splits.update: id ${id} not found`);
    return updated;
  });

  registerMethod("splits.delete", (params) => {
    const { id } = (params as { id?: string }) ?? {};
    if (!id) throw new Error("splits.delete: missing id");
    let removed = false;
    store.patch((s) => {
      const next = s.splits.filter((sp) => {
        if (sp.id === id) {
          removed = true;
          return false;
        }
        return true;
      });
      return { splits: next };
    });
    if (!removed) throw new Error(`splits.delete: id ${id} not found`);
    return { id };
  });
}
