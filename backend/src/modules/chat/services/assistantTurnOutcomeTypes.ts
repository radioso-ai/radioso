export const ASSISTANT_TURN_OUTCOME = {
  GROUNDED_SUCCESS: "grounded_success",
  NO_CONTEXT_REFUSAL: "no_context_refusal",
  NON_RETRIEVAL_RESPONSE: "non_retrieval_response",
} as const;

export type AssistantTurnOutcome = (typeof ASSISTANT_TURN_OUTCOME)[keyof typeof ASSISTANT_TURN_OUTCOME];

export type SkillTurnStatus =
  | "active"
  | "paused"
  | "awaiting_confirmation"
  | "awaiting_tool"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export interface SkillTurnOutcome {
  skillName: string;
  outcome: string;
  status: SkillTurnStatus;
}

/**
 * Why a turn declined to answer.
 *
 * `content_gap` — the request is the kind of thing this agent covers and nothing
 * supported an answer. Actionable: an operator can close it by ingesting content.
 * `out_of_scope` — the request falls outside the agent's configured remit, so
 * declining is correct behavior rather than a defect.
 * `generation_unavailable` — the system could not obtain a usable model-authored
 * reply. Ingesting content cannot fix a missing model configuration or provider
 * failure, so this must not enter the grounding-gap queue.
 *
 * `content_gap` is the default. `out_of_scope` requires positive evidence from the
 * classifying model, so an unclassifiable decline counts against the agent rather
 * than being silently excluded from its quality numbers.
 */
export type TurnDeclineReason = "content_gap" | "out_of_scope" | "generation_unavailable";

export const SKILL_TURN_OUTCOME = {
  ASSISTANT_CONVERSATIONAL: {
    skillName: "assistant.chat",
    outcome: "conversational",
    status: "completed",
  },
  RETRIEVAL_GROUNDED: {
    skillName: "retrieval.answer",
    outcome: "grounded",
    status: "completed",
  },
  RETRIEVAL_GROUNDED_DEGRADED: {
    skillName: "retrieval.answer",
    outcome: "grounded_degraded",
    status: "completed",
  },
  RETRIEVAL_NO_CONTEXT: {
    skillName: "retrieval.answer",
    outcome: "no_context",
    status: "completed",
  },
  RETRIEVAL_OUT_OF_SCOPE: {
    skillName: "retrieval.answer",
    outcome: "out_of_scope",
    status: "completed",
  },
  RETRIEVAL_UNAVAILABLE: {
    skillName: "retrieval.answer",
    outcome: "unavailable",
    status: "failed",
  },
} as const satisfies Record<string, SkillTurnOutcome>;

export const legacyAnswerOutcomeForSkillTurnOutcome = (
  skillTurnOutcome: SkillTurnOutcome,
): AssistantTurnOutcome | undefined => {
  if (
    skillTurnOutcome.skillName === "retrieval.answer"
    && (skillTurnOutcome.outcome === "grounded" || skillTurnOutcome.outcome === "grounded_degraded")
  ) {
    // The legacy answer_outcome enum has no degraded value; both grounded variants
    // collapse to grounded_success there. The skill_outcome column carries the
    // finer distinction (and is what the Quality dashboard filters on).
    return ASSISTANT_TURN_OUTCOME.GROUNDED_SUCCESS;
  }
  if (
    skillTurnOutcome.skillName === "retrieval.answer"
    && (skillTurnOutcome.outcome === "no_context" || skillTurnOutcome.outcome === "out_of_scope")
  ) {
    // The legacy answer_outcome enum has no out-of-scope value; both declines
    // collapse to the coarse refusal there. The skill_outcome column carries the
    // finer distinction, which is what the Quality dashboard filters on.
    return ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL;
  }
  if (skillTurnOutcome.skillName === "assistant.chat" && skillTurnOutcome.outcome === "conversational") {
    return ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE;
  }
  return undefined;
};

export const skillTurnOutcomeFromLegacyAnswerOutcome = (
  answerOutcome: AssistantTurnOutcome | undefined,
): SkillTurnOutcome | undefined => {
  if (answerOutcome === ASSISTANT_TURN_OUTCOME.GROUNDED_SUCCESS) {
    return { ...SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED };
  }
  if (answerOutcome === ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL) {
    // A legacy row cannot say which decline it was, so it stays the conservative one.
    return { ...SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT };
  }
  if (answerOutcome === ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE) {
    return { ...SKILL_TURN_OUTCOME.ASSISTANT_CONVERSATIONAL };
  }
  return undefined;
};
