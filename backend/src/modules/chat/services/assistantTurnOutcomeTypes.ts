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
  RETRIEVAL_NO_CONTEXT: {
    skillName: "retrieval.answer",
    outcome: "no_context",
    status: "completed",
  },
} as const satisfies Record<string, SkillTurnOutcome>;

export const legacyAnswerOutcomeForSkillTurnOutcome = (
  skillTurnOutcome: SkillTurnOutcome,
): AssistantTurnOutcome | undefined => {
  if (skillTurnOutcome.skillName === "retrieval.answer" && skillTurnOutcome.outcome === "grounded") {
    return ASSISTANT_TURN_OUTCOME.GROUNDED_SUCCESS;
  }
  if (skillTurnOutcome.skillName === "retrieval.answer" && skillTurnOutcome.outcome === "no_context") {
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
    return { ...SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT };
  }
  if (answerOutcome === ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE) {
    return { ...SKILL_TURN_OUTCOME.ASSISTANT_CONVERSATIONAL };
  }
  return undefined;
};
