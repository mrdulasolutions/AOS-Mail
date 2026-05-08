// `learnedRules` IPC namespace.
//
// Surfaces the learned-rules engine to the renderer (Settings → Agent
// Tools → Learned Rules card). The engine itself lives in
// services/learned-rules.ts; this file is a thin RPC shell.
//
// Methods:
//   learnedRules.list({ accountId? })           — snapshot for the UI
//   learnedRules.toggle({ ruleId, enabled })    — enable/disable in-place
//   learnedRules.reset({ accountId? })          — wipe everything
//
// Test-only methods (gated by LEARNED_RULES_TEST_HOOKS=1):
//   learnedRules.devRecordOverride       — drive an override directly
//   learnedRules.devFindApplicable       — query the rule lookup
//
// The dev methods exist because the production override path runs
// after a real provider archive (which needs Gmail/IMAP credentials),
// so a unit test can't drive the engine through that path.
//
// We use a dedicated env var (rather than AOS_TEST_MODE) because
// AOS_TEST_MODE also changes the DB filename to aos-mail-demo.db
// and the test harness's seed helpers assume the production path.
// LEARNED_RULES_TEST_HOOKS only opens the dev RPC methods.

import { registerMethod } from "../rpc.js";
import {
  listLearnedRules,
  toggleLearnedRule,
  resetLearnedRules,
  recordOverride,
  findApplicableRules,
  type LearnedAction,
} from "../services/learned-rules.js";

export function registerLearnedRulesMethods(): void {
  registerMethod("learnedRules.list", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    return { rules: listLearnedRules(accountId) };
  });

  registerMethod("learnedRules.toggle", (params) => {
    const { ruleId, enabled } =
      (params as { ruleId?: string; enabled?: boolean }) ?? {};
    if (!ruleId) throw new Error("learnedRules.toggle: requires { ruleId }");
    if (typeof enabled !== "boolean") {
      throw new Error("learnedRules.toggle: requires { enabled: boolean }");
    }
    const rule = toggleLearnedRule(ruleId, enabled);
    if (!rule) throw new Error(`learnedRules.toggle: rule not found: ${ruleId}`);
    return { rule };
  });

  registerMethod("learnedRules.reset", (params) => {
    const { accountId } = (params as { accountId?: string }) ?? {};
    return resetLearnedRules(accountId);
  });

  // ----- Test-only hooks -----

  if (process.env.LEARNED_RULES_TEST_HOOKS === "1") {
    registerMethod("learnedRules.devRecordOverride", async (params) => {
      const { emailId, accountId, action } =
        (params as { emailId?: string; accountId?: string; action?: LearnedAction }) ?? {};
      if (!emailId || !accountId || !action) {
        throw new Error(
          "learnedRules.devRecordOverride: requires { emailId, accountId, action }",
        );
      }
      return recordOverride({
        emailId,
        accountId,
        override: {
          from: { needsReply: true, priority: "medium" },
          to: { needsReply: false, priority: null },
          action,
        },
      });
    });

    registerMethod("learnedRules.devFindApplicable", (params) => {
      const { accountId, from } = (params as { accountId?: string; from?: string }) ?? {};
      if (!accountId || !from) {
        throw new Error("learnedRules.devFindApplicable: requires { accountId, from }");
      }
      const matches = findApplicableRules({ email: { accountId, from } });
      return {
        matches: matches.map((m) => ({
          ruleId: m.rule.id,
          scope: m.rule.scope,
          scopeValue: m.rule.scopeValue,
          action: m.rule.action,
          count: m.rule.count,
          reason: m.analysis.reason,
        })),
      };
    });
  }
}
