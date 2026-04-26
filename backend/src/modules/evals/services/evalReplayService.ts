import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type { RetrievalPipelineService } from "../../retrieval/services/retrievalPipelineService.js";
import { BlankChatAnswerError, type ChatGateway } from "../../chat/services/chatService.js";
import {
  AnswerPresentationService,
  remapAnswerSegmentsToCitationEvidence,
} from "../../chat/services/answerPresentationService.js";
import { AnswerSupportValidator } from "../../chat/services/answerSupportValidator.js";
import { AssistantTurnOutcomeClassifier } from "../../chat/services/assistantTurnOutcomeClassifier.js";
import { RetrievalInfoPresenter } from "../../retrieval/services/retrievalInfoPresenter.js";
import { RetrievalTracePresenter } from "../../retrieval/services/retrievalTracePresenter.js";
import {
  ASSISTANT_TURN_OUTCOME,
  type AssistantTurnOutcome,
} from "../../chat/services/answerSupportValidationTypes.js";
import {
  MissingGroundedMissResponseComposer,
  type GroundedMissResponseComposer,
} from "../../chat/services/groundedMissResponseComposer.js";
import { assertInteractiveAssistantWorkflow } from "../../chat/services/chatExecutionPolicy.js";
import { CHAT_TURN_ROUTE, ChatTurnIntentService, type ChatTurnRoute } from "../../chat/services/chatTurnIntentService.js";
import { buildNonRetrievalAnswerPrompt } from "../../chat/services/nonRetrievalAnswerPromptBuilder.js";
import { DEFAULT_ANSWER_SUPPORT_POLICY } from "../../settings/domain/retrievalSettings.js";
import { SharedAnswerInstructionBuilder } from "../../retrieval/services/sharedAnswerInstructionBuilder.js";
import type { EvalCaseConversationMessage, EvalReplayDiagnostics } from "../domain/evalTypes.js";

export class EvalReplayService {
  private readonly answerPresentationService = new AnswerPresentationService();
  private readonly answerSupportValidator = new AnswerSupportValidator();
  private readonly assistantTurnOutcomeClassifier = new AssistantTurnOutcomeClassifier();
  private readonly retrievalInfoPresenter = new RetrievalInfoPresenter();
  private readonly retrievalTracePresenter = new RetrievalTracePresenter();
  private readonly sharedAnswerInstructionBuilder = new SharedAnswerInstructionBuilder();
  private readonly chatTurnIntentService = new ChatTurnIntentService();

  constructor(
    private readonly retrievalPipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly groundedMissResponseComposer: GroundedMissResponseComposer = new MissingGroundedMissResponseComposer(),
    private readonly workspaceRepository?: Pick<WorkspaceRepositoryPort, "findById">,
  ) {}

  async replay(input: {
    workspaceId: string;
    query: string;
    conversationContext?: EvalCaseConversationMessage[];
  }): Promise<EvalReplayDiagnostics> {
    assertInteractiveAssistantWorkflow("eval.replay");
    const startedAt = Date.now();
    const history = this.toMessageHistory(input.workspaceId, input.conversationContext ?? []);
    const responseIdentity = await this.resolveResponseIdentity(input.workspaceId);
    const pipelineInput = {
      workspaceId: input.workspaceId,
      query: input.query,
      history,
      responseIdentity,
      responseBehaviorEnabled: true,
    };
    let retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
    let turnRoute: ChatTurnRoute = CHAT_TURN_ROUTE.RETRIEVAL;

    if (supportsChatIntentRouting(this.retrievalPipeline)) {
      const retrievalPipeline = this.retrievalPipeline as ChatIntentCapableRetrievalPipeline;
      const interpretation = await retrievalPipeline.interpret(pipelineInput);
      turnRoute = this.chatTurnIntentService.resolve({
        responseIntent: interpretation.interpretation.result.responseIntent,
      }).route;
      retrieval = turnRoute === CHAT_TURN_ROUTE.RETRIEVAL
        ? await retrievalPipeline.runInterpreted(interpretation)
        : await retrievalPipeline.runWithoutRetrieval(interpretation);
    } else {
      retrieval = await this.retrievalPipeline.run(pipelineInput);
    }
    const answerSupportPolicy = retrieval.responseSettings?.answerSupportPolicy ?? DEFAULT_ANSWER_SUPPORT_POLICY;
    const conversationMode = retrieval.responseSettings?.conversationMode ?? "guided";
    const nonRetrievalAnswer =
      turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL
        ? await this.generateNonRetrievalAnswer({
            retrieval,
            history,
            query: input.query,
            route: turnRoute,
          })
        : null;
    const rawAnswer =
      turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL && nonRetrievalAnswer !== null
        ? nonRetrievalAnswer
        : retrieval.contexts.length === 0
          ? await this.groundedMissResponseComposer.composeNoContext({
              query: input.query,
              conversationMode,
            })
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
      substantiveUnsupportedSegmentCount: 0,
      supportedSegmentCount: 0,
      nonSubstantiveSegmentCount: 0,
    };

