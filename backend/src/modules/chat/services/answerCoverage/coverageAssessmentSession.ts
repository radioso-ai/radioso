import type {
  AnswerCoverageAssessment,
  ConversationCoverageReactionRecorder,
} from "@radioso/conversation-contract";

import type { AnswerCoverageRecord } from "../../../answerCoverage/public.js";
import type { PreparedSession } from "../chatSessionPreparer.js";

/**
 * What a turn's coverage assessment and its reaction pass leave on the session: the debug view
 * of the assessment, and the decisions the reaction recorder made on it.
 */
export const applyCoverageAssessment = (
  session: Pick<PreparedSession, "answerCoverage" | "answerCoverageDebug" | "answerCoverageInteractionTrace" | "effectiveQuery" | "userMessage">,
  input: { assessment: AnswerCoverageAssessment; record?: AnswerCoverageRecord },
): void => {
  session.answerCoverage = input.assessment;
  const record = input.record;
  session.answerCoverageDebug = {
    availability: input.assessment.availability,
    contextualizedRequest: record?.contextualizedRequest ?? session.effectiveQuery ?? session.userMessage.content,
    originatingTurnId: record?.originatingTurnId ?? session.userMessage.id,
    originatingRequestId: record?.requestMessageId ?? session.userMessage.id,
    ...(record
      ? { schemaVersion: record.schemaVersion, assessedAt: record.assessedAt.toISOString() }
      : input.assessment.availability === "assessed" ? { schemaVersion: input.assessment.schemaVersion } : {}),
    ...(input.assessment.availability === "assessed" ? {
      coverage: input.assessment.coverage,
      reason: input.assessment.reason,
      ...(input.assessment.unresolvedRequest ? { unresolvedRequest: input.assessment.unresolvedRequest } : {}),
    } : {}),
  };
  // Persisted assessments whose reaction pass has not yet completed project as
  // `not_evaluated` in history. Set the same live state before the recorder runs;
  // only its success callback below is allowed to replace it with `evaluated`.
  session.answerCoverageInteractionTrace = input.assessment.availability === "assessed" && record?.availability === "assessed"
    ? { state: "not_evaluated", decisions: [] }
    : undefined;
};

export const applyCoverageInteractionTrace = (
  session: Pick<PreparedSession, "answerCoverageInteractionTrace" | "userMessage">,
  reaction: Parameters<ConversationCoverageReactionRecorder["record"]>[0],
): void => {
  session.answerCoverageInteractionTrace = {
    state: reaction.evaluationState === "evaluated" ? "evaluated" : "not_evaluated",
    ...(reaction.assessment.availability === "assessed" ? {
      consumedAssessment: {
        coverage: reaction.assessment.coverage,
        reason: reaction.assessment.reason,
      },
    } : {}),
    decisions: reaction.reactions.flatMap((entry) => {
      const target = entry.directiveId
        ? { target: "directive" as const, targetId: entry.directiveId }
        : entry.routineId ? { target: "routine" as const, targetId: entry.routineId } : null;
      return target ? [{
        assessmentRequestId: session.userMessage.id,
        ...target,
        decision: entry.decision,
        reasonCode: entry.reasonCode,
        ...(entry.routineExecutionId ? { routineExecutionId: entry.routineExecutionId } : {}),
        targetMessageId: session.userMessage.id,
      }] : [];
    }),
  };
};
