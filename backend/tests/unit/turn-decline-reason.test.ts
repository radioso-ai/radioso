import { describe, expect, it } from "vitest";

import {
  ASSISTANT_TURN_OUTCOME,
  SKILL_TURN_OUTCOME,
  legacyAnswerOutcomeForSkillTurnOutcome,
  skillTurnOutcomeFromLegacyAnswerOutcome,
} from "../../src/modules/chat/services/assistantTurnOutcomeTypes.js";
import { retrievalAnswerSkillDefinition } from "../../src/modules/skills/public.js";

describe("out-of-scope turn outcome vocabulary", () => {
  it("names the out-of-scope decline as its own retrieval.answer outcome", () => {
    expect(SKILL_TURN_OUTCOME.RETRIEVAL_OUT_OF_SCOPE).toEqual({
      skillName: "retrieval.answer",
      outcome: "out_of_scope",
      status: "completed",
    });
  });

  it("collapses the out-of-scope decline onto the coarse legacy refusal value", () => {
    expect(legacyAnswerOutcomeForSkillTurnOutcome(SKILL_TURN_OUTCOME.RETRIEVAL_OUT_OF_SCOPE)).toBe(
      ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL,
    );
  });

  it("still maps the legacy refusal value back to no_context, which is all legacy can know", () => {
    expect(skillTurnOutcomeFromLegacyAnswerOutcome(ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL)).toEqual(
      SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT,
    );
  });
});

describe("retrieval.answer catalog", () => {
  const outcomeNamed = (name: string) =>
    retrievalAnswerSkillDefinition.outcomes?.find((outcome) => outcome.name === name);

  it("declares out_of_scope as a completed outcome that omits the grounded-answer flag", () => {
    const outcome = outcomeNamed("out_of_scope");

    expect(outcome).toBeDefined();
    expect(outcome?.status).toBe("completed");
    expect(outcome && "groundedAnswer" in outcome).toBe(false);
  });

  it("keeps no_context as the grounding gap", () => {
    expect(outcomeNamed("no_context")?.groundedAnswer).toBe(false);
  });

  it("declares generation unavailability as a failed non-gap outcome", () => {
    expect(SKILL_TURN_OUTCOME.RETRIEVAL_UNAVAILABLE).toEqual({
      skillName: "retrieval.answer",
      outcome: "unavailable",
      status: "failed",
    });
    expect(legacyAnswerOutcomeForSkillTurnOutcome(SKILL_TURN_OUTCOME.RETRIEVAL_UNAVAILABLE)).toBeUndefined();

    const outcome = outcomeNamed("unavailable");
    expect(outcome?.status).toBe("failed");
    expect(outcome && "groundedAnswer" in outcome).toBe(false);
  });
});
