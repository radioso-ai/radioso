import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import {
  AnswerPresentationService,
  resolveCitationArtifacts,
  type ChatGateway,
} from "../../chat/retrievalSupport.js";
import type { RetrievalPipelineService } from "./retrievalPipelineService.js";
import { ActivitySummaryPresenter } from "./activitySummaryPresenter.js";
import { ActivityTracePresenter } from "./activityTracePresenter.js";
import { RESPONSE_INTENT } from "../domain/retrievalPipelineTypes.js";
import { NoopUsageLimitPolicy, type UsageLimitPolicy } from "../../../shared/domain/usageLimitPolicy.js";
import type {
  RetrievalAnswerRequest,
  RetrievalAnswerResult,
} from "../domain/retrievalCapabilityTypes.js";
import type { CitationEvidence } from "../../chat/contracts/answerTypes.js";
import { resolveContextSourceUrl } from "./contextSourceUrl.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import type { RetrievalExecutionDiagnostics } from "../domain/retrievalPipelineTypes.js";
import type { DirectiveSteeringPort } from "../../directives/public.js";
import { appendSteeringBlock } from "../../../shared/infra/prompts/steeringPromptRenderer.js";
import { appendDirectiveSteeringStage } from "../../chat/retrievalSupport.js";

const RETRIEVAL_DIRECTIVE_ROUTE = "retrieval";

export interface RetrievalAnswerServiceDependencies {
  retrievalPipeline: Pick<RetrievalPipelineService, "interpret" | "runInterpreted">;
  chatGateway: Pick<ChatGateway, "answer">;
  usageLimitPolicy?: UsageLimitPolicy;
  auditService?: AuditPort;
  directiveSteering?: DirectiveSteeringPort;
}

export class RetrievalAnswerService {
  private readonly answerPresentationService = new AnswerPresentationService();
  private readonly activitySummaryPresenter = new ActivitySummaryPresenter();
  private readonly activityTracePresenter = new ActivityTracePresenter();

  constructor(private readonly dependencies: RetrievalAnswerServiceDependencies) {}

  async answer(input: RetrievalAnswerRequest): Promise<RetrievalAnswerResult> {
    const history = this.buildContextMessages(input);
    const executionSurface = input.executionSurface ?? "retrieval";
    const requestId = input.requestId ?? randomUUID();
    const usageSurface = executionSurface === "mcp_capability" ? "mcp_capability" : "retrieval";
    const usageContext = {
      accountId: input.accountId ?? null,
      workspaceId: input.workspaceId,
      requestId,
      surface: usageSurface,
      attemptKey: requestId,
    } as const;
    const execution = {
      surface: executionSurface,
      path: executionSurface === "mcp_capability" ? "mcp_grounded_answer" : "retrieval_answer",
      retrievalInvoked: true,
    } as const;
    try {
      return await this.runAnswer(input, history, execution, usageContext);
    } catch (error) {
      await this.recordAuditFailure(input, execution, error);
      throw error;
    }
  }

