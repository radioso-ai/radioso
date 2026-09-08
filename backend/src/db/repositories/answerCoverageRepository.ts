import { randomUUID } from "node:crypto";

import type {
  AnswerCoverageAssessment,
  AnswerCoverageReactionRepositoryPort,
  AnswerCoverageReactionTrace,
  AnswerCoverageRecord,
  AnswerCoverageRepositoryPort,
} from "../../modules/answerCoverage/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import {
  answerCoverageColumns,
  answerCoverageReactionColumns,
  mapAnswerCoverageReactionRow,
  mapAnswerCoverageRow,
  type AnswerCoverageReactionRow,
  type AnswerCoverageRow,
} from "./answerCoverageRowMapper.js";

export class AnswerCoverageRepository implements AnswerCoverageRepositoryPort, AnswerCoverageReactionRepositoryPort {
  constructor(private readonly db: Db) {}

  async saveAssessment(input: {
    workspaceId: string;
    conversationId: string;
    requestMessageId: string;
    originatingTurnId: string;
    contextualizedRequest: string;
    assessment: AnswerCoverageAssessment;
  }): Promise<AnswerCoverageRecord> {
    const values = input.assessment.availability === "assessed"
      ? {
          id: randomUUID(),
          workspace_id: input.workspaceId,
          conversation_id: input.conversationId,
          request_message_id: input.requestMessageId,
          originating_turn_id: input.originatingTurnId,
          contextualized_request: input.contextualizedRequest,
          availability: input.assessment.availability,
          coverage: input.assessment.coverage,
          reason: input.assessment.reason,
          unresolved_request: input.assessment.unresolvedRequest ?? null,
          schema_version: input.assessment.schemaVersion,
        }
      : {
          id: randomUUID(),
          workspace_id: input.workspaceId,
          conversation_id: input.conversationId,
          request_message_id: input.requestMessageId,
          originating_turn_id: input.originatingTurnId,
          contextualized_request: input.contextualizedRequest,
          availability: input.assessment.availability,
          coverage: null,
          reason: null,
          unresolved_request: null,
          schema_version: 1,
        };
    const inserted = await this.db
      .insertInto("answer_coverage_assessments")
      .values(values)
      .onConflict((oc) => oc.column("request_message_id").doNothing())
      .returning(answerCoverageColumns)
      .executeTakeFirst();
    if (inserted) {
      return mapAnswerCoverageRow(inserted as AnswerCoverageRow);
    }
    const existing = await this.findByRequestMessageId({
      workspaceId: input.workspaceId,
      requestMessageId: input.requestMessageId,
    });
    if (!existing) {
      throw new Error("answer_coverage_assessment_idempotency_conflict_without_row");
    }
    return existing;
  }

  async findByRequestMessageId(input: { workspaceId: string; requestMessageId: string }): Promise<AnswerCoverageRecord | null> {
    const row = await this.db
      .selectFrom("answer_coverage_assessments")
      .select(answerCoverageColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where("request_message_id", "=", input.requestMessageId)
      .executeTakeFirst();
    return row ? mapAnswerCoverageRow(row as AnswerCoverageRow) : null;
  }

  async listByRequestMessageIds(input: {
    workspaceId: string;
    requestMessageIds: readonly string[];
  }): Promise<Map<string, AnswerCoverageRecord>> {
    if (input.requestMessageIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom("answer_coverage_assessments")
      .select(answerCoverageColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where("request_message_id", "in", input.requestMessageIds)
      .execute();
    return new Map(rows.map((row) => {
      const assessment = mapAnswerCoverageRow(row as AnswerCoverageRow);
      return [assessment.requestMessageId, assessment] as const;
    }));
  }

  async markInteractionEvaluated(input: { workspaceId: string; assessmentId: string }): Promise<void> {
    await this.db
      .updateTable("answer_coverage_assessments")
      .set({ interaction_evaluation_state: "evaluated" })
      .where("workspace_id", "=", input.workspaceId)
      .where("id", "=", input.assessmentId)
      .execute();
  }

  async recordReaction(input: Omit<AnswerCoverageReactionTrace, "id" | "createdAt">): Promise<AnswerCoverageReactionTrace> {
    const inserted = await this.db
      .insertInto("answer_coverage_reaction_traces")
      .values({
        id: randomUUID(),
        assessment_id: input.assessmentId,
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        reaction_key: input.reactionKey,
        directive_id: input.directiveId ?? null,
        routine_id: input.routineId ?? null,
        routine_execution_id: input.routineExecutionId ?? null,
        target_message_id: input.targetMessageId,
        evaluation_state: input.evaluationState,
        evaluation_index: input.evaluationIndex,
        decision: input.decision,
        reason_code: input.reasonCode,
      })
      .onConflict((oc) => oc.columns(["assessment_id", "reaction_key"]).doNothing())
      .returning(answerCoverageReactionColumns)
      .executeTakeFirst();
    if (inserted) {
      return mapAnswerCoverageReactionRow(inserted as AnswerCoverageReactionRow);
    }
    const existing = await this.db
      .selectFrom("answer_coverage_reaction_traces")
      .select(answerCoverageReactionColumns)
      .where("assessment_id", "=", input.assessmentId)
      .where("workspace_id", "=", input.workspaceId)
      .where("reaction_key", "=", input.reactionKey)
      .executeTakeFirst();
    if (!existing) {
      throw new Error("answer_coverage_reaction_idempotency_conflict_without_row");
    }
    return mapAnswerCoverageReactionRow(existing as AnswerCoverageReactionRow);
  }

  async listByAssessmentId(input: { workspaceId: string; assessmentId: string }): Promise<AnswerCoverageReactionTrace[]> {
    const rows = await this.db
      .selectFrom("answer_coverage_reaction_traces")
      .select(answerCoverageReactionColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where("assessment_id", "=", input.assessmentId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map((row) => mapAnswerCoverageReactionRow(row as AnswerCoverageReactionRow));
  }

  async listByAssessmentIds(input: {
    workspaceId: string;
    assessmentIds: readonly string[];
  }): Promise<Map<string, AnswerCoverageReactionTrace[]>> {
    if (input.assessmentIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom("answer_coverage_reaction_traces")
      .select(answerCoverageReactionColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where("assessment_id", "in", input.assessmentIds)
      .orderBy("assessment_id", "asc")
      .orderBy("evaluation_index", "asc")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    const byAssessmentId = new Map<string, AnswerCoverageReactionTrace[]>();
    for (const row of rows) {
      const reaction = mapAnswerCoverageReactionRow(row as AnswerCoverageReactionRow);
      const reactions = byAssessmentId.get(reaction.assessmentId) ?? [];
      reactions.push(reaction);
      byAssessmentId.set(reaction.assessmentId, reactions);
    }
    return byAssessmentId;
  }
}
