import type { ChatAnswerCoverageAssessment } from "../../contracts/answerCoverage.js";

/** No assessment ran for this request; the ids still anchor the verdict slot to the turn. */
export const notRecordedAnswerCoverage = (requestMessageId: string): ChatAnswerCoverageAssessment => ({
  availability: "not_recorded",
  originatingTurnId: requestMessageId,
  originatingRequestId: requestMessageId,
});
