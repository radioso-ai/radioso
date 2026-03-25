import type { AnswerSegment, ChatCitation } from "./answerPresentationService.js";

export const VALIDATION_DISPOSITION = {
  SUPPORTED: "supported",
  UNSUPPORTED: "unsupported",
  NON_SUBSTANTIVE: "non_substantive",
} as const;

export type ValidationDisposition = (typeof VALIDATION_DISPOSITION)[keyof typeof VALIDATION_DISPOSITION];

export const ASSISTANT_TURN_OUTCOME = {
  GROUNDED_SUCCESS: "grounded_success",
  GROUNDED_DEGRADED_UNSUPPORTED_SEGMENTS: "grounded_degraded_unsupported_segments",
  NO_CONTEXT_REFUSAL: "no_context_refusal",
} as const;

export type AssistantTurnOutcome = (typeof ASSISTANT_TURN_OUTCOME)[keyof typeof ASSISTANT_TURN_OUTCOME];

export const DEFAULT_UNSUPPORTED_NOTICE = "I couldn't verify that part from the retrieved documents.";

export interface AnswerValidationSummary {
  ran: boolean;
  answerModified: boolean;
  unsupportedSegmentCount: number;
  supportedSegmentCount: number;
  nonSubstantiveSegmentCount: number;
}

export interface AnswerSegmentValidationResult {
  originalText: string;
  text: string;
  disposition: ValidationDisposition;
  citationIndices?: number[];
  replacementApplied: boolean;
  reason: string;
}

export interface ValidatedAnswer {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  validation: AnswerValidationSummary;
  segmentResults: AnswerSegmentValidationResult[];
}