    if (turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL && nonRetrievalAnswer !== null) {
      const presented = this.answerPresentationService.present({
        answer: rawAnswer,
        citations: [],
        citationDisplayEnabled: false,
      });
      answer = presented.answer;
      citations = presented.citations;
      answerSegments = presented.answerSegments;
      answerOutcome = ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE;
    } else if (retrieval.contexts.length === 0) {
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
      const validationAnswerSegments = remapAnswerSegmentsToCitationEvidence(
        normalized.answerSegments,
        normalized.citationEvidence,
        citationEvidence,
      );
      const validated = await this.answerSupportValidator.validate({
        query: input.query,
        answer: normalized.answer,
        answerSegments: validationAnswerSegments,
        citationEvidence,
        retrievedContextSummaries: citationEvidence.map((citation) => ({
          title: citation.title,
          content: citation.content,
        })),
        citationDisplayEnabled,
        answerSupportPolicy,
        conversationMode,
        groundedMissResponseComposer: this.groundedMissResponseComposer,
        unsupportedNoticeMarked: normalized.unsupportedNoticeMarked,
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
        substantiveUnsupportedSegmentCount: validated.validation.substantiveUnsupportedSegmentCount,
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
          retrievalSkipped: retrieval.diagnostics.retrievalSkipped,
          durationMs: Date.now() - startedAt,
          answerOutcome,
          validation: retrieval.contexts.length > 0
            ? validationSummary
            : {
                ran: false,
                answerModified: false,
                unsupportedSegmentCount: 0,
                substantiveUnsupportedSegmentCount: 0,
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

  private async generateNonRetrievalAnswer(input: {
    retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
    history: MessageRecord[];
    query: string;
    route: ChatTurnRoute;
  }): Promise<string | null> {
    try {
      const answer = (await this.chatGateway.answer({
        query: input.query,
        history: input.history,
        prompt: buildNonRetrievalAnswerPrompt({
          route: input.route,
          responseIdentity: input.retrieval.responseIdentity,
          history: input.history,
          query: input.query,
          answerInstructionBlock: this.sharedAnswerInstructionBuilder.buildCombinedBlock({
            responseIdentity: input.retrieval.responseIdentity,
            customInstruction: input.retrieval.responseSettings.customInstruction,
            conversationMode: input.retrieval.responseSettings.conversationMode,
            responseLanguagePolicy: input.retrieval.responseSettings.responseLanguagePolicy,
          }),
        }),
      })).trim();

      return answer.length > 0 ? answer : null;
    } catch (error) {
      if (error instanceof BlankChatAnswerError) {
        return null;
      }

      throw error;
    }
  }

  private async resolveResponseIdentity(workspaceId: string): Promise<ResponseIdentity | null> {
    if (!this.workspaceRepository) {
      return null;
    }

    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (!workspace) {
      return null;
    }

    const name = workspace.assistantName.trim();
    const role = workspace.assistantRole.trim();
    return name || role
      ? {
          name: name || undefined,
          role: role || undefined,
        }
      : null;
  }
}

type ChatIntentCapableRetrievalPipeline = Pick<
  RetrievalPipelineService,
  "run" | "interpret" | "runInterpreted" | "runWithoutRetrieval"
>;

const supportsChatIntentRouting = (
  pipeline: RetrievalPipelineService,
): boolean => {
  const candidate = pipeline as Partial<ChatIntentCapableRetrievalPipeline>;

  return typeof candidate.run === "function"
    && typeof candidate.interpret === "function"
    && typeof candidate.runInterpreted === "function"
    && typeof candidate.runWithoutRetrieval === "function";
};
