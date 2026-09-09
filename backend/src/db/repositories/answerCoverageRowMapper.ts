import type {
  AnswerCoverageAssessment,
  AnswerCoverageReactionTrace,
  AnswerCoverageRecord,
} from "../../modules/answerCoverage/public.js";

export interface AnswerCoverageRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  request_message_id: string;
  originating_turn_id: string;
  contextualized_request: string;
  assistant_message_id: string | null;
  availability: AnswerCoverageAssessment["availability"];
  coverage: "answered" | "partial" | "unanswered" | "unclear" | null;
  reason: "sufficient_evidence" | "insufficient_evidence" | "conflicting_evidence" | "ambiguous_request" | "intentional_scope_boundary" | null;
  unresolved_request: string | null;
  schema_version: number;
  interaction_evaluation_state: "evaluated" | null;
  assessed_at: Date;
  created_at: Date;
}

export const answerCoverageColumns = [
  "id", "workspace_id", "conversation_id", "request_message_id", "originating_turn_id", "contextualized_request", "assistant_message_id", "availability", "coverage", "reason", "unresolved_request", "schema_version", "interaction_evaluation_state", "assessed_at", "created_at",
] as const;

export const mapAnswerCoverageRow = (row: AnswerCoverageRow): AnswerCoverageRecord => {
  const base = {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    requestMessageId: row.request_message_id,
    originatingTurnId: row.originating_turn_id,
    contextualizedRequest: row.contextualized_request,
    ...(row.assistant_message_id === null ? {} : { assistantMessageId: row.assistant_message_id }),
    schemaVersion: row.schema_version,
    ...(row.interaction_evaluation_state === null ? {} : { interactionEvaluationState: row.interaction_evaluation_state }),
    assessedAt: new Date(row.assessed_at),
    createdAt: new Date(row.created_at),
  };
  if (row.availability !== "assessed") {
    return { ...base, availability: row.availability };
  }
  if (!row.coverage || !row.reason) {
    throw new Error("answer_coverage_assessment_invalid_assessed_row");
  }
  return {
    ...base,
    availability: "assessed",
    coverage: row.coverage,
    reason: row.reason,
    ...(row.unresolved_request === null ? {} : { unresolvedRequest: row.unresolved_request }),
  };
};

export interface AnswerCoverageReactionRow {
  id: string;
  assessment_id: string;
  workspace_id: string;
  conversation_id: string;
  reaction_key: string;
  directive_id: string | null;
  routine_id: string | null;
  routine_execution_id: string | null;
  target_message_id: string;
  evaluation_state: "evaluated" | "not_applicable" | "suppressed";
  evaluation_index: number;
  decision: AnswerCoverageReactionTrace["decision"];
  reason_code: string;
  created_at: Date;
}

export const answerCoverageReactionColumns = [
  "id", "assessment_id", "workspace_id", "conversation_id", "reaction_key", "directive_id", "routine_id", "routine_execution_id", "target_message_id", "evaluation_state", "evaluation_index", "decision", "reason_code", "created_at",
] as const;

export const mapAnswerCoverageReactionRow = (row: AnswerCoverageReactionRow): AnswerCoverageReactionTrace => ({
  id: row.id,
  assessmentId: row.assessment_id,
  workspaceId: row.workspace_id,
  conversationId: row.conversation_id,
  reactionKey: row.reaction_key,
  ...(row.directive_id === null ? {} : { directiveId: row.directive_id }),
  ...(row.routine_id === null ? {} : { routineId: row.routine_id }),
  ...(row.routine_execution_id === null ? {} : { routineExecutionId: row.routine_execution_id }),
  targetMessageId: row.target_message_id,
  evaluationState: row.evaluation_state,
  evaluationIndex: row.evaluation_index,
  decision: row.decision,
  reasonCode: row.reason_code,
  createdAt: new Date(row.created_at),
});
