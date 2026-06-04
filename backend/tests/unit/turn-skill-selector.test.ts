import { describe, expect, it } from "vitest";

import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import type { TurnSelectionStrategy } from "../../src/modules/chat/services/turnSelectionStrategy.js";
import { ChatTurnSkillSelector } from "../../src/modules/chat/services/turnSkillSelector.js";

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

const strategy: TurnSelectionStrategy = {
  select: () => ["retrieval"],
};

describe("ChatTurnSkillSelector", () => {
  const retrieval = skillStub("retrieval.answer", (s) => s.turnRoute === "retrieval");
  const social = skillStub("social_only.answer", (s) => s.turnRoute === "social_only");
  const selector = new ChatTurnSkillSelector([retrieval, social], strategy);

  it("resolves the terminal skill whose selects() claims the prepared turn", () => {
    expect(selector.resolveSkill(session("social_only"))).toBe(social);
    expect(selector.resolveSkill(session("retrieval"))).toBe(retrieval);
  });

  it("falls back to the first registered skill when none claims the turn", () => {
    expect(selector.resolveSkill(session("unrecognized"))).toBe(retrieval);
  });

  it("produces the engine-shaped decision naming the resolved skill", () => {
    const { skill, decision } = selector.select(session("social_only"));
    expect(skill).toBe(social);
    expect(decision.selected).toEqual([
      { skillName: "social_only.answer", reason: "turn_selection_strategy" },
    ]);
    // The path-layer strategy informs the reason, not which skill is chosen.
    expect(decision.reason).toBe("candidates:retrieval");
  });

  it("throws when no terminal skill is registered", () => {
    const empty = new ChatTurnSkillSelector([], strategy);
    expect(() => empty.resolveSkill(session("retrieval"))).toThrow("chat_no_turn_skill_registered");
  });
});
