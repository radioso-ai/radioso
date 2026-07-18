import { describe, expect, it, vi } from "vitest";

import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import type { TurnSelectionStrategy } from "../../src/modules/chat/services/turnSelectionStrategy.js";
import { ChatTurnSkillSelector, filterAutonomousTurnSkills } from "../../src/modules/chat/services/turnSkillSelector.js";

// The single seam that decides which terminal skill claims a prepared turn (#507
// slice 2). Both the conversation engine (via its ConversationSkillSelector) and
// the host streaming/non-streaming paths route through it, so streamed and
// non-streamed turns select identically rather than re-deriving turnSkills.find.

const skillStub = (name: string, claims: (session: PreparedSession) => boolean): TurnSkill => ({
  definition: { name, outcomeKinds: [name] },
  selects: claims,
  dispatch: () => {
    throw new Error("dispatch not used in selector tests");
  },
  renderer: {
    supports: () => false,
    render: async () => {
      throw new Error("render not used in selector tests");
    },
  },
});

const session = (turnRoute: string): PreparedSession =>
  ({
    turnRoute,
    directiveSteering: { rules: [], matches: [], omissions: [] },
  }) as unknown as PreparedSession;

const sessionWithBoundDirective = (turnRoute: string, skillName = "order.lookup"): PreparedSession =>
  ({
    turnRoute,
    directiveSteering: {
      rules: [{ action: "Look up the order.", source: "directive", lifespan: "response" }],
      omissions: [],
      matches: [{
        directive: {
          name: "order-status",
          condition: { kind: "always" },
          action: "Look up the order.",
          binding: { kind: "skill", skillName },
        },
        selectionMode: "deterministic",
        selectionReason: "always",
      }],
    },
  }) as unknown as PreparedSession;

const strategy: TurnSelectionStrategy = {
  select: () => ["retrieval"],
};

