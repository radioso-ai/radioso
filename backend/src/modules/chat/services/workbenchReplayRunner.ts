import type {
  ClarificationPolicy,
  ConversationClarifier,
  ConversationEngine,
  RoutineActionRequest,
  RoutineState,
} from "@radioso/conversation-contract";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ModelCallUsageAttribution } from "../../../shared/domain/modelCallUsageContext.js";
import type { ResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";
import {
  applyAgentConfigOverride,
  authoredDirectiveToSteeringDirective,
  materializeAgentFromConfig,
  type InternalAgentConfig,
} from "../../agents/public.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import {
  contextualDirectiveCandidates,
  lazyPromise,
  planAwareResponseLanguage,
  startTurnPlan,
  type TurnPlanCoordinator,
} from "./turnPlanCoordinator.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type {
  RetrievalSenseDetectorPort,
} from "../../retrieval/public.js";
import type { RetrievalSettingsRecord } from "../../settings/contracts/retrieval.js";
import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import type { ChatGateway } from "../contracts/chatGateway.js";
import type { ChatAnswerPresenter, ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { AgentSkillTurnSkillProvider } from "./agentSkillTurnSkillProvider.js";
import { DeferredClarificationStore } from "./clarification/deferredClarificationStore.js";
import {
  ChatSessionPreparer,
  type PrepareChatSessionInput,
  type PreparedSession,
} from "./chatSessionPreparer.js";
import {
  ChatTurnAssembly,
  type ChatRoutineProvider,
  type ChatTurnAssemblyFactory,
  type ChatTurnAssemblyClarification,
  type ChatTurnAssemblyOptions,
  type ChatTurnAssemblyRoutineResult,
} from "./chatTurnAssembly.js";
import { createEphemeralChatTurnEffectProfile } from "./chatTurnEffectProfile.js";
import { buildTurnTraceForPresentation } from "./chatTurnLifecycle.js";
import {
  resolveConversationTurnInterpretationContext,
  type ChatConversationTurnInterpreter,
  type TurnInterpretationContextSettings,
} from "./conversationTurnInterpreter.js";
import {
  noopRouteScopedDirectiveRuntime,
  type RouteScopedDirectiveRuntime,
} from "./routeScopedDirectiveSteering.js";
import type { RetrievalTurnPort } from "./retrievalTurnDispatch.js";
import type { GroundingSummary } from "./groundingAssertions.js";
import type { TurnTraceEnvelope } from "./turnTraceEnvelope.js";
import type { TurnSkill } from "./turnOutcome.js";
import {
  DefaultTurnSelectionStrategy,
  type TurnSelectionStrategy,
} from "./turnSelectionStrategy.js";
import type { TurnRouter } from "./turnRouter.js";
import type {
  AssistantClientContextCapabilities,
  AssistantPageContext,
} from "../types/assistantApi.js";
import { pageReadCapabilityFromRequest } from "./pageRead/pageReadCapabilityResolver.js";

const DEFAULT_RETRIEVAL_SENSE_CLARIFICATION_POLICY: ClarificationPolicy = {
  floor: 0,
  margin: 0.15,
  askMargin: 0,
  maxOptions: 4,
};

const unavailableRoutineGateway: Pick<ChatGateway, "answer"> = {
  async answer() {
    throw new Error("workbench_replay_routine_gateway_not_configured");
  },
};

const fallbackPresenter = (): ChatAnswerPresenter => ({
  presentNonRetrievalAnswer(answer: string) {
    return {
      answer,
      skillName: "clarification.answer",
      skillOutcome: "completed",
      skillStatus: "completed",
    };
  },
} as ChatAnswerPresenter);

export interface WorkbenchReplayResolvedConfig {
  composedInstructions?: string;
  modelProvider?: string;
  modelId?: string;
  retrievalSettings?: Partial<RetrievalSettingsRecord>;
  /**
   * The frozen rolling summary this replayed turn was given, echoed so an operator
   * can confirm replay injected the same pre-window context a live turn would.
   */
  conversationSummary?: string;
  retrievedChunks: Array<{
    chunkId: string;
    documentId: string;
    title: string;
    rank: number;
    similarity?: number;
    fusedScore?: number;
    semanticScore?: number;
    lexicalScore?: number;
    lexicalRankScore?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface WorkbenchReplayResult {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  groundingSummary?: GroundingSummary;
  turnTrace?: TurnTraceEnvelope;
  actions?: RoutineActionRequest[];
  pendingDecisionTransition?: ChatTurnAssemblyRoutineResult["pendingDecisionTransition"];
  handoff?: ChatTurnAssemblyRoutineResult["handoff"];
  resolvedConfig: WorkbenchReplayResolvedConfig;
}

export interface WorkbenchReplayRunnerOptions {
  retrievalTurn: RetrievalTurnPort;
  /** @deprecated Replay uses an in-memory no-op audit adapter. */
  auditService: AuditService;
  turnSkills: TurnSkill[];
  selectionStrategy?: TurnSelectionStrategy;
  directiveSteering?: RouteScopedDirectiveRuntime;
  conversationEngine: ConversationEngine;
  /** Shared production/replay engine assembly; composition supplies this by default. */
  turnAssemblyFactory?: ChatTurnAssemblyFactory;
  /** Same classifier the live turn uses, so a replayed turn takes the same route. */
  turnRouter: TurnRouter;
  turnInterpreter?: ChatConversationTurnInterpreter;
  routineProvider?: ChatRoutineProvider;
  chatGateway?: Pick<ChatGateway, "answer">;
  chatAnswerPresenter?: ChatAnswerPresenter;
  clarifier?: ConversationClarifier;
  clarifierFactory?: (input: {
    session: PreparedSession;
    accountId?: string;
  }) => ConversationClarifier;
  responseLanguageDetector?: ResponseLanguageDetector;
  retrievalSenseDetector?: RetrievalSenseDetectorPort;
  retrievalSenseClarificationPolicy?: ClarificationPolicy;
  recordClarificationDecision?: ChatTurnAssemblyOptions["recordClarificationDecision"];
  agentSkillTurnSkillProvider?: AgentSkillTurnSkillProvider;
  turnPlanCoordinator?: TurnPlanCoordinator;
  turnPlanInterpretationContextSettings?: TurnInterpretationContextSettings;
  logger?: Pick<AppLogger, "warn">;
}

/**
 * A starting routine position for a replayed turn. It is the full {@link RoutineState}
 * minus `sessionId` (the runner injects the ephemeral conversation id).
 */
export type WorkbenchReplayRoutineStartState = Omit<RoutineState, "sessionId">;

export interface WorkbenchReplayInput {
  workspaceId: string;
  accountId?: string | null;
  sourceAgentId: string;
  baselineAgentConfig: InternalAgentConfig;
  agentConfigOverride?: Partial<InternalAgentConfig>;
  query: string;
  history: MessageRecord[];
  pageContext?: AssistantPageContext | null;
  clientContextCapabilities?: AssistantClientContextCapabilities;
  userExpectedLocale?: string | null;
  routineStartState?: WorkbenchReplayRoutineStartState | null;
  retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  usageAttribution?: ModelCallUsageAttribution;
  /**
   * Rolling conversation summary frozen in the snapshot at capture time. Replay uses
   * it verbatim and never regenerates or persists the summary.
   */
  conversationSummary?: string | null;
}

export class WorkbenchReplayRunner {
  constructor(private readonly options: WorkbenchReplayRunnerOptions) {}

  async run(input: WorkbenchReplayInput): Promise<WorkbenchReplayResult> {
    const mergedConfig = applyAgentConfigOverride(
      input.baselineAgentConfig,
      input.agentConfigOverride ?? {},
    );
    const agent = materializeAgentFromConfig(mergedConfig, {
      agentId: input.sourceAgentId,
      workspaceId: input.workspaceId,
    });
    const effects = createEphemeralChatTurnEffectProfile(input.history);
    const preparer = new ChatSessionPreparer(
      effects.conversationRepository,
      effects.messageRepository,
      this.options.retrievalTurn,
      effects.auditService,
      undefined,
      undefined,
    );
    const prepareInput: PrepareChatSessionInput = {
      workspaceId: input.workspaceId,
      agentId: agent.id,
      query: input.query,
      pageContext: input.pageContext ?? null,
      pageReadCapability: pageReadCapabilityFromRequest(
        input.clientContextCapabilities,
        input.pageContext,
      ),
      sourceChannel: "workbench_replay",
      retrievalSettingsOverride: input.retrievalSettingsOverride,
      usageAttribution: input.usageAttribution,
    };
    const session = await preparer.prepare(prepareInput, {
      skipRetrieval: true,
      preResolvedAgent: agent,
      preResolvedHistory: input.history,
      preResolvedConversationSummary: input.conversationSummary ?? undefined,
    });
    this.startReplayTurnPlan(session, input);
    const routineStore = effects.routineStore(
      input.routineStartState
        ? { ...input.routineStartState, sessionId: session.conversation.id }
        : null,
    );
    const clarificationStore = new DeferredClarificationStore(
      effects.clarificationStore(),
    );
    const clarifier = this.options.clarifierFactory?.({
      session,
      accountId: input.accountId ?? undefined,
    }) ?? this.options.clarifier;
    const clarification: ChatTurnAssemblyClarification = {
      store: clarificationStore,
      clarifier,
    };
    const presenter = this.options.chatAnswerPresenter ?? fallbackPresenter();
    const routineProvider = this.options.routineProvider
      && this.options.chatGateway
      && this.options.chatAnswerPresenter
      ? this.options.routineProvider
      : undefined;
    const assembly = this.options.turnAssemblyFactory?.create({
      chatSessionPreparer: preparer,
      directiveStateStore: effects.directiveStateStore,
      routineStore,
    }) ?? new ChatTurnAssembly({
      chatGateway: this.options.chatGateway ?? unavailableRoutineGateway,
      chatAnswerPresenter: presenter,
      chatSessionPreparer: preparer,
      conversationEngine: this.options.conversationEngine,
      turnSkills: this.options.turnSkills,
      selectionStrategy: this.options.selectionStrategy ?? new DefaultTurnSelectionStrategy(),
      directiveRuntime: this.options.directiveSteering ?? noopRouteScopedDirectiveRuntime,
      directiveStateStore: effects.directiveStateStore,
      turnRouter: this.options.turnRouter,
      turnInterpreter: this.options.turnInterpreter,
      routineStore,
      routineProvider,
      clarifier,
      recordClarificationDecision: this.options.recordClarificationDecision,
      retrievalSenseDetector: this.options.retrievalSenseDetector,
      retrievalSenseClarificationPolicy:
        this.options.retrievalSenseClarificationPolicy
        ?? DEFAULT_RETRIEVAL_SENSE_CLARIFICATION_POLICY,
      agentSkillTurnSkillProvider: this.options.agentSkillTurnSkillProvider,
      logger: this.options.logger,
    });
    const responseLanguagePromise = this.replayResponseLanguagePromise(input, session);
    const activeRoutine = await routineStore.loadActive({
      sessionId: session.conversation.id,
    });
    const answerStartedAt = Date.now();
    const routineResult = await assembly.attemptRoutineTurn(session, {
      accountId: input.accountId ?? undefined,
      responseLanguage: responseLanguagePromise,
      activeRoutine,
      clarification,
    });
    if (routineResult) {
      return this.presentResult({
        input,
        agent,
        session,
        presentation: routineResult.presentation,
        engineTrace: routineResult.engineTrace,
        answerStartedAt,
        actions: routineResult.actions,
        pendingDecisionTransition: routineResult.pendingDecisionTransition,
        handoff: routineResult.handoff,
      });
    }

    const rendered = await assembly.renderPreparedByEngine(session, {
      request: {
        workspaceId: input.workspaceId,
        accountId: input.accountId ?? undefined,
        query: input.query,
        userExpectedLocale: input.userExpectedLocale,
      },
      retrievalInput: prepareInput,
      responseLanguagePromise,
      resolvedRetrievalSense: false,
      clarification,
      activeRoutineAtTurnStart: Boolean(activeRoutine),
    });
    return this.presentResult({
      input,
      agent,
      session: rendered.session,
      presentation: rendered.presentation,
      engineTrace: rendered.engineTrace,
      answerStartedAt,
      actions: rendered.actions,
    });
  }

  private startReplayTurnPlan(session: PreparedSession, input: WorkbenchReplayInput): void {
    const additionalDirectives = (session.agent.authoredDirectives ?? [])
      .map(authoredDirectiveToSteeringDirective);
    const query = session.effectiveQuery ?? session.userMessage.content;
    const directiveRuntime = this.options.directiveSteering ?? noopRouteScopedDirectiveRuntime;
    const handle = startTurnPlan({
      coordinator: this.options.turnPlanCoordinator,
      bypass: {
        activeRoutine: input.routineStartState?.status === "active",
        suspendedRoutine:
          input.routineStartState != null && input.routineStartState.status !== "active",
      },
      plan: () => ({
        query,
        history: session.history,
        ...resolveConversationTurnInterpretationContext({
          workspaceId: session.agent.workspaceId,
          agentSkillSettings: session.agent.skillSettings,
          conversationSummary: session.conversationSummary,
        }, this.options.turnPlanInterpretationContextSettings),
        pageReadCapability: session.pageReadCapability,
        directiveCandidates: contextualDirectiveCandidates({
          routes: [session.turnRoute, CHAT_TURN_ROUTE.DIRECT, CHAT_TURN_ROUTE.RETRIEVAL],
          directivesForRoute: (route) =>
            directiveRuntime.directivesFor({
              workspaceId: session.agent.workspaceId,
              accountId: input.accountId ?? undefined,
              additionalDirectives,
              turnContext: { query, route },
            }),
        }),
        workspaceContext: { workspaceId: session.agent.workspaceId },
        usageContext: {
          accountId: input.accountId ?? undefined,
          workspaceId: session.agent.workspaceId,
          conversationId: session.conversation.id,
          messageId: session.userMessage.id,
          surface: "assistant",
          operation: "turn_planning",
          attemptKey: `${session.userMessage.id}:turn_planning`,
          ...input.usageAttribution,
        },
      }),
    });
    if (handle) {
      session.turnPlan = handle;
    }
  }

  private replayResponseLanguagePromise(
    input: WorkbenchReplayInput,
    session: PreparedSession,
  ): Promise<string | undefined> {
    const fallback = () => this.detectResponseLanguage(input, session);
    const handle = session.turnPlan;
    if (!handle) {
      return fallback();
    }
    return lazyPromise(() =>
      planAwareResponseLanguage({
        handle: () => handle.resolve(null),
        fallback,
      }),
    );
  }

  private async detectResponseLanguage(
    input: WorkbenchReplayInput,
    session: PreparedSession,
  ): Promise<string | undefined> {
    if (!this.options.responseLanguageDetector) {
      return undefined;
    }
    try {
      const result = await this.options.responseLanguageDetector.detect({
        query: input.query,
        history: session.history,
        workspaceContext: { workspaceId: input.workspaceId },
        usageContext: {
          accountId: input.accountId ?? undefined,
          workspaceId: input.workspaceId,
          conversationId: session.conversation.id,
          messageId: session.userMessage.id,
          surface: "assistant",
          operation: "response_language_detection",
          attemptKey: "response_language",
          ...input.usageAttribution,
        },
      });
      return result.responseLanguage;
    } catch {
      return undefined;
    }
  }

  private presentResult(input: {
    input: WorkbenchReplayInput;
    agent: ReturnType<typeof materializeAgentFromConfig>;
    session: PreparedSession;
    presentation: ChatPresentedAnswer;
    engineTrace?: Parameters<typeof buildTurnTraceForPresentation>[0]["engineTrace"];
    answerStartedAt: number;
    actions?: RoutineActionRequest[];
    pendingDecisionTransition?: ChatTurnAssemblyRoutineResult["pendingDecisionTransition"];
    handoff?: ChatTurnAssemblyRoutineResult["handoff"];
  }): WorkbenchReplayResult {
    const tracePresentation = buildTurnTraceForPresentation({
      workspaceId: input.input.workspaceId,
      accountId: input.input.accountId ?? undefined,
      session: input.session,
      presentation: input.presentation,
      answerStartedAt: input.answerStartedAt,
      stream: false,
      engineTrace: input.engineTrace,
    });
    return {
      answer: input.presentation.answer,
      citations: input.presentation.citations,
      answerSegments: input.presentation.answerSegments,
      groundingSummary: input.presentation.groundingSummary,
      turnTrace: tracePresentation.turnTrace,
      actions: input.actions,
      pendingDecisionTransition: input.pendingDecisionTransition,
      handoff: input.handoff,
      resolvedConfig: {
        composedInstructions: input.session.retrieval.systemPrompt,
        modelProvider: input.agent.chatModelOverride?.provider,
        modelId: input.agent.chatModelOverride?.model,
        retrievalSettings: input.input.retrievalSettingsOverride,
        ...(input.session.conversationSummary
          ? { conversationSummary: input.session.conversationSummary }
          : {}),
        retrievedChunks: input.session.retrieval.contexts.map((context, index) => ({
          chunkId: context.chunkId,
          documentId: context.documentId,
          title: context.title,
          rank: typeof context.promptPosition === "number" ? context.promptPosition : index,
          similarity: typeof context.similarity === "number" ? context.similarity : undefined,
          fusedScore: typeof context.fusedScore === "number" ? context.fusedScore : undefined,
          semanticScore: typeof context.semanticScore === "number" ? context.semanticScore : undefined,
          lexicalScore: typeof context.lexicalScore === "number" ? context.lexicalScore : undefined,
          lexicalRankScore:
            typeof context.lexicalRankScore === "number" ? context.lexicalRankScore : undefined,
          metadata: context.metadata,
        })),
      },
    };
  }
}
