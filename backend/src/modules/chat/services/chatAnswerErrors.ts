import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";

/**
 * Thrown when answer generation yields a blank/unusable answer (e.g. a well-formed
 * envelope with an empty answer). Lives in its own module so both `ChatService`
 * (gateway + streaming) and the `GroundedAnswerComposer` can share it without a
 * circular import.
 */
export class BlankChatAnswerError extends Error {
  constructor() {
    super("chat_answer_generation_failed");
    this.name = "BlankChatAnswerError";
  }
}

export const isBlankChatAnswerError = (error: unknown): error is BlankChatAnswerError =>
  error instanceof BlankChatAnswerError;

/** Whether the presented answer cites at least one retrieved context. */
export const hasCitedAnswerSegment = (presentation: ChatPresentedAnswer): boolean =>
  presentation.answerSegments?.some((segment) => (segment.citationIndices?.length ?? 0) > 0) ?? false;
