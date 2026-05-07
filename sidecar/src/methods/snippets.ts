// `snippets` IPC namespace — quick-paste snippets users keep alongside
// drafts (e.g. canned responses, common signatures, reusable snippets).
//
// The Electron version stored these in an electron-store JSON file at
// aos-mail-snippets.json under the data dir. The sidecar replaces
// electron-store with the generic openStore() helper, which writes to
// snippets.json with atomic-rename safety.
//
// CRUD methods (get-all / save / create / update / delete) lift cleanly.

import { randomUUID } from "node:crypto";
import { registerMethod } from "../rpc.js";
import { openStore } from "../lib/json-store.js";

export interface Snippet {
  id: string;
  name: string;
  body: string;
  accountId?: string;
  shortcut?: string;
  createdAt: number;
  updatedAt: number;
  // Allow extra fields: the schema is owned by src/shared/types.ts and may
  // grow without round-tripping through the sidecar's local definition.
  [key: string]: unknown;
}

interface SnippetsShape {
  snippets: Snippet[];
}

const store = openStore<SnippetsShape>("snippets", { snippets: [] });

export function registerSnippetsMethods(): void {
  registerMethod("snippets.getAll", () => store.read().snippets);

  registerMethod("snippets.save", (params) => {
    const list = ((params as { snippets?: unknown })?.snippets ?? []) as Snippet[];
    store.write({ snippets: list });
    return { count: list.length };
  });

  registerMethod("snippets.create", (params) => {
    const incoming = (params as { snippet?: Partial<Snippet> })?.snippet ?? {};
    const now = Date.now();
    const created: Snippet = {
      ...(incoming as Snippet),
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    store.patch((s) => ({ snippets: [...s.snippets, created] }));
    return created;
  });

  registerMethod("snippets.update", (params) => {
    const { id, updates } =
      (params as { id?: string; updates?: Partial<Snippet> }) ?? {};
    if (!id) throw new Error("snippets.update: missing id");
    let updated: Snippet | null = null;
    store.patch((s) => {
      const next = s.snippets.map((sn) => {
        if (sn.id !== id) return sn;
        updated = { ...sn, ...(updates ?? {}), updatedAt: Date.now() };
        return updated;
      });
      return { snippets: next };
    });
    if (!updated) throw new Error(`snippets.update: id ${id} not found`);
    return updated;
  });

  registerMethod("snippets.delete", (params) => {
    const { id } = (params as { id?: string }) ?? {};
    if (!id) throw new Error("snippets.delete: missing id");
    let removed = false;
    store.patch((s) => {
      const next = s.snippets.filter((sn) => {
        if (sn.id === id) {
          removed = true;
          return false;
        }
        return true;
      });
      return { snippets: next };
    });
    if (!removed) throw new Error(`snippets.delete: id ${id} not found`);
    return { id };
  });
}
