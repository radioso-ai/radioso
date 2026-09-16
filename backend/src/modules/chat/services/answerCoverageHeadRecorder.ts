import type { ConversationCoverageReactionRecorder } from "@radioso/conversation-contract";

import type {
  AnswerCoverageAssessment,
  AnswerCoverageRecord,
  AnswerCoverageReactionRepositoryPort,
  AnswerCoverageRepositoryPort,
} from "../../answerCoverage/public.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { setTraceAttributes } from "../../../shared/observability/tracing/operations.js";
import { buildContextualizedRequest } from "./contextualizedRequest.js";
import type { RetrievalCoverageVerdictSink } from "../contracts/answerCoverage.js";

const assessmentFromRecord = (record: AnswerCoverageRecord): AnswerCoverageAssessment =>
  record.availability === "assessed"
    ? {
        availability: "assessed",
        coverage: record.coverage,
        reason: record.reason,
        ...(record.unresolvedRequest ? { unresolvedRequest: record.unresolvedRequest } : {}),
        schemaVersion: record.schemaVersion,
        producer: record.producer,
      }
    : { availability: record.availability, ...(record.producer ? { producer: record.producer } : {}) };

/**
 * Chat-owned persistence for the answer envelope head's coverage verdict
 * (#1260, FR-016/FR-017). This is the only layer that knows a repository or a
 * prepared session shape; the shared contract's coverage verdict sink sees
 * bounded data only. Persistence is best effort because an unavailable
 * diagnostic must never suppress the normal safe response — a failure is
 * recorded as a trace attribute and the turn proceeds through the delegate
 * sink exactly as if it had succeeded.
 */
export class AnswerCoverageHeadRecorder {
  constructor(
    private readonly repository?: AnswerCoverageRepositoryPort & AnswerCoverageReactionRepositoryPort,
  ) {}

  /**
   * Wraps the engine's coverage verdict sink so every `report()` persists the
   * reported assessment before the engine decides proceed/yield. Absent a
   * repository (draft test chat, eval replay — FR-023), returns the sink
   * unchanged: the same head path runs and coverage-gated directives/routines
   * still react, but nothing is written.
   */
  wrapVerdictSink(
    input: {
      getSession: () => PreparedSession;
      onAssessment?: (input: { assessment: AnswerCoverageAssessment; record?: AnswerCoverageRecord }) => void;
    },
    inner: RetrievalCoverageVerdictSink,
  ): RetrievalCoverageVerdictSink {
    if (!this.repository) {
      return inner;
    }
    const repository = this.repository;
    return {
      report: async ({ assessment }) => {
        const session = input.getSession();
        try {
          const saved = await repository.saveAssessment({
            workspaceId: session.agent.workspaceId,
            conversationId: session.conversation.id,
            requestMessageId: session.userMessage.id,
            originatingTurnId: session.userMessage.id,
            contextualizedRequest: buildContextualizedRequest(session, session.effectiveQuery ?? session.userMessage.content),
            assessment,
          });
          const recordedAssessment = assessmentFromRecord(saved);
          input.onAssessment?.({ assessment: recordedAssessment, record: saved });
          // `saveAssessment` is insert-or-return-existing: a retried report for the
          // same request message id gets back whichever verdict the row already
          // carries, which need not be this call's own `assessment` (#1260 review
          // F8). Forward the row's verdict so the engine's directive/routine
          // reactions and the persisted record always agree on what was assessed.
          return inner.report({ assessment: recordedAssessment });
        } catch {
          // Durable diagnostics are additive. The signal remains valid for this
          // turn, but a retry will safely converge through the idempotency key
          // (`request_message_id` is unique; `saveAssessment` upserts on it).
          setTraceAttributes({ "answer_coverage.persistence": "failed" });
        }
        return inner.report({ assessment });
      },
    };
  }

  createReactionRecorder(input: {
    getSession: () => PreparedSession;
    onRecorded?: (reaction: Parameters<ConversationCoverageReactionRecorder["record"]>[0]) => void;
  }): ConversationCoverageReactionRecorder | undefined {
    if (!this.repository) return undefined;
    return {
      record: async (reaction) => {
        const session = input.getSession();
        const assessment = await this.repository!.findByRequestMessageId({
          workspaceId: session.agent.workspaceId,
          requestMessageId: session.userMessage.id,
        });
        if (!assessment) return;
        for (const [index, entry] of reaction.reactions.entries()) {
          await this.repository!.recordReaction({
            assessmentId: assessment.id,
            workspaceId: session.agent.workspaceId,
            conversationId: session.conversation.id,
            reactionKey: entry.reactionKey,
            directiveId: entry.directiveId,
            routineId: entry.routineId,
            routineExecutionId: entry.routineExecutionId,
            targetMessageId: session.userMessage.id,
            evaluationState: reaction.evaluationState,
            evaluationIndex: index,
            decision: entry.decision,
            reasonCode: entry.reasonCode,
          });
        }
        await this.repository!.markInteractionEvaluated({
          workspaceId: session.agent.workspaceId,
          assessmentId: assessment.id,
        });
        input.onRecorded?.(reaction);
      },
    };
  }
}
