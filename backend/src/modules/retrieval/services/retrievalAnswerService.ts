import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { AnswerPresentationService, remapAnswerSegmentsToCitationEvidence } from "../../chat/services/answerPresentationService.js";
import { AnswerSupportValidator } from "../../chat/services/answerSupportValidator.js";
import type { ChatGateway } from "../../chat/services/chatService.js";
import { MissingGroundedMissResponseComposer } from "../../chat/services/groundedMissResponseComposer.js";
import type { RetrievalPipelineService } from "./retrievalPipelineService.js";
import { RetrievalInfoPresenter } from "./retrievalInfoPresenter.js";
import { RetrievalTracePresenter } from "./retrievalTracePresenter.js";
import { RESPONSE_INTENT } from "../domain/retrievalPipelineTypes.js";
import type {
  RetrievalAnswerRequest,
  RetrievalAnswerResult,
} from "../domain/retrievalCapabilityTypes.js";
import { resolveContextSourceUrl } from "./contextSourceUrl.js";

export interface RetrievalAnswerServiceDependencies {
  retrievalPipeline: Pick<RetrievalPipelineService, "interpret" | "runInterpreted">;
  chatGateway: Pick<ChatGateway, "answer">;
}

export class RetrievalAnswerService {
  private readonly answerPresentationService = new AnswerPresentationService();
  private readonly answerSupportValidator = new AnswerSupportValidator();
  private readonly groundedMissResponseComposer = new MissingGroundedMissResponseComposer();
  private readonly retrievalInfoPresenter = new RetrievalInfoPresenter();
  private readonly retrievalTracePresenter = new RetrievalTracePresenter();

  constructor(private readonly dependencies: RetrievalAnswerServiceDependencies) {}

  async answer(input: RetrievalAnswerRequest): Promise<RetrievalAnswerResult> {
    const history = this.buildContextMessages(input);
    const interpretation = await this.dependencies.retrievalPipeline.interpret({
      workspaceId: input.workspaceId,
      query: input.query,
      history,
      responseIdentity: null,
      metadataFilter: input.metadataFilter,
    });
    const responseIntent = interpretation.interpretation.result.responseIntent;
    if (responseIntent && responseIntent !== RESPONSE_INTENT.RETRIEVAL) {
      return {
        outcome: "unsupported",
        code: "unsupported_query_type",
        reason: responseIntent,
        message: "This request is outside retrieval scope.",
      };
    }

    const retrieval = await this.dependencies.retrievalPipeline.runInterpreted(interpretation);
    const executionSurface = input.executionSurface ?? "retrieval";
    const retrievalInfo = this.retrievalInfoPresenter.present(retrieval.diagnostics, {
      execution: {
        surface: executionSurface,
        path: executionSurface === "mcp_capability" ? "mcp_grounded_answer" : "retrieval_answer",
        retrievalInvoked: true,
      },
    });
    const answerStartedAt = Date.now();
    const rawAnswer = (await this.dependencies.chatGateway.answer({
      query: input.query,
      history,
      systemPrompt: retrieval.systemPrompt,
      prompt: retrieval.prompt,
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
    const validationAnswerSegments = remapAnswerSegmentsToCitationEvidence(
      normalized.answerSegments,
      normalized.citationEvidence,
      evidence,
    );
    const validated = await this.answerSupportValidator.validate({
      query: input.query,
      answer: normalized.answer,
      answerSegments: validationAnswerSegments,
      citationEvidence: evidence,
      retrievedContextSummaries: evidence.map((context) => ({
        title: context.title,
        content: context.content,
      })),
      citationDisplayEnabled: retrieval.responseSettings.citationDisplayEnabled,
      conversationMode: retrieval.responseSettings.conversationMode,
      groundedMissResponseComposer: this.groundedMissResponseComposer,
      unsupportedNoticeMarked: normalized.unsupportedNoticeMarked,
    });
    const retrievalTrace = this.retrievalTracePresenter.appendAnswerOutcome({
      trace: retrieval.trace,
      summary: retrievalInfo,
      outcome: {
        answer: validated.answer,
        stream: false,
        hadContexts: retrieval.contexts.length > 0,
        retrievalSkipped: false,
        durationMs: Date.now() - answerStartedAt,
        validation: validated.validation,
      },
    });

    return {
      outcome: "answer",
      answer: validated.answer,
      citations: validated.citations,
      evidence: retrieval.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
        content: context.content,
        metadata: context.metadata,
      })),
      validation: {
        status: validated.validation.ran
          ? validated.validation.supportedSegmentCount > 0
            ? "supported"
            : "unsupported"
          : "not_checked",
      },
      retrievalInfo,
      retrievalTrace,
    };
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
