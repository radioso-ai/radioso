import {
  ASSISTANT_TURN_OUTCOME,
  DEFAULT_UNSUPPORTED_NOTICE,
  type AnswerValidationSummary,
  type AssistantTurnOutcome,
} from "./answerSupportValidationTypes.js";

export {
  ASSISTANT_TURN_OUTCOME,
  DEFAULT_UNSUPPORTED_NOTICE,
} from "./answerSupportValidationTypes.js";

export class AssistantTurnOutcomeClassifier {
  classify(input: {
    hadRetrievedContext: boolean;
    validation: AnswerValidationSummary;
  }): AssistantTurnOutcome {
    if (!input.hadRetrievedContext) {
      return ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL;
    }

    if (input.validation.unsupportedSegmentCount > 0) {
      return ASSISTANT_TURN_OUTCOME.GROUNDED_DEGRADED_UNSUPPORTED_SEGMENTS;
    }

    return ASSISTANT_TURN_OUTCOME.GROUNDED_SUCCESS;
  }
}