describe("ChatTurnSkillSelector", () => {
  const retrieval = skillStub("retrieval.answer", (s) => s.turnRoute === "retrieval");
  const social = skillStub("direct.answer", (s) => s.turnRoute === "direct");
  const selector = new ChatTurnSkillSelector([retrieval, social], strategy);

  it("resolves the terminal skill whose selects() claims the prepared turn", () => {
    expect(selector.resolveSkill(session("direct"))).toBe(social);
    expect(selector.resolveSkill(session("retrieval"))).toBe(retrieval);
  });

  it("falls back to the first registered skill when none claims the turn", () => {
    expect(selector.resolveSkill(session("unrecognized"))).toBe(retrieval);
  });

  it("produces the engine-shaped decision naming the resolved skill", () => {
    const { skill, decision } = selector.select(session("direct"));
    expect(skill).toBe(social);
    expect(decision.selected).toEqual([
      { skillName: "direct.answer", reason: "turn_selection_strategy" },
    ]);
    // The path-layer strategy informs the reason, not which skill is chosen.
    expect(decision.reason).toBe("candidates:retrieval");
  });

  it("routes to a bound directive skill before default selects() ordering", () => {
    const defaultAnswer = skillStub("retrieval.answer", () => true);
    const orderLookup = skillStub("order.lookup", () => false);
    const boundSelector = new ChatTurnSkillSelector([defaultAnswer, orderLookup], strategy, {
      agentSkillStates: new Map([
        ["order.lookup", { enabled: true, turnCapable: true }],
      ]),
    });

    const { skill, decision } = boundSelector.select(sessionWithBoundDirective("retrieval"));

    expect(skill).toBe(orderLookup);
    expect(decision.selected).toEqual([
      {
        skillName: "order.lookup",
        reason: "directive:order-status",
        metadata: {
          directiveBinding: {
            directiveName: "order-status",
            skillName: "order.lookup",
            outcome: "selected",
            reason: "selected",
          },
        },
      },
    ]);
    expect(decision.reason).toBe("directive:order-status");
    expect(decision.considered).toEqual([
      {
        skillName: "order.lookup",
        selected: true,
        reason: "directive:order-status",
        metadata: {
          directiveBinding: {
            directiveName: "order-status",
            skillName: "order.lookup",
            outcome: "selected",
            reason: "selected",
          },
        },
      },
    ]);
  });

  it("lets a forced skill override directive bindings for host-owned terminal turns", () => {
    const defaultAnswer = skillStub("retrieval.answer", () => true);
    const clarification = skillStub("clarification.answer", () => false);
    const orderLookup = skillStub("order.lookup", () => false);
    const boundSelector = new ChatTurnSkillSelector([clarification, defaultAnswer, orderLookup], strategy, {
      agentSkillStates: new Map([
        ["order.lookup", { enabled: true, turnCapable: true }],
      ]),
      forceSkillName: () => "clarification.answer",
    });

    const { skill, decision } = boundSelector.select(sessionWithBoundDirective("retrieval"));

    expect(skill).toBe(clarification);
    expect(decision.selected).toEqual([
      { skillName: "clarification.answer", reason: "forced_turn_skill" },
    ]);
    expect(decision.reason).toBe("forced_turn_skill");
  });

  it("preserves default behavior when no matched directive has a binding", () => {
    const { skill, decision } = selector.select(session("direct"));

    expect(skill).toBe(social);
    expect(decision.selected).toEqual([
      { skillName: "direct.answer", reason: "turn_selection_strategy" },
    ]);
  });

  it("records losing directive bindings in selection considerations", () => {
    const defaultAnswer = skillStub("retrieval.answer", () => true);
    const orderLookup = skillStub("order.lookup", () => false);
    const escalation = skillStub("escalate.lookup", () => false);
    const boundSelector = new ChatTurnSkillSelector([defaultAnswer, orderLookup, escalation], strategy);
    const prepared = sessionWithBoundDirective("retrieval");
    prepared.directiveSteering!.matches.push({
      directive: {
        name: "escalation",
        condition: { kind: "always" },
        action: "Escalate.",
        priority: 10,
        binding: { kind: "skill", skillName: "escalate.lookup" },
      },
      selectionMode: "deterministic",
      selectionReason: "always",
    });

    const { decision } = boundSelector.select(prepared);

    expect(decision.reason).toBe("directive:order-status");
    expect(decision.considered).toEqual([
      expect.objectContaining({
        skillName: "order.lookup",
        selected: true,
        reason: "directive:order-status",
      }),
      {
        skillName: "escalate.lookup",
        selected: false,
        reason: "lost_conflict",
        metadata: {
          directiveBinding: {
            directiveName: "escalation",
            skillName: "escalate.lookup",
            outcome: "lost_conflict",
            reason: "lost_conflict",
          },
        },
      },
    ]);
  });

  it("falls through when a bound skill is unavailable and leaves directive steering intact", () => {
    const logger = { warn: vi.fn() };
    const defaultAnswer = skillStub("retrieval.answer", () => true);
    const boundSelector = new ChatTurnSkillSelector([defaultAnswer], strategy, {
      agentSkillStates: new Map([
        ["order.lookup", { enabled: false, turnCapable: true }],
      ]),
      logger,
    });
    const prepared = sessionWithBoundDirective("retrieval");

    const { skill, decision } = boundSelector.select(prepared);

    expect(skill).toBe(defaultAnswer);
    expect(prepared.directiveSteering?.rules).toEqual([
      { action: "Look up the order.", source: "directive", lifespan: "response" },
    ]);
    expect(decision.selected).toEqual([
      { skillName: "retrieval.answer", reason: "turn_selection_strategy" },
    ]);
    expect(decision.considered).toEqual([
      {
        skillName: "order.lookup",
        selected: false,
        reason: "skill_not_enabled",
        metadata: {
          directiveBinding: {
            directiveName: "order-status",
            skillName: "order.lookup",
            outcome: "skipped",
            reason: "skill_not_enabled",
          },
        },
      },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: "directive_binding_skipped",
        workspaceId: undefined,
        agentId: undefined,
        conversationId: undefined,
        directiveName: "order-status",
        skillName: "order.lookup",
        reason: "skill_not_enabled",
      },
      "Directive skill binding skipped",
    );
  });

  it("throws when no terminal skill is registered", () => {
    const empty = new ChatTurnSkillSelector([], strategy);
    expect(() => empty.resolveSkill(session("retrieval"))).toThrow("chat_no_turn_skill_registered");
  });

  it("only exposes agent-selectable skills for autonomous selection", () => {
    const defaultAnswer = skillStub("answer", () => true);
    const routineNamed = skillStub("retrieve_events", () => true);
    const agentSelectable = skillStub("lookup_policy", () => true);

    expect(filterAutonomousTurnSkills([
      { skill: defaultAnswer, invocationMode: "default_answer" },
      { skill: routineNamed, invocationMode: "routine_named" },
      { skill: agentSelectable, invocationMode: "agent_selectable" },
    ])).toEqual([agentSelectable]);
  });
});
