// Debug-pass driver — exercises every user-flow RPC against a sidecar
// instance with a fresh tmp DB. Uses the existing tests/sidecar/_helpers
// harness so the wire format and seed paths match what tests use.
//
// Output: prints per-flow PASS / FAIL / SLOW lines. The aggregator at the
// bottom summarizes counts. Used to author docs/DEBUG-REPORT-2026-05.md.

import { spawnSidecar, type Harness } from "../tests/sidecar/_helpers/sidecar-process.js";
import {
  seedAccount,
  seedEmail,
  seedAnalysis,
  seedDraft,
} from "../tests/sidecar/_helpers/seed.js";

interface Finding {
  flow: string;
  status: "ok" | "broken" | "slow" | "weird";
  severity?: "P0" | "P1" | "P2";
  observed?: string;
  expected?: string;
  durationMs?: number;
  reproducer?: string;
}

const findings: Finding[] = [];
const SLOW_MS = 500;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

function record(f: Finding): void {
  findings.push(f);
  const status = f.status.padEnd(7);
  const dur = f.durationMs !== undefined ? `${f.durationMs.toString().padStart(5)}ms ` : "       ";
  console.log(`${status} ${dur} ${f.flow}` + (f.observed ? ` -- ${f.observed}` : ""));
}

async function checkOk<T>(
  flow: string,
  call: () => Promise<T>,
  validate?: (v: T) => string | null,
): Promise<T | null> {
  try {
    const { value, ms } = await timed(call);
    const slow = ms > SLOW_MS;
    let problem: string | null = null;
    if (validate) problem = validate(value);
    if (problem) {
      record({ flow, status: "broken", durationMs: ms, observed: problem, severity: "P1" });
      return null;
    }
    if (slow) {
      record({ flow, status: "slow", durationMs: ms, observed: `>${SLOW_MS}ms` });
    } else {
      record({ flow, status: "ok", durationMs: ms });
    }
    return value;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record({ flow, status: "broken", observed: msg, severity: "P0" });
    return null;
  }
}

