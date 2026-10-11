import type { ChatAnswerCoverageAssessment } from "../../chat/contracts/index.js";
import type { EvalRunObservedOutput } from "../domain/types.js";

/**
 * What a review turn shows besides the shared observed output. A review turn returns its
 * reply as a draft and carries no turn trace, so its coverage verdict comes from the turn's
 * own facts, and the runner counts the replies the conversation gained while it ran.
 */
interface ReviewTurnObservation {
  /** The coverage record the review facts carried; null when the turn recorded none. */
  answerCoverage: Pick<ChatAnswerCoverageAssessment, "availability" | "coverage"> | null;
  /** Assistant messages written to the conversation during the turn. */
  persistedAssistantMessageCount: number;
}

/** The output the suite scores: a live turn's observed output, or a review turn's with its observation. */
export interface ConversationQualityObservedOutput extends EvalRunObservedOutput {
  reviewTurn?: ReviewTurnObservation;
}
