import type { AuditService } from "../../audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import {
  ActivitySummaryPresenter,
  ActivityTracePresenter,
  type ActivityTrace,
  type RewriteContinuityState,
} from "../../retrieval/public.js";
import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import {
  ASSISTANT_TURN_OUTCOME,
  type AssistantTurnOutcome,
  type SkillTurnOutcome,
  legacyAnswerOutcomeForSkillTurnOutcome,
} from "./assistantTurnOutcomeTypes.js";
import type { ChatIntakeResult } from "./chatIntakeProvider.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import { buildRewriteContinuityState } from "./rewriteContinuityState.js";
import { CHAT_TURN_ROUTE } from "./chatTurnIntentService.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";
import type { ChatResponse, ChatRoute, ChatSuggestion } from "../types/chatResponses.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";

export const getChatTurnRoute = (session: PreparedSession): ChatRoute => {
  if (session.turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL) {
    return {
      type: "direct",
      reason: session.retrieval.diagnostics.responseIntent === "assistant_identity"
        ? "assistant_identity"
        : "social_only",
    };
  }

  return {
    type: "retrieval",
    reason: "evidence_required",
  };
};

export interface CompletedAssistantTurn {
  response: ChatResponse;
  assistantMessageId: string;
}

const toPresentationSkillTurnOutcome = (presentation: ChatPresentedAnswer): SkillTurnOutcome => ({
  skillName: presentation.skillName,
  outcome: presentation.skillOutcome,
  status: presentation.skillStatus,
});

const toIntakeSkillTurnOutcome = (intakeResult: ChatIntakeResult): SkillTurnOutcome => ({
  skillName: intakeResult.skillName,
  outcome: intakeResult.skillOutcome ?? "unknown",
  status: intakeResult.status,
});

