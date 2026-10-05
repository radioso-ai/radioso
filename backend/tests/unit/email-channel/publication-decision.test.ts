import type { ConnectorTurnFacts, ConnectorTurnResult } from "@radioso/connector-api";
import { describe, expect, it } from "vitest";

import {
  decidePublication,
  type PublicationDecisionInput,
} from "../../../src/modules/connectors/plugins/email/emailPublicationDecision.js";
import type { EngagementMode } from "../../../src/modules/emailChannel/public.js";

const conversationId = "11111111-1111-4111-8111-111111111111";

const publishableFacts: ConnectorTurnFacts = {
  outcome: "answered",
  grounding: "grounded",
  coverage: "answered",
  handoff: { requested: false },
  suppressedEffects: [],
  citationCount: 2,
};

const draftTurn = (facts: Partial<ConnectorTurnFacts> = {}): ConnectorTurnResult => ({
  kind: "draft",
  conversationId,
  ownershipVersion: 3,
  facts: { ...publishableFacts, ...facts },
  draft: { text: "Your order ships on Monday.", presentation: {} },
});

/** Every gate open: an `auto` mailbox, a publishable turn, budget room, sending ready, authority unchanged. */
const input = (overrides: Partial<PublicationDecisionInput> = {}): PublicationDecisionInput => ({
  effectiveMode: "auto",
  turn: draftTurn(),
  sendBudget: { used: 0, limit: 3 },
  bound: { ownershipVersion: 3, policyVersion: 7 },
  current: { ownershipVersion: 3, policyVersion: 7 },
  sendingReady: true,
  ...overrides,
});

