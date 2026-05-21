export const ASSISTANT_TURN_OUTCOME = {
  GROUNDED_SUCCESS: "grounded_success",
  NO_CONTEXT_REFUSAL: "no_context_refusal",
  NON_RETRIEVAL_RESPONSE: "non_retrieval_response",
} as const;

export type AssistantTurnOutcome = (typeof ASSISTANT_TURN_OUTCOME)[keyof typeof ASSISTANT_TURN_OUTCOME];
