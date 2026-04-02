import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalPipelineService } from "../../retrieval/services/retrievalPipelineService.js";
import type { ChatGateway } from "../../chat/services/chatService.js";
import { AnswerPresentationService } from "../../chat/services/answerPresentationService.js";
import { AnswerSupportValidator } from "../../chat/services/answerSupportValidator.js";
import { AssistantTurnOutcomeClassifier } from "../../chat/services/assistantTurnOutcomeClassifier.js";
import { RetrievalInfoPresenter } from "../../retrieval/services/retrievalInfoPresenter.js";
import { RetrievalTracePresenter } from "../../retrieval/services/retrievalTracePresenter.js";
import {
  ASSISTANT_TURN_OUTCOME,
  type AssistantTurnOutcome,
} from "../../chat/services/answerSupportValidationTypes.js";
import {
  DefaultUnsupportedNoticeGenerator,
  type UnsupportedNoticeGenerator,
} from "../../chat/services/unsupportedNoticeGenerator.js";
import { DEFAULT_ANSWER_SUPPORT_POLICY } from "../../settings/domain/retrievalSettings.js";
import type { EvalCaseConversationMessage, EvalReplayDiagnostics } from "../domain/evalTypes.js";

const NO_CONTEXT_MESSAGE = "I could not find relevant information in your documents.";

export class EvalReplayService {
  private readonly answerPresentationService = new AnswerPresentationService();
  private readonly answerSupportValidator = new AnswerSupportValidator();
  private readonly assistantTurnOutcomeClassifier = new AssistantTurnOutcomeClassifier();
  private readonly retrievalInfoPresenter = new RetrievalInfoPresenter();
  private readonly retrievalTracePresenter = new RetrievalTracePresenter();

  constructor(
    private readonly retrievalPipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly unsupportedNoticeGenerator: UnsupportedNoticeGenerator = new DefaultUnsupportedNoticeGenerator(),
  ) {}

  async replay(input: {
    workspaceId: string;
    query: string;
    conversationContext?: EvalCaseConversationMessage[];
  }): Promise<EvalReplayDiagnostics> {
    const history = this.toMessageHistory(input.workspaceId, input.conversationContext ?? []);
    const retrieval = await this.retrievalPipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history,
    });

    const startedAt = Date.now();
    const answerSupportPolicy = retrieval.responseSettings?.answerSupportPolicy ?? DEFAULT_ANSWER_SUPPORT_POLICY;

    const rawAnswer =
      retrieval.contexts.length === 0
        ? NO_CONTEXT_MESSAGE
        : await this.chatGateway.answer({
            query: input.query,
            history,
            prompt: retrieval.prompt,
          });

    const citationEvidence = retrieval.contexts.map((context) => ({
      documentId: context.documentId,
      chunkId: context.chunkId,
      title: context.title,
      content: context.content,
    }));
    const citationDisplayEnabled = retrieval.responseSettings?.citationDisplayEnabled ?? true;

    let answer = rawAnswer;
    let citations = undefined;
    let answerSegments = undefined;
    let answerOutcome: AssistantTurnOutcome = ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL;
    let validationSummary = {
      ran: false,
      answerModified: false,
      unsupportedSegmentCount: 0,
      supportedSegmentCount: 0,
      nonSubstantiveSegmentCount: 0,
    };

    if (retrieval.contexts.length === 0) {
      const presented = this.answerPresentationService.present({
        answer: rawAnswer,
        citations: citationEvidence,
        citationDisplayEnabled,
      });
      answer = presented.answer;
      citations = presented.citations;
      answerSegments = presented.answerSegments;
    } else {
      const normalized = this.answerPresentationService.normalize({
        answer: rawAnswer,
        citations: citationEvidence,
      });
      const validated = await this.answerSupportValidator.validate({
        query: input.query,
        answer: normalized.answer,
        answerSegments: normalized.answerSegments,
        citationEvidence: normalized.citationEvidence,
        citationDisplayEnabled,
        answerSupportPolicy,
        unsupportedNoticeGenerator: this.unsupportedNoticeGenerator,
      });
      answer = validated.answer;
      citations = validated.citations;
      answerSegments = validated.answerSegments;
      answerOutcome = this.assistantTurnOutcomeClassifier.classify({
        hadRetrievedContext: true,
        validation: validated.validation,
      });
      validationSummary = {
        ran: validated.validation.ran,
        answerModified: validated.validation.answerModified,
        unsupportedSegmentCount: validated.validation.unsupportedSegmentCount,
        supportedSegmentCount: validated.validation.supportedSegmentCount,
        nonSubstantiveSegmentCount: validated.validation.nonSubstantiveSegmentCount,
      };
    }

    const retrievalInfo = this.retrievalInfoPresenter.present(retrieval.diagnostics);
    const retrievalTrace = this.retrievalTracePresenter.appendAnswerOutcome({
      trace: retrieval.trace,
      summary: retrievalInfo,
        outcome: {
          answer,
          stream: false,
          hadContexts: retrieval.contexts.length > 0,
          durationMs: Date.now() - startedAt,
          answerOutcome,
          validation: retrieval.contexts.length > 0
            ? validationSummary
            : {
                ran: false,
                answerModified: false,
                unsupportedSegmentCount: 0,
                supportedSegmentCount: 0,
                nonSubstantiveSegmentCount: 0,
              },
      },
    });

    return {
      retrievalInfo,
      retrievalTrace,
      citations,
      answerSegments,
      answerOutcome,
      answerSupportPolicy,
      answer,
      latencyMs: Date.now() - startedAt,
    };
  }

  private toMessageHistory(
    workspaceId: string,
    messages: EvalCaseConversationMessage[],
  ): MessageRecord[] {
    const baseTimestamp = Date.now() - messages.length * 1_000;
    return messages.map((message, index) => ({
      id: randomUUID(),
      conversationId: "eval-replay",
      workspaceId,
      role: message.role,
      content: message.content,
      createdAt: new Date(baseTimestamp + index * 1_000),
    }));
  }
}