  private async runAnswer(
    input: RetrievalAnswerRequest,
    history: MessageRecord[],
    execution: { surface: "retrieval" | "mcp_capability"; path: "retrieval_answer" | "mcp_grounded_answer"; retrievalInvoked: true },
    usageContext: {
      accountId: string | null;
      workspaceId: string;
      requestId: string;
      surface: "retrieval" | "mcp_capability";
      attemptKey: string;
    },
  ): Promise<RetrievalAnswerResult> {
    const interpretation = await this.dependencies.retrievalPipeline.interpret({
      workspaceId: input.workspaceId,
      query: input.query,
      history,
      responseIdentity: null,
      metadataFilter: input.metadataFilter,
      execution,
      usageContext,
    });
    const responseIntent = interpretation.interpretation.result.responseIntent;
    if (responseIntent && responseIntent !== RESPONSE_INTENT.RETRIEVAL) {
      const unsupported: RetrievalAnswerResult = {
        outcome: "unsupported",
        code: "unsupported_query_type",
        reason: responseIntent,
        message: "This request is outside retrieval scope.",
      };
      await this.recordAuditUnsupported(input, execution, responseIntent);
      return unsupported;
    }

    const retrieval = await this.dependencies.retrievalPipeline.runInterpreted(interpretation);
    const directiveSteering = await this.dependencies.directiveSteering?.steer({
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? undefined,
      turnContext: {
        query: input.query,
        route: RETRIEVAL_DIRECTIVE_ROUTE,
        surface: execution.surface,
      },
      usageContext: {
        ...usageContext,
        operation: "directive_match",
        attemptKey: "directive_match",
      },
    });
    const systemPrompt = appendSteeringBlock(retrieval.systemPrompt, directiveSteering?.rules ?? []);
    const activitySummary = this.activitySummaryPresenter.present(retrieval.diagnostics, {
      execution,
    });
    const answerStartedAt = Date.now();
    const usageReservation = await (this.dependencies.usageLimitPolicy ?? new NoopUsageLimitPolicy()).reserveAnswer({
      workspaceId: input.workspaceId,
      surface: execution.surface === "mcp_capability" ? "mcp.retrieval_answer" : "retrieval.answer",
    });
    try {
      const rawAnswer = (await this.dependencies.chatGateway.answer({
        query: input.query,
        history,
        systemPrompt,
        prompt: retrieval.prompt,
        usageContext: {
          ...usageContext,
          operation: "grounded_answer",
          attemptKey: "answer",
        },
      })).trim();
      const evidence = retrieval.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
        content: context.content,
        metadata: context.metadata,
        sourceUrl: resolveContextSourceUrl(context.metadata),
      }));
      const normalized = this.answerPresentationService.normalize({
        answer: rawAnswer,
        citations: evidence,
      });
      const presented = this.presentAnswer(rawAnswer, normalized, evidence);
      const activityTrace = appendDirectiveSteeringStage(this.activityTracePresenter.appendAnswerOutcome({
        trace: retrieval.trace,
        summary: activitySummary,
        outcome: {
          answer: presented.answer,
          stream: false,
          hadContexts: retrieval.contexts.length > 0,
          retrievalSkipped: false,
          durationMs: Date.now() - answerStartedAt,
        },
      }), directiveSteering);
      const resolvedActivitySummary = activityTrace.summary ?? activitySummary;

      await usageReservation.commit();
      const successResult = {
        outcome: "answer" as const,
        answer: presented.answer,
        citations: presented.citations,
        evidence: retrieval.contexts.map((context) => ({
          documentId: context.documentId,
          chunkId: context.chunkId,
          title: context.title,
          content: context.content,
          metadata: context.metadata,
        })),
        activitySummary: resolvedActivitySummary,
        activityTrace,
      };
      await this.recordAuditAnswer(input, execution, successResult, retrieval.diagnostics);
      return successResult;
    } catch (error) {
      await usageReservation.release();
      throw error;
    }
  }

  private presentAnswer(
    rawAnswer: string,
    normalized: ReturnType<AnswerPresentationService["normalize"]>,
    evidence: CitationEvidence[],
  ) {
    const presented = this.answerPresentationService.present({
      answer: rawAnswer,
      citations: evidence,
    });

    return {
      ...presented,
      ...resolveCitationArtifacts(presented, normalized, evidence),
    };
  }

  private async recordAuditAnswer(
    input: RetrievalAnswerRequest,
    execution: { surface: "retrieval" | "mcp_capability"; path: "retrieval_answer" | "mcp_grounded_answer"; retrievalInvoked: true },
    result: {
      answer: string;
      citations?: unknown[];
      activitySummary: unknown;
      activityTrace: unknown;
    },
    diagnostics: RetrievalExecutionDiagnostics,
  ): Promise<void> {
    if (!this.dependencies.auditService) {
      return;
    }
    await this.dependencies.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "retrieval.answer",
      eventStatus: "success",
      metadata: {
        execution,
        query: input.query,
        outcome: "answer",
        citationCount: result.citations?.length ?? 0,
        activitySummary: result.activitySummary,
        activityTrace: result.activityTrace,
        retrieval: diagnostics,
      },
    });
  }

  private async recordAuditUnsupported(
    input: RetrievalAnswerRequest,
    execution: { surface: "retrieval" | "mcp_capability"; path: "retrieval_answer" | "mcp_grounded_answer"; retrievalInvoked: true },
    reason: string,
  ): Promise<void> {
    if (!this.dependencies.auditService) {
      return;
    }
    await this.dependencies.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "retrieval.answer",
      eventStatus: "success",
      metadata: {
        execution,
        query: input.query,
        outcome: "unsupported",
        reason,
      },
    });
  }

  private async recordAuditFailure(
    input: RetrievalAnswerRequest,
    execution: { surface: "retrieval" | "mcp_capability"; path: "retrieval_answer" | "mcp_grounded_answer"; retrievalInvoked: true },
    error: unknown,
  ): Promise<void> {
    if (!this.dependencies.auditService) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "Error";
    await this.dependencies.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "retrieval.answer",
      eventStatus: "failure",
      metadata: {
        execution,
        query: input.query,
        outcome: "error",
        error: { name, message },
      },
    });
  }

  private buildContextMessages(input: RetrievalAnswerRequest): MessageRecord[] {
    const users = input.conversationContext?.previousUserMessages ?? [];
    const assistants = input.conversationContext?.previousAssistantMessages ?? [];
    const messages: MessageRecord[] = [];
    const maxLength = Math.max(users.length, assistants.length);
    const now = new Date();

    for (let index = 0; index < maxLength; index += 1) {
      const user = users[index];
      if (user) {
        messages.push(this.buildMessage(input.workspaceId, "user", user, now));
      }
      const assistant = assistants[index];
      if (assistant) {
        messages.push(this.buildMessage(input.workspaceId, "assistant", assistant, now));
      }
    }

    return messages;
  }

  private buildMessage(
    workspaceId: string,
    role: MessageRecord["role"],
    content: string,
    createdAt: Date,
  ): MessageRecord {
    return {
      id: randomUUID(),
      conversationId: "retrieval-context",
      workspaceId,
      role,
      content,
      createdAt,
    };
  }
}
