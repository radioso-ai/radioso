import type {
  AnswerCoverageReactionTrace,
  AnswerCoverageRecord,
  AnswerCoverageRepositoryPort,
  AnswerCoverageReactionRepositoryPort,
} from "../../answerCoverage/public.js";
import type {
  ChatAnswerCoverageAssessment,
  ChatAnswerCoverageInteractionDecision,
  ChatAnswerCoverageInteractionTrace,
} from "../contracts/answerCoverage.js";

export interface AnswerCoverageHistoryReader extends Pick<AnswerCoverageRepositoryPort, "listByRequestMessageIds">,
  Pick<AnswerCoverageReactionRepositoryPort, "listByAssessmentIds"> {}

export class NoopAnswerCoverageHistoryReader implements AnswerCoverageHistoryReader {
  async listByRequestMessageIds(): Promise<Map<string, AnswerCoverageRecord>> { return new Map(); }
  async listByAssessmentIds(): Promise<Map<string, AnswerCoverageReactionTrace[]>> { return new Map(); }
}

type AnswerCoverageHistoryProjection = Map<string, {
  assessment: ChatAnswerCoverageAssessment;
  interactionTrace?: ChatAnswerCoverageInteractionTrace;
}>;

const toIsoString = (date: Date): string => date.toISOString();

const presentAssessment = (record: AnswerCoverageRecord): ChatAnswerCoverageAssessment => {
  const base = {
    availability: record.availability,
    contextualizedRequest: record.contextualizedRequest,
    originatingTurnId: record.originatingTurnId,
    originatingRequestId: record.requestMessageId,
    schemaVersion: record.schemaVersion,
    assessedAt: toIsoString(record.assessedAt),
  };
  return record.availability === "assessed"
    ? { ...base, coverage: record.coverage, reason: record.reason, ...(record.unresolvedRequest ? { unresolvedRequest: record.unresolvedRequest } : {}) }
    : base;
};

const presentInteractions = (
  record: Extract<AnswerCoverageRecord, { availability: "assessed" }>,
  reactions: AnswerCoverageReactionTrace[],
): ChatAnswerCoverageInteractionTrace => ({
  // This provider deliberately represents a persisted reaction evaluation. The
  // runtime's explicit evaluation marker selects this presenter; an assessment
  // alone never implies it (a crash may happen between assessment and matching).
  state: "evaluated",
  consumedAssessment: { coverage: record.coverage, reason: record.reason },
  decisions: reactions.flatMap((reaction): ChatAnswerCoverageInteractionDecision[] => {
    const target = reaction.directiveId
      ? { target: "directive" as const, targetId: reaction.directiveId }
      : reaction.routineId ? { target: "routine" as const, targetId: reaction.routineId } : null;
    return target ? [{
      assessmentRequestId: record.requestMessageId,
      ...target,
      decision: reaction.decision,
      reasonCode: reaction.reasonCode,
      ...(reaction.routineExecutionId ? { routineExecutionId: reaction.routineExecutionId } : {}),
      targetMessageId: reaction.targetMessageId,
    }] : [];
  }),
});

/** Loads a page's coverage diagnostics in two bounded, workspace-scoped reads. */
export const loadAnswerCoverageHistoryProjection = async (
  reader: AnswerCoverageHistoryReader,
  workspaceId: string,
  requestMessageIds: readonly string[],
): Promise<AnswerCoverageHistoryProjection> => {
  const records = await reader.listByRequestMessageIds({ workspaceId, requestMessageIds });
  // Migration 175 deliberately leaves pre-existing assessments unconfirmed. They have no
  // exact assistant turn to anchor them to, so they must not become operator-facing verdicts.
  const confirmedRecords = [...records].filter(([, record]) => record.assistantMessageId !== undefined);
  const assessedRecords = confirmedRecords
    .map(([, record]) => record)
    .filter((record) => record.availability === "assessed");
  const reactionsByAssessmentId = await reader.listByAssessmentIds({ workspaceId, assessmentIds: assessedRecords.map((record) => record.id) });
  const projection: AnswerCoverageHistoryProjection = new Map();
  for (const [requestMessageId, record] of confirmedRecords) {
    const reactions = record.availability === "assessed" ? reactionsByAssessmentId.get(record.id) ?? [] : [];
    const interactionTrace = record.availability === "assessed" && record.interactionEvaluationState === "evaluated"
      ? presentInteractions(record, reactions)
      : record.availability === "not_recorded" ? undefined : { state: "not_evaluated" as const, decisions: [] };
    projection.set(requestMessageId, { assessment: presentAssessment(record), ...(interactionTrace ? { interactionTrace } : {}) });
  }
  return projection;
};