async function checkThrows(
  flow: string,
  call: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  try {
    const { ms } = await timed(call);
    record({
      flow,
      status: "broken",
      durationMs: ms,
      observed: `did not throw; expected ${expected}`,
      severity: "P1",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (expected.test(msg)) {
      record({ flow, status: "ok", observed: `threw as expected` });
    } else {
      record({
        flow,
        status: "broken",
        observed: `threw "${msg}"; expected to match ${expected}`,
        severity: "P1",
      });
    }
  }
}

async function main() {
  console.log("=== AOS Mail sidecar debug pass ===\n");
  let h: Harness | null = null;

  // ─── First boot (fresh DB) ─────────────────────────────────────────
  console.log("\n── First boot (fresh DB)\n");
  h = await spawnSidecar();

  await checkOk("ping", () => h!.call<{ ok: boolean }>("ping"), (v) =>
    v.ok ? null : "ping returned ok:false",
  );

  await checkOk("sync.init -> [] when empty", async () => {
    const accts = await h!.call<unknown[]>("sync.init");
    return accts;
  }, (v) => (Array.isArray(v) && v.length === 0 ? null : `expected [], got ${JSON.stringify(v)}`));

  await checkOk("accounts.list -> [] when empty", async () => h!.call<unknown[]>("accounts.list"));
  await checkOk("settings.get on fresh DB", async () => h!.call("settings.get"));
  await checkOk("settings.getEA on fresh DB", () => h!.call("settings.getEA"), (v: any) =>
    v && typeof v.enabled === "boolean" ? null : "missing enabled flag",
  );
  await checkOk("settings.getPrompts on fresh DB", () => h!.call("settings.getPrompts"));
  await checkOk("theme.get on fresh DB", () => h!.call("theme.get"), (v: any) =>
    v && typeof v.preference === "string" ? null : `missing preference: ${JSON.stringify(v)}`,
  );

  await checkOk("usage.getStats on fresh DB", () => h!.call("usage.getStats"), (v: any) =>
    v && v.today && typeof v.today.totalCalls === "number" ? null : "missing today aggregates",
  );
  await checkOk("usage.getHistory on fresh DB", () => h!.call("usage.getHistory"), (v: any) =>
    Array.isArray(v) && v.length === 0 ? null : `expected []; got ${JSON.stringify(v)}`,
  );
  await checkOk("usage.getStatsToday on fresh DB", () => h!.call("usage.getStatsToday"));
  await checkOk("usage.getStatsThisMonth on fresh DB", () => h!.call("usage.getStatsThisMonth"));
  await checkOk("usage.getHistoryWithSubjects empty", () => h!.call("usage.getHistoryWithSubjects"));

  await checkOk("anthropic.hasApiKey on fresh DB", () => h!.call("anthropic.hasApiKey"), (v: any) =>
    v && typeof v.configured === "boolean" ? null : "missing configured flag",
  );
  await checkOk("openrouter.hasApiKey on fresh DB", () => h!.call("openrouter.hasApiKey"));
  await checkOk("network.getStatus", () => h!.call("network.getStatus"));

  await checkOk("extensions.list", () => h!.call<unknown[]>("extensions.list"), (v) =>
    Array.isArray(v) && v.length > 0 ? null : "expected at least one bundled extension",
  );

  // Method-not-found smoke test
  await checkThrows(
    "unknown method returns clean error",
    () => h!.call("not.a.real.method"),
    /Method not found/,
  );

  // ─── Add Gmail account flow (no real OAuth — error paths) ─────────
  console.log("\n── Add Gmail account flow\n");
  await checkOk("gmail.hasCredentials false on fresh DB", () => h!.call("gmail.hasCredentials"),
    (v: any) => (v.configured === false ? null : "expected configured:false"),
  );
  await checkOk("gmail.saveCredentials persists creds", () =>
    h!.call("gmail.saveCredentials", { clientId: "test-id", clientSecret: "test-secret" }),
  );
  await checkOk("gmail.hasCredentials true after save", () => h!.call("gmail.hasCredentials"),
    (v: any) => (v.configured === true ? null : "expected configured:true"),
  );
  await checkThrows(
    "gmail.saveCredentials missing fields",
    () => h!.call("gmail.saveCredentials", {}),
    /requires \{ clientId, clientSecret \}/,
  );
  await checkOk("gmail.checkAuth on fresh DB", () => h!.call("gmail.checkAuth"));
  await checkThrows(
    "gmail.disconnect missing accountId",
    () => h!.call("gmail.disconnect", {}),
    /requires \{ accountId \}/,
  );

  await checkThrows(
    "gmail.listLabels missing tokens",
    () => h!.call("gmail.listLabels", { accountId: "no-such-account" }),
    /No tokens/,
  );

  // ─── Add IMAP account flow ────────────────────────────────────────
  console.log("\n── Add IMAP account flow\n");
  await checkOk("imap.presets returns presets", () => h!.call<unknown>("imap.presets"),
    (v: any) => (Array.isArray(v?.presets) && v.presets.length > 0 ? null : "no presets"),
  );
  await checkOk("imap.suggestForEmail (gmail address)", () =>
    h!.call("imap.suggestForEmail", { email: "user@gmail.com" }),
  );
  await checkOk("imap.suggestForEmail (custom domain)", () =>
    h!.call("imap.suggestForEmail", { email: "user@example.com" }),
  );
  await checkThrows(
    "imap.suggestForEmail missing email",
    () => h!.call("imap.suggestForEmail", {}),
    /requires \{ email \}/,
  );
  // testConnection bogus host: returns {ok: false, error}, doesn't throw
  await checkOk(
    "imap.testConnection bogus host (returns ok:false)",
    () =>
      h!.call("imap.testConnection", {
        email: "x@example.com",
        password: "x",
        imapHost: "127.0.0.1",
        imapPort: 1,
        smtpHost: "127.0.0.1",
        smtpPort: 1,
      }),
    (v: any) => (v.ok === false ? null : `expected ok:false, got ${JSON.stringify(v)}`),
  );
  await checkThrows(
    "imap.addAccount missing fields",
    () => h!.call("imap.addAccount", {}),
    /requires \{ email/,
  );
  await checkThrows(
    "imap.disconnect missing accountId",
    () => h!.call("imap.disconnect", {}),
    /requires \{ accountId \}/,
  );

  await h.close();

  // ─── Inbox load + folder switch (with seeded data) ────────────────
  console.log("\n── Inbox load + folder switch (seeded)\n");
  h = await spawnSidecar();

  const acct = seedAccount(h, { email: "user@example.com", provider: "imap" });
  const e1 = seedEmail(h, { accountId: acct, subject: "Hello", body: "Body 1" });
  const e2 = seedEmail(h, { accountId: acct, subject: "Sale", labelIds: ["INBOX"] });
  seedEmail(h, {
    accountId: acct,
    subject: "Sent item",
    labelIds: ["SENT", "Sent Items"],
  });

  await checkOk(
    "sync.now without real account (graceful error)",
    () => h!.call("sync.now", { accountId: acct }),
    (v: any) =>
      v && Array.isArray(v.errors) ? null : `unexpected shape ${JSON.stringify(v)}`,
  );
  await checkThrows("sync.now missing accountId", () => h!.call("sync.now", {}), /requires \{ accountId \}/);

  await checkOk(
    "sync.getEmails",
    () => h!.call<unknown[]>("sync.getEmails", { accountId: acct }),
    (v) => (Array.isArray(v) ? null : "expected array"),
  );
  await checkOk(
    "sync.getSentEmails",
    () => h!.call<unknown[]>("sync.getSentEmails", { accountId: acct }),
    (v) => (Array.isArray(v) ? null : "expected array"),
  );
  await checkThrows(
    "sync.getSentEmails missing accountId",
    () => h!.call("sync.getSentEmails", {}),
    /requires \{ accountId \}/,
  );

  await checkOk(
    "sync.prefetchBodies happy path",
    () => h!.call("sync.prefetchBodies", { ids: [e1, e2] }),
  );
  await checkOk(
    "sync.prefetchBodies empty",
    () => h!.call("sync.prefetchBodies", { ids: [] }),
  );

  await checkOk(
    "sync.fetchBody for seeded email",
    () => h!.call("sync.fetchBody", { emailId: e1 }),
  );
  await checkThrows(
    "sync.fetchBody missing emailId",
    () => h!.call("sync.fetchBody", {}),
    /requires \{ emailId \}/,
  );

  await checkOk(
    "sync.loadMore (no real provider)",
    () => h!.call("sync.loadMore", { accountId: acct }),
  );
  await checkThrows(
    "sync.loadMore missing accountId",
    () => h!.call("sync.loadMore", {}),
    /requires \{ accountId \}/,
  );

  await checkOk(
    "sync.status",
    () => h!.call("sync.status", { accountId: acct }),
  );

  // Folder switch
  await checkOk(
    "sync.getEmails with folder filter",
    () => h!.call<unknown[]>("sync.getEmails", { accountId: acct, folder: "Sent Items" }),
    (v) => (Array.isArray(v) && v.length === 1 ? null : `expected 1 row, got ${JSON.stringify(v)}`),
  );
  await checkOk(
    "imap.listFolders pre-add fails cleanly",
    () =>
      h!
        .call("imap.listFolders", { accountId: acct })
        .catch((e: Error) => ({ caught: e.message })),
    (v: any) => (v.caught ? null : `expected throw, got ${JSON.stringify(v)}`),
  );

  // ─── Open thread + summary ──────────────────────────────────────
  console.log("\n── Open thread + summary\n");

  // Single-message thread
  await checkOk(
    "emails.getThread (1 msg)",
    () => h!.call<unknown[]>("emails.getThread", { threadId: e1, accountId: acct }),
    (v) => (Array.isArray(v) && v.length === 1 ? null : `expected 1 row, got ${JSON.stringify(v)}`),
  );

  // Multi-message thread for summary
  const tThread = "thread-summary-test";
  seedEmail(h, {
    id: `imap:${acct}:INBOX:s1`,
    accountId: acct,
    threadId: tThread,
    subject: "Big proposal",
    body: "Original message body",
    date: "2025-01-01T00:00:00Z",
  });
  seedEmail(h, {
    id: `imap:${acct}:INBOX:s2`,
    accountId: acct,
    threadId: tThread,
    subject: "Re: Big proposal",
    body: "Reply body",
    date: "2025-01-02T00:00:00Z",
  });

  await checkOk(
    "summary.thread for single-message thread (returns empty)",
    () => h!.call("summary.thread", { threadId: e1, accountId: acct }),
    (v: any) => (typeof v.summary === "string" ? null : "missing summary field"),
  );

  await checkThrows(
    "summary.thread missing args",
    () => h!.call("summary.thread", {}),
    /requires \{ threadId, accountId \}/,
  );

  // Multi-message: with no API key should error gracefully (not crash).
  // We don't assert specific copy because the error string is environment-dependent.
  await checkThrows(
    "summary.thread without API key surfaces a clean error",
    () => h!.call("summary.thread", { threadId: tThread, accountId: acct }),
    /./,
  );

  // ─── Triage: analysis flows ───────────────────────────────────
  console.log("\n── Triage: analysis flows\n");
  await checkThrows(
    "analysis.analyze missing emailId",
    () => h!.call("analysis.analyze", {}),
    /requires \{ emailId \}/,
  );
  await checkThrows(
    "analysis.analyze unknown emailId",
    () => h!.call("analysis.analyze", { emailId: "no-such-email" }),
    /not found/,
  );
  await checkOk(
    "analysis.list empty",
    () => h!.call("analysis.list", { accountId: acct }),
  );
  // Pre-seed an analysis row, then list
  seedAnalysis(h, {
    emailId: e1,
    needsReply: true,
    reason: "boss is asking",
    priority: "high",
  });
  await checkOk(
    "analysis.list returns seeded row",
    () => h!.call<unknown[]>("analysis.list", { accountId: acct }),
    (v) => (Array.isArray(v) && v.length === 1 ? null : `expected 1, got ${JSON.stringify(v)}`),
  );
  await checkOk(
    "analysis.overridePriority",
    () => h!.call("analysis.overridePriority", {
      emailId: e1,
      newNeedsReply: false,
      newPriority: "low",
      reason: "user override",
    }),
  );
  await checkThrows(
    "analysis.analyzeBatch wrong arg",
    () => h!.call("analysis.analyzeBatch", { emailIds: "wrong" }),
    /requires \{ emailIds: string\[\] \}/,
  );
  // analyzeBatch with empty array — does it return cleanly?
  await checkOk(
    "analysis.analyzeBatch empty array",
    () => h!.call("analysis.analyzeBatch", { emailIds: [] }),
    (v: any) => (Array.isArray(v?.results) ? null : "missing results array"),
  );

  // archiveReady: takes { threadId, accountId } not { emailId }
  await checkOk(
    "archiveReady.list",
    () => h!.call("archiveReady.list", { accountId: acct }),
  );
  await checkThrows(
    "archiveReady.analyze missing args",
    () => h!.call("archiveReady.analyze", {}),
    /requires \{ threadId, accountId \}/,
  );
  await checkThrows(
    "archiveReady.analyze unknown thread",
    () =>
      h!.call("archiveReady.analyze", {
        threadId: "no-such-thread",
        accountId: acct,
      }),
    /not found/,
  );
  await checkOk(
    "archiveReady.override",
    () =>
      h!.call("archiveReady.override", {
        threadId: tThread,
        accountId: acct,
        isReady: true,
        reason: "manual",
      }),
  );

  // ─── Drafts ────────────────────────────────────────────────────
  console.log("\n── Drafts\n");
  await checkThrows(
    "drafts.save missing emailId",
    () => h!.call("drafts.save", {}),
    /requires \{ emailId \}/,
  );
  await checkThrows(
    "drafts.save missing body",
    () => h!.call("drafts.save", { emailId: e1 }),
    /requires \{ body \}/,
  );
  await checkOk(
    "drafts.save creates row",
    () => h!.call("drafts.save", { emailId: e1, body: "Hi", composeMode: "reply" }),
  );
  await checkOk(
    "drafts.save empty body deletes row",
    () => h!.call("drafts.save", { emailId: e1, body: "" }),
  );
  await checkThrows(
    "drafts.refine missing args",
    () => h!.call("drafts.refine", {}),
    /requires \{ emailId, currentDraft, critique \}/,
  );
  await checkThrows(
    "drafts.refine unknown emailId",
    () => h!.call("drafts.refine", { emailId: "missing", currentDraft: "x", critique: "y" }),
    /not found/,
  );
  await checkThrows(
    "drafts.rerunAgent missing emailId",
    () => h!.call("drafts.rerunAgent", {}),
    /requires \{ emailId \}/,
  );
  await checkThrows(
    "drafts.rerunAgent unknown emailId",
    () => h!.call("drafts.rerunAgent", { emailId: "missing" }),
    /not found/,
  );
  await checkOk(
    "drafts.rerunAllAgents (V1 noop)",
    () => h!.call("drafts.rerunAllAgents"),
  );

  // ─── Smart action: archive/trash/star/unarchive ─────────────
  console.log("\n── Smart action verbs\n");
  await checkThrows(
    "emails.archive missing emailId",
    () => h!.call("emails.archive", {}),
    /requires \{ emailId \}/,
  );
  await checkThrows(
    "emails.batchArchive empty array",
    () => h!.call("emails.batchArchive", { emailIds: [] }),
    /requires \{ emailIds: string\[\] \}/,
  );
  await checkThrows(
    "emails.batchTrash empty array",
    () => h!.call("emails.batchTrash", { emailIds: [] }),
    /requires \{ emailIds: string\[\] \}/,
  );
  await checkThrows(
    "emails.unarchive missing emailId",
    () => h!.call("emails.unarchive", {}),
    /requires \{ emailId \}/,
  );
  await checkThrows(
    "emails.archiveThread missing args",
    () => h!.call("emails.archiveThread", {}),
    /requires \{ threadId, accountId \}/,
  );
  await checkThrows(
    "emails.setRead missing emailId",
    () => h!.call("emails.setRead", { read: true }),
    /requires \{ emailId \}/,
  );
  await checkThrows(
    "emails.setStarred missing emailId",
    () => h!.call("emails.setStarred", { starred: true }),
    /requires \{ emailId \}/,
  );
  await checkThrows(
    "emails.archive unknown id scheme",
    () => h!.call("emails.archive", { emailId: "weird:foo" }),
    /unknown email id scheme/,
  );

  // ─── Awaiting reply ─────────────────────────────────────────
  console.log("\n── Awaiting reply\n");
  await checkThrows(
    "awaitingReply.list missing accountId",
    () => h!.call("awaitingReply.list", {}),
    /requires \{ accountId \}/,
  );
  await checkOk(
    "awaitingReply.list with no waiting threads",
    () => h!.call<unknown[]>("awaitingReply.list", { accountId: acct }),
    (v) => (Array.isArray(v) ? null : "expected array"),
  );
  await checkThrows(
    "awaitingReply.draftNudge missing args",
    () => h!.call("awaitingReply.draftNudge", {}),
    /requires \{ threadId, accountId \}/,
  );
  await checkThrows(
    "awaitingReply.draftNudge unknown thread",
    () => h!.call("awaitingReply.draftNudge", { threadId: "no", accountId: acct }),
    /no SENT message/,
  );

  // ─── Learned rules ─────────────────────────────────────────
  console.log("\n── Learned rules\n");
  await checkOk(
    "learnedRules.list empty",
    () => h!.call("learnedRules.list", { accountId: acct }),
    (v: any) => (Array.isArray(v?.rules) ? null : "missing rules array"),
  );
  await checkThrows(
    "learnedRules.toggle missing ruleId",
    () => h!.call("learnedRules.toggle", { enabled: true }),
    /requires \{ ruleId \}/,
  );
  await checkThrows(
    "learnedRules.toggle missing enabled",
    () => h!.call("learnedRules.toggle", { ruleId: "x" }),
    /requires \{ enabled: boolean \}/,
  );
  await checkThrows(
    "learnedRules.toggle unknown rule",
    () => h!.call("learnedRules.toggle", { ruleId: "no-such-rule", enabled: true }),
    /not found/,
  );
  await checkOk(
    "learnedRules.reset",
    () => h!.call("learnedRules.reset", { accountId: acct }),
  );

  // ─── Calendar ──────────────────────────────────────────────
  console.log("\n── Calendar\n");
  await checkOk(
    "calendar.list (no Gmail accounts)",
    () => h!.call("calendar.list"),
    (v: any) =>
      v && v.success === true && Array.isArray(v.calendars) && v.calendars.length === 0
        ? null
        : `unexpected ${JSON.stringify(v)}`,
  );
  await checkOk(
    "calendar.getEvents (no accounts)",
    () => h!.call("calendar.getEvents", {}),
    (v: any) => (Array.isArray(v) && v.length === 0 ? null : `expected []; got ${JSON.stringify(v)}`),
  );
  await checkThrows(
    "calendar.respondToEvent missing args",
    () => h!.call("calendar.respondToEvent", {}),
    /requires \{ accountId, calendarId, eventId, response \}/,
  );
  await checkThrows(
    "calendar.respondToEvent invalid response",
    () =>
      h!.call("calendar.respondToEvent", {
        accountId: "a",
        calendarId: "b",
        eventId: "c",
        response: "garbage",
      }),
    /invalid response/,
  );
  await checkThrows(
    "calendar.setVisibility missing args",
    () => h!.call("calendar.setVisibility", {}),
    /requires \{ accountId, calendarId, visible \}/,
  );

  // ─── Sender / extensions ────────────────────────────────────
  console.log("\n── Sender + extensions\n");
  await checkOk(
    "sender.getCached miss",
    () => h!.call("sender.getCached", { email: "no-such@nowhere.test" }),
    (v: any) => (v === null ? null : `expected null; got ${JSON.stringify(v)}`),
  );
  await checkOk(
    "sender.getProfile miss returns null",
    () => h!.call("sender.getProfile", { email: "no-such@nowhere.test" }),
    (v: any) => (v === null ? null : `expected null; got ${JSON.stringify(v)}`),
  );
  await checkThrows(
    "sender.getCached missing email",
    () => h!.call("sender.getCached", {}),
    /requires \{ email \}/,
  );
  await checkThrows(
    "sender.getProfile missing email",
    () => h!.call("sender.getProfile", {}),
    /requires \{ email \}/,
  );
  await checkThrows(
    "extensions.getEnrichment missing extensionId",
    () => h!.call("extensions.getEnrichment", {}),
    /requires \{ extensionId \}/,
  );
  await checkThrows(
    "extensions.getEnrichment missing email",
    () => h!.call("extensions.getEnrichment", { extensionId: "sender-profile" }),
    /requires \{ email \}/,
  );
  await checkThrows(
    "extensions.getEnrichment unknown extension",
    () => h!.call("extensions.getEnrichment", { extensionId: "no-such", email: "a@b.test" }),
    /no dispatcher/,
  );

  // ─── Settings round-trip ────────────────────────────────────
  console.log("\n── Settings round-trip\n");
  // EA
  await checkOk(
    "settings.setEA round-trip",
    async () => {
      await h!.call("settings.setEA", {
        enabled: true,
        name: "Alice",
        email: "alice@example.com",
      });
      const ea: any = await h!.call("settings.getEA");
      if (ea.enabled !== true || ea.name !== "Alice" || ea.email !== "alice@example.com") {
        throw new Error(`round-trip failed: ${JSON.stringify(ea)}`);
      }
      return ea;
    },
  );
  await checkThrows(
    "settings.setEA invalid",
    () => h!.call("settings.setEA", null as any),
    /requires EAConfig object/,
  );
  // Prompts
  await checkOk(
    "settings.setPrompts round-trip",
    async () => {
      await h!.call("settings.setPrompts", { analysisPrompt: "test prompt" });
      const p: any = await h!.call("settings.getPrompts");
      if (p.analysisPrompt !== "test prompt") {
        throw new Error(`round-trip failed: ${JSON.stringify(p)}`);
      }
      return p;
    },
  );
  await checkThrows(
    "settings.setPrompts non-string",
    () => h!.call("settings.setPrompts", { analysisPrompt: 42 }),
    /must be a string/,
  );
  // settings.set / settings.get
  await checkOk(
    "settings.set round-trip arbitrary key",
    async () => {
      await h!.call("settings.set", { syncIntervalMs: 60_000 });
      const cfg: any = await h!.call("settings.get");
      if (cfg.syncIntervalMs !== 60_000) {
        throw new Error(`round-trip failed: ${JSON.stringify(cfg)}`);
      }
      return cfg;
    },
  );
  // Theme
  await checkOk(
    "theme.set/get round-trip",
    async () => {
      await h!.call("theme.set", { theme: "dark" });
      const v: any = await h!.call("theme.get");
      if (v.preference !== "dark") throw new Error(`got ${JSON.stringify(v)}`);
      return v;
    },
  );
  await checkThrows(
    "theme.set invalid",
    () => h!.call("theme.set", { theme: "neon" }),
    /invalid preference/,
  );
  await checkThrows(
    "settings.validateApiKey missing",
    () => h!.call("settings.validateApiKey", {}),
    /requires \{ apiKey: string \}/,
  );

  // ─── Compose: send + saved local draft restore ─────────────
  console.log("\n── Compose: send + local drafts\n");
  await checkThrows(
    "compose.send missing accountId",
    () => h!.call("compose.send", {}),
    /requires \{ accountId \}/,
  );
  await checkThrows(
    "compose.send missing to",
    () => h!.call("compose.send", { accountId: acct, to: [] }),
    /requires \{ to \}/,
  );
  await checkThrows(
    "compose.send unknown account",
    () =>
      h!.call("compose.send", {
        accountId: "no-such",
        to: ["a@example.com"],
        subject: "x",
        bodyText: "x",
      }),
    /not found/,
  );

  // Local drafts CRUD
  await checkOk(
    "compose.listLocalDrafts empty",
    () => h!.call<unknown[]>("compose.listLocalDrafts"),
    (v) => (Array.isArray(v) && v.length === 0 ? null : `expected []; got ${JSON.stringify(v)}`),
  );
  let draftId = "";
  await checkOk(
    "compose.saveLocalDraft creates row",
    async () => {
      const d: any = await h!.call("compose.saveLocalDraft", {
        accountId: acct,
        to: ["bob@example.com"],
        subject: "Hello",
        bodyHtml: "<p>Hi</p>",
        bodyText: "Hi",
      });
      draftId = d.id;
      return d;
    },
  );
  await checkOk(
    "compose.listLocalDrafts has 1",
    () => h!.call<unknown[]>("compose.listLocalDrafts"),
    (v) => (Array.isArray(v) && v.length === 1 ? null : `expected 1; got ${JSON.stringify(v)}`),
  );
  await checkOk(
    "compose.updateLocalDraft",
    () => h!.call("compose.updateLocalDraft", { id: draftId, subject: "Hello (edited)" }),
  );
  await checkOk(
    "compose.deleteLocalDraft",
    () => h!.call("compose.deleteLocalDraft", { id: draftId }),
  );
  await checkOk(
    "compose.getSendAsAliases",
    () => h!.call("compose.getSendAsAliases"),
    (v: any) => (Array.isArray(v?.aliases) ? null : "missing aliases array"),
  );
  await checkThrows(
    "compose.saveLocalDraft missing accountId",
    () => h!.call("compose.saveLocalDraft", {}),
    /requires \{ accountId \}/,
  );
  await checkThrows(
    "compose.deleteLocalDraft missing id",
    () => h!.call("compose.deleteLocalDraft", {}),
    /requires \{ id \}/,
  );
  await checkThrows(
    "compose.updateLocalDraft missing id",
    () => h!.call("compose.updateLocalDraft", {}),
    /requires \{ id \}/,
  );

  // ─── Snippets / Splits / Snooze / Memory ──────────────────
  console.log("\n── Snippets / Splits / Snooze / Memory\n");
  await checkOk("snippets.getAll empty", () => h!.call<unknown[]>("snippets.getAll"));
  await checkOk(
    "snippets.create",
    () => h!.call("snippets.create", { snippet: { name: "Sig", body: "Cheers, me" } }),
    (v: any) => (v && typeof v.id === "string" ? null : "missing id"),
  );
  await checkOk("snippets.getAll has 1", () => h!.call<unknown[]>("snippets.getAll"),
    (v) => (Array.isArray(v) && v.length === 1 ? null : `expected 1; got ${JSON.stringify(v)}`),
  );
  await checkThrows(
    "snippets.delete missing id",
    () => h!.call("snippets.delete", {}),
    /missing id/,
  );
  await checkThrows(
    "snippets.update unknown id",
    () => h!.call("snippets.update", { id: "no-such", updates: { name: "x" } }),
    /not found/,
  );

  await checkOk("splits.getAll empty", () => h!.call<unknown[]>("splits.getAll"));
  await checkOk(
    "splits.create",
    () =>
      h!.call("splits.create", {
        split: { accountId: acct, name: "Red", query: "from:red" },
      }),
  );
  await checkThrows(
    "splits.update missing id",
    () => h!.call("splits.update", { updates: { name: "X" } }),
    /missing id/,
  );

  await checkOk(
    "snooze.list empty",
    () => h!.call("snooze.list", { accountId: acct }),
    (v: any) => (Array.isArray(v?.data) ? null : "missing data array"),
  );
  await checkThrows(
    "snooze.snooze missing args",
    () => h!.call("snooze.snooze", {}),
    /requires \{ emailId, threadId, accountId, snoozeUntil \}/,
  );
  await checkOk(
    "snooze.snooze + unsnooze round-trip",
    async () => {
      const r: any = await h!.call("snooze.snooze", {
        emailId: e1,
        threadId: e1,
        accountId: acct,
        snoozeUntil: Date.now() + 60_000,
      });
      const list: any = await h!.call("snooze.list", { accountId: acct });
      if (list.data.length !== 1) throw new Error(`expected 1 snooze, got ${list.data.length}`);
      await h!.call("snooze.unsnooze", { threadId: e1, accountId: acct });
      const after: any = await h!.call("snooze.list", { accountId: acct });
      if (after.data.length !== 0) throw new Error(`expected 0 after, got ${after.data.length}`);
      return r;
    },
  );
  await checkThrows(
    "snooze.unsnooze missing args",
    () => h!.call("snooze.unsnooze", {}),
    /requires \{ threadId, accountId \}/,
  );

  // Memory: requires accountId
  await checkThrows(
    "memory.list missing accountId",
    () => h!.call("memory.list", {}),
    /missing accountId/,
  );
  await checkOk(
    "memory.list with accountId empty",
    () => h!.call<unknown[]>("memory.list", { accountId: acct }),
    (v) => (Array.isArray(v) && v.length === 0 ? null : `expected []; got ${JSON.stringify(v)}`),
  );
  await checkThrows(
    "memory.categories missing accountId",
    () => h!.call("memory.categories", {}),
    /missing accountId/,
  );
  await checkOk(
    "memory.categories with accountId empty",
    () => h!.call("memory.categories", { accountId: acct }),
  );
  await checkThrows(
    "memory.save missing scope",
    () => h!.call("memory.save", { accountId: acct, content: "x" }),
    /missing scope/,
  );
  await checkOk(
    "memory.save full",
    () =>
      h!.call("memory.save", {
        accountId: acct,
        scope: "global",
        content: "Use formal tone",
        scopeValue: null,
      }),
  );
  await checkThrows(
    "draftMemory.list missing accountId",
    () => h!.call("draftMemory.list", {}),
    /missing accountId/,
  );
  await checkOk(
    "draftMemory.list empty",
    () => h!.call<unknown[]>("draftMemory.list", { accountId: acct }),
    (v) => (Array.isArray(v) && v.length === 0 ? null : `expected []; got ${JSON.stringify(v)}`),
  );
  await checkThrows(
    "draftMemory.promote stub",
    () => h!.call("draftMemory.promote"),
    /not yet wired/,
  );

  // ─── search / contacts ─────────────────────────────────────
  console.log("\n── Search + contacts\n");
  await checkOk(
    "search.query basic",
    () => h!.call<unknown[]>("search.query", { query: "hello" }),
    (v) => (Array.isArray(v) ? null : "expected array"),
  );
  await checkOk(
    "search.query empty",
    () => h!.call<unknown[]>("search.query", { query: "" }),
    (v) => (Array.isArray(v) && v.length === 0 ? null : `expected []; got ${JSON.stringify(v)}`),
  );
  await checkOk(
    "search.suggestions",
    () => h!.call("search.suggestions", { query: "boss" }),
  );
  await checkOk(
    "search.rebuildIndex",
    () => h!.call("search.rebuildIndex"),
  );
  await checkOk(
    "contacts.suggest",
    () => h!.call("contacts.suggest", { query: "alice" }),
  );

  // ─── DB / theme / network ────────────────────────────────
  console.log("\n── DB / theme / network\n");
  await checkOk("db.info", () => h!.call("db.info"));
  await checkOk("db.listAccounts", () => h!.call("db.listAccounts"));
  await checkOk("network.updateStatus", () => h!.call("network.updateStatus"));
  await checkOk(
    "network.setOffline (no offline param honored — see report)",
    () => h!.call("network.setOffline", { offline: true }),
    (v: any) => (typeof v.online === "boolean" ? null : "missing online flag"),
  );
  await checkOk(
    "network.setOffline (no params)",
    () => h!.call("network.setOffline"),
  );

  // ─── Account CRUD ────────────────────────────────────────
  console.log("\n── Account CRUD\n");
  await checkOk(
    "accounts.list returns seeded accts",
    () => h!.call<unknown[]>("accounts.list"),
    (v) => (Array.isArray(v) && v.length >= 1 ? null : `expected ≥1; got ${JSON.stringify(v)}`),
  );
  await checkThrows(
    "accounts.remove missing accountId",
    () => h!.call("accounts.remove", {}),
    /requires \{ accountId \}/,
  );
  await checkThrows(
    "accounts.setPrimary missing accountId",
    () => h!.call("accounts.setPrimary", {}),
    /requires \{ accountId \}/,
  );

  await h.close();

  // ─── Summary ───────────────────────────────────────────────
  console.log("\n=== summary ===");
  const counts = { ok: 0, broken: 0, slow: 0, weird: 0 };
  for (const f of findings) counts[f.status] += 1;
  console.log(`ok=${counts.ok} broken=${counts.broken} slow=${counts.slow} weird=${counts.weird}`);

  // Dump JSON for the report
  console.log("\n=== JSON ===");
  console.log(JSON.stringify(findings, null, 2));
}

main().catch((err) => {
  console.error("debug-pass FATAL:", err);
  process.exit(1);
});