export class ChatTurnLifecycle {
  private readonly activitySummaryPresenter = new ActivitySummaryPresenter();
  private readonly activityTracePresenter = new ActivityTracePresenter();

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly auditService: AuditService,
    private readonly productAnalyticsService: ProductAnalyticsPort = new NoopProductAnalyticsService(),
  ) {}

  async completeAssistantTurn(input: {
    workspaceId: string;
    accountId?: string;
    session: PreparedSession;
    presentation: ChatPresentedAnswer;
    answerStartedAt: number;
    stream: boolean;
  }): Promise<CompletedAssistantTurn> {
    const route = getChatTurnRoute(input.session);
    const skillTurnOutcome = toPresentationSkillTurnOutcome(input.presentation);
    const activitySummary = this.activitySummaryPresenter.present(input.session.retrieval.diagnostics, {
      execution: {
        surface: "assistant",
        path: route.type === "direct" ? "assistant_direct" : "assistant_retrieval",
        retrievalInvoked: route.type === "retrieval",
      },
    });
    const activityTrace = this.activityTracePresenter.appendAnswerOutcome({
      trace: input.session.retrieval.trace,
      summary: activitySummary,
      outcome: {
        answer: input.presentation.answer,
        stream: input.stream,
        hadContexts: input.session.retrieval.contexts.length > 0,
        retrievalSkipped: input.session.retrieval.diagnostics.retrievalSkipped,
        durationMs: Date.now() - input.answerStartedAt,
        answerOutcome: input.presentation.answerOutcome,
        skillName: skillTurnOutcome.skillName,
        skillOutcome: skillTurnOutcome.outcome,
        skillStatus: skillTurnOutcome.status,
      },
    });
    const resolvedActivitySummary = activityTrace.summary ?? activitySummary;

    const assistantMessage = await this.messageRepository.create({
      conversationId: input.session.conversation.id,
      workspaceId: input.workspaceId,
      role: "assistant",
      content: input.presentation.answer,
      skillName: skillTurnOutcome.skillName,
      skillOutcome: skillTurnOutcome.outcome,
      skillStatus: skillTurnOutcome.status,
      metadata: {
        skillTurn: skillTurnOutcome,
        // Per-turn context required for full-fidelity eval snapshot capture.
        // The eval module reads these fields back when an operator sends the
        // turn to eval, so the snapshot can carry the actual retrieval
        // baseline and composed system prompt this answer was generated
        // from (not just messages_only fidelity).
        retrievedChunks: input.session.retrieval.contexts.map((ctx, index) => ({
          chunkId: ctx.chunkId,
          documentId: ctx.documentId,
          title: ctx.title,
          rank: typeof ctx.promptPosition === "number" ? ctx.promptPosition : index,
          similarity: typeof ctx.similarity === "number" ? ctx.similarity : undefined,
        })),
        composedInstructions: input.session.retrieval.systemPrompt,
        // Best-effort: agent-level chat model override is what we know at
        // this layer. The workspace default chat model (when no override) is
        // not threaded through, so future snapshots from those turns will
        // have a null modelId — acceptable; the eval run record captures the
        // actual model resolved at run time.
        modelProvider: input.session.agent.chatModelOverride?.provider,
        modelId: input.session.agent.chatModelOverride?.model,
        citations: input.presentation.citations ?? [],
        answerSegments: input.presentation.answerSegments,
      },
    });
    await this.finalizeAssistantTurn({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationId: input.session.conversation.id,
      userMessageId: input.session.userMessage.id,
      assistantMessageId: assistantMessage.id,
      skillTurnOutcome,
      answerOutcome: input.presentation.answerOutcome,
      citations: input.presentation.citations ?? [],
      answerSegments: input.presentation.answerSegments,
      suggestions: input.presentation.suggestions,
      priorRewriteContinuityState: input.session.priorRewriteContinuityState,
      diagnostics: input.session.retrieval.diagnostics,
      activityTrace,
      route,
      stream: input.stream,
    });

    return {
      assistantMessageId: assistantMessage.id,
      response: {
        conversationId: input.session.conversation.id,
        agentId: input.session.agent.id,
        agentName: input.session.agent.name,
        assistantMessageId: assistantMessage.id,
        route,
        answer: input.presentation.answer,
        citations: input.presentation.citations,
        answerSegments: input.presentation.answerSegments,
        suggestions: input.presentation.suggestions,
        activitySummary: resolvedActivitySummary,
        activityTrace,
      },
    };
  }

  async completeSkillIntakeTurn(input: {
    workspaceId: string;
    accountId?: string;
    session: PreparedSession;
    intakeResult: ChatIntakeResult;
    stream: boolean;
  }): Promise<ChatResponse> {
    const route: ChatRoute = {
      type: "direct",
      reason: "social_only",
    };
    const skillTurnOutcome = toIntakeSkillTurnOutcome(input.intakeResult);
    const assistantMessage = await this.messageRepository.create({
      conversationId: input.session.conversation.id,
      workspaceId: input.workspaceId,
      role: "assistant",
      content: input.intakeResult.answer,
      skillName: skillTurnOutcome.skillName,
      skillOutcome: skillTurnOutcome.outcome,
      skillStatus: skillTurnOutcome.status,
      metadata: {
        skillTurn: skillTurnOutcome,
        skillIntake: {
          skillName: input.intakeResult.skillName,
          status: input.intakeResult.status,
          skillOutcome: input.intakeResult.skillOutcome,
          stateId: input.intakeResult.stateId,
        },
        activityTrace: input.intakeResult.activityTrace,
      },
    });
    await this.finalizeAssistantTurn({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationId: input.session.conversation.id,
      userMessageId: input.session.userMessage.id,
      assistantMessageId: assistantMessage.id,
      skillTurnOutcome,
      answerOutcome: ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE,
      citations: [],
      answerSegments: undefined,
      suggestions: undefined,
      priorRewriteContinuityState: input.session.priorRewriteContinuityState,
      diagnostics: input.session.retrieval.diagnostics,
      activityTrace: input.intakeResult.activityTrace,
      route,
      stream: input.stream,
      skillIntake: {
        skillName: input.intakeResult.skillName,
        status: input.intakeResult.status,
        skillOutcome: input.intakeResult.skillOutcome,
        stateId: input.intakeResult.stateId,
      },
    });

    return {
      conversationId: input.session.conversation.id,
      agentId: input.session.agent.id,
      agentName: input.session.agent.name,
      assistantMessageId: assistantMessage.id,
      route,
      answer: input.intakeResult.answer,
      citations: [],
      answerSegments: undefined,
      suggestions: undefined,
      activitySummary: input.intakeResult.activitySummary,
      activityTrace: input.intakeResult.activityTrace,
    };
  }

  async updateSuggestions(input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    suggestions: ChatSuggestion[];
  }): Promise<void> {
    await this.auditService.updateChatAnswerSuggestions(input);
  }

  async recordFailure(
    input: {
      workspaceId: string;
      accountId?: string;
      conversationId?: string;
      stream: boolean;
    },
    session: PreparedSession | null,
    existingAssistantMessageId: string | undefined,
    error: unknown,
    workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn"),
  ) {
    if (session && existingAssistantMessageId) {
      await this.conversationRepository.touch(session.conversation.id, input.workspaceId);
    }

    await this.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "chat.answer",
      eventStatus: "failure",
      metadata: {
        stage: "chat.answer",
        workflow: workflowPolicy.workflow,
        executionClass: workflowPolicy.executionClass,
        conversationId: session?.conversation.id ?? input.conversationId,
        userMessageId: session?.userMessage.id,
        assistantMessageId: existingAssistantMessageId,
        stream: input.stream,
        citationCount: 0,
        retrieval: session?.retrieval.diagnostics,
        activityTrace: session?.retrieval.trace
          ? this.activityTracePresenter.appendAnswerOutcome({
              trace: session.retrieval.trace,
              summary: this.activitySummaryPresenter.present(session.retrieval.diagnostics, {
                execution: {
                  surface: "assistant",
                  path: getChatTurnRoute(session).type === "direct" ? "assistant_direct" : "assistant_retrieval",
                  retrievalInvoked: getChatTurnRoute(session).type === "retrieval",
                },
              }),
              outcome: {
                answer: "",
                stream: input.stream,
                hadContexts: session.retrieval.contexts.length > 0,
                retrievalSkipped: session.retrieval.diagnostics.retrievalSkipped,
                durationMs: 0,
              },
            })
          : undefined,
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
    });
    try {
      await this.productAnalyticsService.track({
        eventName: "chat.failed",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        subjectType: "conversation",
        subjectId: session?.conversation.id ?? input.conversationId,
        properties: {
          stream: input.stream,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        },
        source: "backend",
      });
    } catch {
      // Analytics fan-out must not change failure behavior.
    }
  }

  private async finalizeAssistantTurn(input: {
    workspaceId: string;
    accountId?: string;
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
    skillTurnOutcome: SkillTurnOutcome;
    answerOutcome?: AssistantTurnOutcome;
    citations: ChatCitation[];
    answerSegments?: AnswerSegment[];
    suggestions?: ChatSuggestion[];
    priorRewriteContinuityState?: RewriteContinuityState;
    diagnostics: PreparedSession["retrieval"]["diagnostics"];
    activityTrace: ActivityTrace;
    route: ChatRoute;
    stream: boolean;
    skillIntake?: {
      skillName: string;
      status: ChatIntakeResult["status"];
      skillOutcome?: string;
      stateId?: string;
    };
  }): Promise<void> {
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");
    await this.conversationRepository.touch(input.conversationId, input.workspaceId);
    await this.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        workflow: workflowPolicy.workflow,
        executionClass: workflowPolicy.executionClass,
        conversationId: input.conversationId,
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        stream: input.stream,
        skillTurn: input.skillTurnOutcome,
        answerOutcome: input.answerOutcome ?? legacyAnswerOutcomeForSkillTurnOutcome(input.skillTurnOutcome),
        route: {
          generator: "assistant",
          routeType: input.route.type,
          routeReason: input.route.reason,
          retrievalInvoked: input.route.type === "retrieval",
        },
        citationCount: input.citations.length,
        citations: input.citations,
        answerSegments: input.answerSegments,
        suggestions: input.suggestions,
        skillIntake: input.skillIntake,
        rewriteContinuityState: buildRewriteContinuityState({
          previousState: input.priorRewriteContinuityState,
          diagnostics: input.diagnostics,
          citations: input.citations,
        }),
        retrieval: input.diagnostics,
        activityTrace: input.activityTrace,
      },
    });
    try {
      await this.productAnalyticsService.track({
        eventName: "chat.completed",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        subjectType: "conversation",
        subjectId: input.conversationId,
        properties: {
          stream: input.stream,
          answerOutcome: input.answerOutcome,
          skillName: input.skillTurnOutcome.skillName,
          skillOutcome: input.skillTurnOutcome.outcome,
          skillStatus: input.skillTurnOutcome.status,
          citationCount: input.citations.length,
          suggestionCount: input.suggestions?.length ?? 0,
        },
        source: "backend",
      });
    } catch {
      // Analytics fan-out must not change successful chat behavior.
    }
  }
}