describe("decidePublication", () => {
  it("publishes only when every gate is open", () => {
    expect(decidePublication(input())).toEqual({ kind: "publish" });
  });

  describe("results without a draft", () => {
    it("does nothing for a human-owned conversation, whatever else holds", () => {
      const decision = decidePublication(input({
        turn: { kind: "human_owned", conversationId, ownershipVersion: 4 },
        current: { ownershipVersion: 4, policyVersion: 8 },
        sendingReady: false,
      }));
      expect(decision).toEqual({ kind: "no_draft", handoffReason: null });
    });

    it("hands a draftless turn off with the reason the engine gave", () => {
      const decision = decidePublication(input({
        turn: { kind: "no_draft", conversationId, ownershipVersion: 3, facts: { ...publishableFacts, handoff: { requested: true, reason: "customer_requested_human" } } },
      }));
      expect(decision).toEqual({ kind: "no_draft", handoffReason: "customer_requested_human" });
    });

    it("hands a draftless turn with no engine reason off as review_unavailable", () => {
      const decision = decidePublication(input({
        turn: { kind: "no_draft", conversationId, ownershipVersion: 3, facts: { ...publishableFacts, outcome: "unavailable" } },
      }));
      expect(decision).toEqual({ kind: "no_draft", handoffReason: "review_unavailable" });
    });
  });

  describe("the order of the holds (ports §6e)", () => {
    // Each row closes one gate and every gate after it; the first closed gate names the reason.
    it.each([
      ["ownership moved", { current: { ownershipVersion: 4, policyVersion: 7 } }, "authority_changed"],
      ["the policy moved", { current: { ownershipVersion: 3, policyVersion: 8 } }, "authority_changed"],
      ["sending is not verified", { sendingReady: false }, "sending_not_verified"],
      ["the mailbox drafts", { effectiveMode: "draft" as EngagementMode }, "draft_mode"],
      ["the thread budget is spent", { sendBudget: { used: 3, limit: 3 } }, "send_budget"],
      ["the turn is not publishable", { turn: draftTurn({ coverage: "partial" }) }, "outcome_not_publishable"],
    ] as const)("holds with the first closed gate's reason when %s", (_label, closed, reason) => {
      expect(decidePublication(input(closed))).toEqual({ kind: "hold", reason });
    });

    it("lets authority win over every later gate", () => {
      const decision = decidePublication(input({
        current: { ownershipVersion: 9, policyVersion: 7 },
        sendingReady: false,
        effectiveMode: "draft",
        sendBudget: { used: 5, limit: 3 },
        turn: draftTurn({ grounding: "unknown" }),
      }));
      expect(decision).toEqual({ kind: "hold", reason: "authority_changed" });
    });

    it("lets unverified sending win over the mailbox mode (FR-004)", () => {
      const decision = decidePublication(input({ sendingReady: false, effectiveMode: "draft", sendBudget: { used: 3, limit: 3 } }));
      expect(decision).toEqual({ kind: "hold", reason: "sending_not_verified" });
    });

    it("lets the mailbox mode win over the budget and the outcome", () => {
      const decision = decidePublication(input({ effectiveMode: "draft", sendBudget: { used: 3, limit: 3 }, turn: draftTurn({ coverage: "unanswered" }) }));
      expect(decision).toEqual({ kind: "hold", reason: "draft_mode" });
    });

    it("lets the budget win over the outcome", () => {
      const decision = decidePublication(input({ sendBudget: { used: 4, limit: 3 }, turn: draftTurn({ grounding: "ungrounded" }) }));
      expect(decision).toEqual({ kind: "hold", reason: "send_budget" });
    });

    it("holds an operator_only mailbox's draft as draft_mode, never publishing it", () => {
      expect(decidePublication(input({ effectiveMode: "operator_only" }))).toEqual({ kind: "hold", reason: "draft_mode" });
    });
  });

  describe("the auto rows of the outcome table (spec.md, Engagement Outcome Table)", () => {
    const humanOwned: ConnectorTurnResult = { kind: "human_owned", conversationId, ownershipVersion: 4 };
    const noDraft = (facts: Partial<ConnectorTurnFacts>): ConnectorTurnResult =>
      ({ kind: "no_draft", conversationId, ownershipVersion: 3, facts: { ...publishableFacts, ...facts } });

    it("publishes a grounded, complete, hand-off-free answer while the thread's send budget has room", () => {
      expect(decidePublication(input({ sendBudget: { used: 2, limit: 3 } }))).toEqual({ kind: "publish" });
    });

    it.each([
      ["a grounded, complete answer", {}],
      ["a partial answer", { coverage: "partial" }],
      ["an answer without context", { outcome: "no_context", grounding: "ungrounded", coverage: "unanswered" }],
      ["an out-of-scope answer", { outcome: "out_of_scope", grounding: "not_applicable", coverage: "not_assessed" }],
      ["a hand-off with text", { handoff: { requested: true, reason: "billing_dispute" } }],
    ] as const)("holds %s as send_budget once the thread's budget is spent", (_label, facts) => {
      expect(decidePublication(input({ sendBudget: { used: 3, limit: 3 }, turn: draftTurn(facts) })))
        .toEqual({ kind: "hold", reason: "send_budget" });
    });

    it.each([
      ["partial", { coverage: "partial" }],
      ["no-context", { outcome: "no_context", grounding: "ungrounded", coverage: "unanswered" }],
      ["out-of-scope", { outcome: "out_of_scope", grounding: "not_applicable", coverage: "not_assessed" }],
      ["hand-off with text", { handoff: { requested: true, reason: "billing_dispute" } }],
      ["suppressed effect", { suppressedEffects: [{ skillName: "issue_refund" }] }],
      ["unclear coverage", { coverage: "unclear" }],
    ] as const)("holds a %s result as outcome_not_publishable with budget room", (_label, facts) => {
      expect(decidePublication(input({ turn: draftTurn(facts) }))).toEqual({ kind: "hold", reason: "outcome_not_publishable" });
    });

    it("hands a draftless result off on an auto mailbox, with or without budget room", () => {
      for (const sendBudget of [{ used: 0, limit: 3 }, { used: 3, limit: 3 }]) {
        expect(decidePublication(input({ sendBudget, turn: noDraft({ outcome: "unavailable", grounding: "unknown", coverage: "unavailable" }) })))
          .toEqual({ kind: "no_draft", handoffReason: "review_unavailable" });
        expect(decidePublication(input({ sendBudget, turn: noDraft({ handoff: { requested: true, reason: "customer_requested_human" } }) })))
          .toEqual({ kind: "no_draft", handoffReason: "customer_requested_human" });
      }
    });

    it("does nothing for a human-owned conversation on an auto mailbox", () => {
      expect(decidePublication(input({ turn: humanOwned, current: { ownershipVersion: 4, policyVersion: 7 } })))
        .toEqual({ kind: "no_draft", handoffReason: null });
    });

    it("holds a publishable answer as sending_not_verified on an auto mailbox whose domain cannot send (FR-004)", () => {
      expect(decidePublication(input({ sendingReady: false }))).toEqual({ kind: "hold", reason: "sending_not_verified" });
    });

    it("holds a publishable answer as authority_changed when a takeover or a policy change landed during the review", () => {
      expect(decidePublication(input({ current: { ownershipVersion: 4, policyVersion: 7 } }))).toEqual({ kind: "hold", reason: "authority_changed" });
      expect(decidePublication(input({ current: { ownershipVersion: 3, policyVersion: 8 } }))).toEqual({ kind: "hold", reason: "authority_changed" });
    });

    it("never publishes an auto mailbox's result when any one gate is closed", () => {
      const closed: Partial<PublicationDecisionInput>[] = [
        { sendBudget: { used: 3, limit: 3 } },
        { sendBudget: { used: 0, limit: 0 } },
        { sendingReady: false },
        { current: { ownershipVersion: 4, policyVersion: 7 } },
        { current: { ownershipVersion: 3, policyVersion: 8 } },
        { turn: draftTurn({ grounding: "unknown" }) },
        { turn: draftTurn({ coverage: "not_assessed" }) },
      ];
      for (const gate of closed) expect(decidePublication(input(gate)).kind).not.toBe("publish");
    });
  });

  describe("fail-closed outcome facts", () => {
    it.each([
      ["grounding ungrounded", { grounding: "ungrounded" }],
      ["grounding not applicable", { grounding: "not_applicable" }],
      ["grounding unknown", { grounding: "unknown" }],
      ["coverage partial", { coverage: "partial" }],
      ["coverage unanswered", { coverage: "unanswered" }],
      ["coverage unclear", { coverage: "unclear" }],
      ["coverage unavailable", { coverage: "unavailable" }],
      ["coverage not assessed", { coverage: "not_assessed" }],
      ["a hand-off the turn asked for", { handoff: { requested: true, reason: "billing_dispute" } }],
      ["a suppressed skill effect", { suppressedEffects: [{ skillName: "issue_refund" }] }],
    ] as const)("holds %s as outcome_not_publishable", (_label, facts) => {
      expect(decidePublication(input({ turn: draftTurn(facts) }))).toEqual({ kind: "hold", reason: "outcome_not_publishable" });
    });

    it("never reads the draft's text", () => {
      const guarded: ConnectorTurnResult = {
        kind: "draft",
        conversationId,
        ownershipVersion: 3,
        facts: publishableFacts,
        draft: Object.defineProperty({ presentation: {} }, "text", {
          get: () => {
            throw new Error("the publication decision read the draft text");
          },
        }) as { text: string; presentation: Record<string, unknown> },
      };
      expect(decidePublication(input({ turn: guarded }))).toEqual({ kind: "publish" });
    });
  });
});
