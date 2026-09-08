import type {
  AnswerCoverageAssessment,
  ConversationCoverageAssessor,
  ConversationCoverageReactionRecorder,
} from "@radioso/conversation-contract";

import {
  LlmAnswerCoverageProducer,
  type AnswerCoverageInferencePort,
  type AnswerCoverageRecord,
  type AnswerCoverageReactionRepositoryPort,
  type AnswerCoverageRepositoryPort,
} from "../../answerCoverage/public.js";
import type { ChatGateway } from "../contracts/chatGateway.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { setTraceAttributes } from "../../../shared/observability/tracing/operations.js";

// Retrieval's FinalPromptContext list is already the exact token-bounded set that
// answer composition receives. Do not independently shorten it here: assessing a
// different evidence set would manufacture a gap the answer could actually resolve.
const admittedEvidence = (session: PreparedSession) => session.retrieval.contexts
  .map((context) => ({
    id: context.chunkId,
    sourceLabel: context.title,
    content: context.content,
  }));

const contextualizedRequest = (session: PreparedSession, request: string): string => {
  const history = session.history.slice(-6).map((message) => `${message.role}: ${message.content}`).join("\n");
  return history ? `${history}\nuser: ${session.effectiveQuery || request}` : session.effectiveQuery || request;
};

const assessmentFromRecord = (record: AnswerCoverageRecord): AnswerCoverageAssessment =>
  record.availability === "assessed"
    ? {
        availability: "assessed",
        coverage: record.coverage,
        reason: record.reason,
        ...(record.unresolvedRequest ? { unresolvedRequest: record.unresolvedRequest } : {}),
        schemaVersion: record.schemaVersion,
      }
    : { availability: record.availability };

const isStoredAssessment = (record: AnswerCoverageRecord): boolean =>
  record.availability === "assessed"
  || record.availability === "not_recorded"
  || record.availability === "failed"
  || record.availability === "invalid";

/**
 * Chat-owned adapter around the provider-neutral assessor. This is the only layer
 * that knows a chat gateway or retrieval context shape; the shared contract sees
 * bounded data only. Assessment persistence is best effort because an unavailable
 * diagnostic must never suppress the normal safe response.
 */
export class ChatAnswerCoverageAssessorFactory {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly repository?: AnswerCoverageRepositoryPort & AnswerCoverageReactionRepositoryPort,
  ) {}

  create(input: {
    getSession: () => PreparedSession;
    accountId?: string;
    signal?: AbortSignal;
    onAssessment?: (input: { assessment: AnswerCoverageAssessment; record?: AnswerCoverageRecord }) => void;
  }): ConversationCoverageAssessor {
    return {
      assess: async ({ turn }) => {
        const session = input.getSession();
        if (session.turnRoute !== "retrieval") {
          return { availability: "not_recorded" };
        }
        if (this.repository) {
          try {
            const existing = await this.repository.findByRequestMessageId({
              workspaceId: session.agent.workspaceId,
              requestMessageId: session.userMessage.id,
            });
            if (existing) {
              const assessment = assessmentFromRecord(existing);
              input.onAssessment?.({ assessment, record: existing });
              return assessment;
            }
          } catch {
            setTraceAttributes({ "answer_coverage.persistence": "read_failed" });
          }
        }
        const request = contextualizedRequest(session, turn.inputEvent.content);
        const inference: AnswerCoverageInferencePort = {
          complete: async (request) => ({
            text: await this.gateway.answer({
              query: "",
              history: [],
              prompt: request.prompt,
              workspaceContext: {
                workspaceId: session.agent.workspaceId,
                capabilityOverride: session.agent.chatModelOverride ?? undefined,
              },
              usageContext: request.operation,
              generation: {
                maxOutputTokens: request.maxOutputTokens,
                responseFormat: request.responseFormat,
              },
              signal: request.signal,
            }),
          }),
        };
        const assessment = await new LlmAnswerCoverageProducer(inference).assess({
          contextualizedRequest: request,
          admissibleEvidence: admittedEvidence(session),
          usageContext: {
            accountId: input.accountId ?? null,
            workspaceId: session.agent.workspaceId,
            conversationId: session.conversation.id,
            messageId: session.userMessage.id,
            surface: "assistant",
            operation: "answer_coverage_assessment",
            attemptKey: `${session.userMessage.id}:answer_coverage_assessment`,
            ...session.usageAttribution,
          },
          signal: input.signal,
        });
        let authoritativeAssessment = assessment;
        let authoritativeRecord: AnswerCoverageRecord | undefined;
        if (this.repository) {
          try {
            const saved = await this.repository.saveAssessment({
              workspaceId: session.agent.workspaceId,
              conversationId: session.conversation.id,
              requestMessageId: session.userMessage.id,
              originatingTurnId: session.userMessage.id,
              contextualizedRequest: request,
              assessment,
            });
            authoritativeAssessment = isStoredAssessment(saved)
              ? assessmentFromRecord(saved)
              : assessment;
            authoritativeRecord = isStoredAssessment(saved) ? saved : undefined;
          } catch {
            // Durable diagnostics are additive. The signal remains valid for this
            // turn, but a retry will safely converge through the idempotency key.
            setTraceAttributes({ "answer_coverage.persistence": "failed" });
          }
        }
        input.onAssessment?.({ assessment: authoritativeAssessment, record: authoritativeRecord });
        return authoritativeAssessment;
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
