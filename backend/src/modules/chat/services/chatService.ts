import { normalizeProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import { setTraceAttributes, traceAsyncIterable, traceOperation } from "../../../shared/observability/tracing/operations.js";
import {
  createModelCallTraceCollector,
  runAsyncIterableWithModelCallTrace,
  runWithModelCallTrace,
  type ModelCallTraceCollector,
} from "../../../shared/observability/tracing/modelCallTraceContext.js";
import type {
  ConversationEngine,
  ConversationClarificationStore,
  ConversationClarifier,
  ConversationProgressPort,
  ConversationRoutineStore,
  ConversationTrace,
  ClarificationCandidate,
  ConversationChannelContext,
  ClarificationPolicy,
  RecentClarificationReader,
  RoutineActionRequest,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { CHAT_BEHAVIOR, RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../../shared/domain/actionCapabilities.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { ContextVariableRepositoryPort } from "../../../db/repositories/contextVariableRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { BootstrapGreetingCacheRepositoryPort } from "../../../db/repositories/bootstrapGreetingCacheRepository.js";
import type { PendingDecisionRecord } from "../../../db/repositories/pendingDecisionRepository.js";
import type { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AgentService } from "../../agents/public.js";
import type { ResumeRunner } from "../../approvals/public.js";
import type { ChatGateway, ChatGatewayInput } from "../contracts/chatGateway.js";
import type { ChatStatusStage, ChatStreamEvent } from "../contracts/streamEvents.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import type { ChatResponse } from "../types/chatResponses.js";
import type { AssistantPageContext } from "../types/assistantApi.js";
import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";
import {
  NoopUsageLimitPolicy,
  type UsageLimitPolicy,
  type UsageLimitReservation,
} from "../../../shared/domain/usageLimitPolicy.js";
import { ChatSessionPreparer, type PreparedSession } from "./chatSessionPreparer.js";
import type { ConversationSummaryStore } from "../contracts/conversationSummary.js";
import type { ConversationSummaryUpdater } from "./summary/conversationSummaryService.js";
import {
  ChatTurnAssembly,
  type ChatTurnAssemblyFactory,
  buildChatTurnContext,
  type ChatRoutineProvider,
  type ChatTurnAssemblyCoordinationHook,
  type PreparedChatStreamTurnEvent,
  type RetrievalSenseClarificationTurn,
} from "./chatTurnAssembly.js";
import type { RetrievalTurnPort } from "./retrievalTurnDispatch.js";
import {
  noopRouteScopedDirectiveRuntime,
  type RouteScopedDirectiveRuntime,
} from "./routeScopedDirectiveSteering.js";
import { noopDirectiveStateStore, type DirectiveStateStore } from "../../directives/public.js";
import {
  type TurnSkill,
  type TurnStreamSuggestions,
  committedAnswerChunks,
} from "./turnOutcome.js";
import type { ChatTurnRuntime } from "./chatTurnRuntime.js";
import {
  DefaultTurnSelectionStrategy,
  type TurnSelectionStrategy,
} from "./turnSelectionStrategy.js";
import type { AgentSkillTurnSkillProvider } from "./agentSkillTurnSkillProvider.js";
import {
  resolveConversationTurnInterpretationContext,
  type ChatConversationTurnInterpreter,
  type TurnInterpretationContextSettings,
} from "./conversationTurnInterpreter.js";
import type {
  ChatAnswerPresenter,
  ChatPresentedAnswer,
} from "./chatAnswerPresenter.js";
import {
  ChatTurnLifecycle,
  type AssistantTurnPersistencePort,
  type ChatActionOutboxPort,
} from "./chatTurnLifecycle.js";
import { BlankChatAnswerError } from "./chatAnswerErrors.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import { RoutineChatModelGateway } from "./routines/routineChatModelGateway.js";
import {
  createRoutineGroundedAnswerRenderer,
  presentRoutineRenderableAnswer,
} from "./routines/routineGroundedAnswerRenderer.js";
import type { CapturedRoutineTransition } from "./routines/deferredRoutineStore.js";
import { DeferredClarificationStore } from "./clarification/deferredClarificationStore.js";
import {
  resolvePendingClarification,
  type PendingClarificationResolution,
} from "./clarification/pendingClarificationResolver.js";
import { retrievalInputForResolvedSense } from "./clarification/retrievalSenseResolutionInput.js";
import {
  type RetrievalSenseDetectorPort,
  type StructuredRewriteResult,
} from "../../retrieval/public.js";
import {
  contextualDirectiveCandidates,
  lazyPromise,
  planAwareResponseLanguage,
  startTurnPlan,
  type ChatTurnPlanHandle,
  type TurnPlanCoordinator,
  type TurnPlanningGate,
} from "./turnPlanCoordinator.js";
import type { TurnPlanDirectiveCandidate } from "./turnPlanService.js";
import { authoredDirectiveToSteeringDirective } from "../../agents/public.js";
import {
  type ClarificationMetricDecision,
  type ClarificationMetricReason,
} from "./clarification/clarificationMetrics.js";
import {
  toConversationAgentConfig,
  toPreparedStagedContext,
} from "./conversationContractMappers.js";
import { resolveContextForTurn } from "../../context-variables/public.js";
import type { TurnRouter } from "./turnRouter.js";
import type { ResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";
import type { HandoffWaitingMessageGenerator } from "../../../shared/services/handoffWaitingMessageGenerator.js";
import {
  isHumanOwned,
  type ConversationOwnershipReader,
} from "../../handoff/public.js";
import { HANDOFF_NOTIFY_ACTION_TYPE } from "./routines/contactRoutine.js";
import { SKILL_TURN_OUTCOME } from "./assistantTurnOutcomeTypes.js";
import {
  ChatTurnSupersededError,
  InMemoryConversationTurnRegistry,
  type ConversationTurnLease,
  type ConversationTurnRegistry,
  type ConversationTurnStage,
} from "./conversationTurnRegistry.js";

export type { ChatGateway } from "../contracts/chatGateway.js";
export type { ChatStreamEvent } from "../contracts/streamEvents.js";
export type { ChatRoutineProvider } from "./chatTurnAssembly.js";
export { buildRoutinePendingDecisionTransition } from "./chatTurnAssembly.js";
export { BlankChatAnswerError } from "./chatAnswerErrors.js";
export { ChatTurnSupersededError } from "./conversationTurnRegistry.js";

const chatTurnTraceAttributes = (input: {
  accountId?: string;
  conversationId?: string;
  sourceChannel?: string | null;
  stream: boolean;
  workspaceId: string;
}): Record<string, unknown> => ({
  "radioso.account_id": input.accountId,
  "radioso.conversation_id": input.conversationId,
  "radioso.workspace_id": input.workspaceId,
  "chat.source_channel": input.sourceChannel ?? "assistant",
  "chat.stream": input.stream,
});

export class ModelChatGateway implements ChatGateway {
  constructor(private readonly inference: ModelInferencePipeline) {}

  private generation(input: ChatGatewayInput) {
    return {
      maxOutputTokens: input.generation?.maxOutputTokens ?? CHAT_BEHAVIOR.answer.maxOutputTokens,
      reasoningEffort: input.generation?.reasoningEffort ?? CHAT_BEHAVIOR.answer.reasoningEffort,
    };
  }

  async answer(input: ChatGatewayInput): Promise<string> {
    const generation = this.generation(input);
    const result = await this.inference.complete({
      operation: input.usageContext,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      maxOutputTokens: generation.maxOutputTokens,
      reasoningEffort: generation.reasoningEffort,
      signal: input.signal,
      validateResult(result) {
        if (!result.text?.trim()) {
          throw new BlankChatAnswerError();
        }
      },
    });
    return result.text;
  }

  async *streamAnswer(input: ChatGatewayInput): AsyncIterable<string> {
    const generation = this.generation(input);
    const { textStream } = this.inference.stream({
      operation: input.usageContext,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      maxOutputTokens: generation.maxOutputTokens,
      reasoningEffort: generation.reasoningEffort,
      signal: input.signal,
    });
    for await (const chunk of textStream) {
      if (chunk.length > 0) {
        yield chunk;
      }
    }
  }
}

export class OpenAIChatGateway extends ModelChatGateway {}

export interface SuspendedRoutineReader {
  loadSuspended(input: { sessionId: string }): Promise<RoutineState | null>;
}

// A teammate has engaged the thread once any message was authored by a human
// operator (a direct reply, or one sent on behalf of the AI).
const isHumanAgentMessage = (message: { source?: string }): boolean =>
  message.source === "human_agent" ||
  message.source === "human_agent_on_behalf_of_ai_agent";

const suppressedHumanOwnedResponse = (
  session: PreparedSession,
  waitingMessage = "",
): ChatResponse => {
  const now = new Date().toISOString();
  return {
    conversationId: session.conversation.id,
    agentId: session.agent.id,
    agentName: session.agent.name,
    assistantMessageId: "",
    route: {
      type: "direct",
      reason: "social_only",
    },
    answer: waitingMessage,
    citations: [],
    answerSegments: [],
    suggestions: [],
    activitySummary: {
      status: "skipped",
      outcome: "human_owned_suppressed",
      retrievalSkipped: true,
    },
    activityTrace: {
      traceId: `ownership-suppressed-${session.conversation.id}`,
      startedAt: now,
      completedAt: now,
      totalDurationMs: 0,
      stages: [],
      links: [],
    },
    ownership: {
      state: "human_owned",
      suppressed: true,
    },
  };
};

const buildHandoffNotifyAction = (input: {
  conversationId: string;
  workspaceId: string;
  agentId: string;
  userMessageId: string;
  reason: "routine_handoff" | "retrieval_miss";
  routineId?: string;
  stepId?: string;
}): RoutineActionRequest => ({
  type: HANDOFF_NOTIFY_ACTION_TYPE,
  payload: {
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    userMessageId: input.userMessageId,
    reason: input.reason,
    routineId: input.routineId,
    stepId: input.stepId,
    dashboardPath: `/conversations/${input.conversationId}`,
  },
});

const shouldRequestRetrievalMissHandoff = (input: {
  session: PreparedSession;
  presentation: ChatPresentedAnswer;
}): boolean =>
  input.session.agent.handoffOnRetrievalMiss === true
  && input.presentation.skillOutcome === SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT.outcome;

const retrievalMissHandoffForTurn = (input: {
  session: PreparedSession;
  presentation: ChatPresentedAnswer;
  workspaceId: string;
  actions?: RoutineActionRequest[];
}): {
  ownershipHandoff: { reason: "retrieval_miss" } | null;
  actions?: RoutineActionRequest[];
} => {
  if (!shouldRequestRetrievalMissHandoff(input)) {
    return {
      ownershipHandoff: null,
      actions: input.actions,
    };
  }

  return {
    ownershipHandoff: { reason: "retrieval_miss" },
    actions: [
      ...(input.actions ?? []),
      buildHandoffNotifyAction({
        conversationId: input.session.conversation.id,
        workspaceId: input.workspaceId,
        agentId: input.session.agent.id,
        userMessageId: input.session.userMessage.id,
        reason: "retrieval_miss",
      }),
    ],
  };
};

/**
 * Everything ChatService needs to run a turn. The turn runtime (presenter +
 * registered skills) is assembled by composition via {@link buildChatTurnRuntime}
 * and injected — registration lives in the wiring layer, never inline here.
 */
export interface ChatServiceOptions {
  conversationRepository: ConversationRepositoryPort;
  messageRepository: MessageRepositoryPort;
  retrievalTurn: RetrievalTurnPort;
  chatGateway: ChatGateway;
  auditService: AuditService;
  turnRuntime: ChatTurnRuntime;
  productAnalyticsService?: ProductAnalyticsPort;
  workspaceRepository?: Pick<WorkspaceRepositoryPort, "findById">;
  bootstrapGreetingCacheRepository?: BootstrapGreetingCacheRepositoryPort;
  usageLimitPolicy?: UsageLimitPolicy;
  agentService?: Pick<AgentService, "resolve">;
  /** Optional: resolves the agent's enabled host context variables per turn. */
  contextVariableRepository?: Pick<ContextVariableRepositoryPort, "resolveForAgent">;
  directiveSteering?: RouteScopedDirectiveRuntime;
  /** Optional: durable per-conversation directive firing memory for lifecycle suppression (#865). */
  directiveStateStore?: DirectiveStateStore;
  /** Optional: durable per-conversation summary read model for prompt injection. */
  conversationSummaryStore?: Pick<ConversationSummaryStore, "load">;
  /** Optional: fire-and-forget per-conversation summary refresh after persisted turns. */
  conversationSummaryUpdater?: ConversationSummaryUpdater;
  selectionStrategy?: TurnSelectionStrategy;
  turnRouter: TurnRouter;
  turnInterpreter?: ChatConversationTurnInterpreter;
  /** The reusable conversation engine drives every chat turn; composition always wires it. */
  conversationEngine: ConversationEngine;
  /** Shared durable/ephemeral engine assembly configured by application composition. */
  turnAssemblyFactory?: ChatTurnAssemblyFactory;
  /** Optional: when wired, routine-emitted fire-and-forget actions are enqueued to the outbox. */
  actionOutbox?: ChatActionOutboxPort;
  assistantTurnPersistence?: AssistantTurnPersistencePort;
  actionCapabilities?: ActionCapabilityMap;
  capabilityPolicy?: CapabilityPolicy;
  logger?: Pick<AppLogger, "warn">;
  conversationOwnershipRepository?: ConversationOwnershipRepository;
  /** Optional: durable per-session routine state store (with {@link routineProvider}). */
  routineStore?: ConversationRoutineStore;
  /** Optional: detects parked routines so fresh visitor messages answer normally. */
  suspendedRoutineReader?: SuspendedRoutineReader;
  /** Optional: detects human-owned conversations so visitor turns do not start AI work. */
  conversationOwnershipReader?: ConversationOwnershipReader;
  /** Optional: registered routines + activation. Empty/absent leaves turns unchanged. */
  routineProvider?: ChatRoutineProvider;
  /** Optional shared per-turn language detector for routine, direct, and retrieval replies. */
  responseLanguageDetector?: ResponseLanguageDetector;
  /** Optional: produces the localized "a teammate is joining" line for human-owned turns. */
  handoffWaitingMessageGenerator?: HandoffWaitingMessageGenerator;
  clarifier?: ConversationClarifier;
  clarifierFactory?: (input: { session: PreparedSession; accountId?: string }) => ConversationClarifier;
  clarificationStore?: ConversationClarificationStore & Partial<RecentClarificationReader>;
  recordClarificationDecision?: (input: { surface: string; decision: ClarificationMetricDecision; reason?: ClarificationMetricReason }) => void;
  retrievalSenseDetector?: RetrievalSenseDetectorPort;
  retrievalSenseClarificationPolicy?: ClarificationPolicy;
  agentSkillTurnSkillProvider?: AgentSkillTurnSkillProvider;
  /** Optional: fused turn-planning coordinator (with {@link turnPlanningGate}). */
  turnPlanCoordinator?: TurnPlanCoordinator;
  /** Optional: gate deciding whether fused turn planning runs for a workspace. */
  turnPlanningGate?: TurnPlanningGate;
  /** Retrieval-owned settings seams used to preserve custom rewrite guidance. */
  turnPlanInterpretationContextSettings?: TurnInterpretationContextSettings;
  /** Per-conversation turn coordinator; application composition wires one process-wide instance. */
  conversationTurnRegistry?: ConversationTurnRegistry;
}

interface TurnCoordinationState {
  lease?: ConversationTurnLease;
}

interface ResumeAwaitingDecisionTurnInput {
  record: PendingDecisionRecord;
  optionId: string;
  payload?: unknown;
  decidedBy: string;
  transaction: Db;
}

export class ChatService {
  private readonly conversationRepository: ConversationRepositoryPort;
  private readonly messageRepository: MessageRepositoryPort;
  private readonly agentService?: Pick<AgentService, "resolve">;
  private readonly chatGateway: ChatGateway;
  private readonly auditService: AuditService;
  private readonly usageLimitPolicy: UsageLimitPolicy;
  private readonly conversationEngine: ConversationEngine;
  private readonly chatAnswerPresenter: ChatAnswerPresenter;
  private readonly chatSessionPreparer: ChatSessionPreparer;
  private readonly chatTurnAssembly: ChatTurnAssembly;
  private readonly chatTurnLifecycle: ChatTurnLifecycle;
  private readonly turnSkills: TurnSkill[];
  private readonly logger?: Pick<AppLogger, "warn">;
  private readonly answerSupport = new ChatAnswerSupport();
  private readonly routineStore?: ConversationRoutineStore;
  private readonly suspendedRoutineReader?: SuspendedRoutineReader;
  private readonly conversationOwnershipReader?: ConversationOwnershipReader;
  private readonly routineProvider?: ChatRoutineProvider;
  private readonly clarifier?: ConversationClarifier;
  private readonly clarifierFactory?: (input: { session: PreparedSession; accountId?: string }) => ConversationClarifier;
  private readonly clarificationStore?: ConversationClarificationStore & Partial<RecentClarificationReader>;
  private readonly recordClarificationDecision?: (input: { surface: string; decision: ClarificationMetricDecision; reason?: ClarificationMetricReason }) => void;
  private readonly retrievalSenseDetector?: RetrievalSenseDetectorPort;
  private readonly directiveRuntime: RouteScopedDirectiveRuntime;
  private readonly turnInterpreter?: ChatConversationTurnInterpreter;
  private readonly turnPlanCoordinator?: TurnPlanCoordinator;
  private readonly turnPlanningGate?: TurnPlanningGate;
  private readonly turnPlanInterpretationContextSettings?: TurnInterpretationContextSettings;
  private readonly responseLanguageDetector?: ResponseLanguageDetector;
  private readonly handoffWaitingMessageGenerator?: HandoffWaitingMessageGenerator;
  private readonly conversationTurnRegistry: ConversationTurnRegistry;
  private readonly streamMetrics?: Pick<MetricsRegistry, "observeHistogram"> | null;

  constructor(options: ChatServiceOptions) {
    const {
      conversationRepository,
      messageRepository,
      retrievalTurn,
      chatGateway,
      auditService,
      turnRuntime,
      productAnalyticsService = new NoopProductAnalyticsService(),
      workspaceRepository,
      bootstrapGreetingCacheRepository,
      usageLimitPolicy = new NoopUsageLimitPolicy(),
      agentService,
      contextVariableRepository,
      directiveSteering = noopRouteScopedDirectiveRuntime,
      directiveStateStore = noopDirectiveStateStore,
      conversationSummaryStore,
      conversationSummaryUpdater,
      selectionStrategy = new DefaultTurnSelectionStrategy(),
      turnRouter,
      turnInterpreter,
      conversationEngine,
      turnAssemblyFactory,
      actionOutbox,
      assistantTurnPersistence,
      actionCapabilities,
      capabilityPolicy,
      logger,
      conversationOwnershipRepository,
      routineStore,
      suspendedRoutineReader,
      conversationOwnershipReader,
      routineProvider,
      responseLanguageDetector,
      handoffWaitingMessageGenerator,
      clarifier,
      clarifierFactory,
      clarificationStore,
      recordClarificationDecision,
      retrievalSenseDetector,
      retrievalSenseClarificationPolicy,
      agentSkillTurnSkillProvider,
      turnPlanCoordinator,
      turnPlanningGate,
      turnPlanInterpretationContextSettings,
      conversationTurnRegistry = new InMemoryConversationTurnRegistry(),
    } = options;
    this.conversationRepository = conversationRepository;
    this.messageRepository = messageRepository;
    this.agentService = agentService;
    this.routineStore = routineStore;
    this.suspendedRoutineReader = suspendedRoutineReader;
    this.conversationOwnershipReader = conversationOwnershipReader;
    this.routineProvider = routineProvider;
    this.responseLanguageDetector = responseLanguageDetector;
    this.handoffWaitingMessageGenerator = handoffWaitingMessageGenerator;
    this.clarifier = clarifier;
    this.clarifierFactory = clarifierFactory;
    this.clarificationStore = clarificationStore;
    this.recordClarificationDecision = recordClarificationDecision;
    this.retrievalSenseDetector = retrievalSenseDetector;
    this.directiveRuntime = directiveSteering;
    const effectiveRetrievalSenseClarificationPolicy = retrievalSenseClarificationPolicy ?? {
      floor: 0,
      margin: 0.15,
      askMargin: 0,
      maxOptions: 4,
    };
    this.chatGateway = chatGateway;
    this.auditService = auditService;
    this.usageLimitPolicy = usageLimitPolicy;
    this.turnInterpreter = turnInterpreter;
    this.turnPlanCoordinator = turnPlanCoordinator;
    this.turnPlanningGate = turnPlanningGate;
    this.turnPlanInterpretationContextSettings = turnPlanInterpretationContextSettings;
    this.conversationEngine = conversationEngine;
    this.conversationTurnRegistry = conversationTurnRegistry;
    this.logger = logger;
    this.chatAnswerPresenter = turnRuntime.chatAnswerPresenter;
    this.turnSkills = turnRuntime.turnSkills;
    this.streamMetrics = turnRuntime.metrics;
    this.chatTurnLifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      productAnalyticsService,
      actionOutbox,
      assistantTurnPersistence,
      actionCapabilities,
      capabilityPolicy,
      logger,
      undefined,
      conversationOwnershipRepository,
      conversationSummaryUpdater,
    );
    this.chatSessionPreparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      auditService,
      workspaceRepository,
      agentService,
      bootstrapGreetingCacheRepository,
      contextVariableRepository,
      conversationSummaryStore,
      logger,
    );
    this.chatTurnAssembly = turnAssemblyFactory?.create({
      chatSessionPreparer: this.chatSessionPreparer,
      directiveStateStore,
      routineStore,
    }) ?? new ChatTurnAssembly({
      chatGateway,
      chatAnswerPresenter: this.chatAnswerPresenter,
      chatSessionPreparer: this.chatSessionPreparer,
      conversationEngine,
      turnSkills: this.turnSkills,
      selectionStrategy,
      directiveRuntime: directiveSteering,
      directiveStateStore,
      turnRouter,
      turnInterpreter,
      routineStore,
      routineProvider,
      clarifier,
      recordClarificationDecision,
      retrievalSenseDetector,
      retrievalSenseClarificationPolicy: effectiveRetrievalSenseClarificationPolicy,
      agentSkillTurnSkillProvider,
      logger,
    });
  }

  private setTurnStage(
    coordination: TurnCoordinationState,
    stage: ConversationTurnStage,
  ): void {
    coordination.lease?.setStage(stage);
  }

  private checkTurnCancellation(
    coordination: TurnCoordinationState,
    stage?: ConversationTurnStage,
  ): void {
    if (stage) {
      this.setTurnStage(coordination, stage);
    }
    coordination.lease?.throwIfCancelled();
  }

  private beginTurnEmission(coordination: TurnCoordinationState): void {
    coordination.lease?.beginEmission();
  }

  private turnAssemblyCoordination(
    coordination: TurnCoordinationState,
  ): ChatTurnAssemblyCoordinationHook {
    return {
      signal: coordination.lease?.signal,
      checkpoint: (stage) => this.checkTurnCancellation(coordination, stage),
    };
  }

  private async releaseUsageReservation(
    reservation: UsageLimitReservation | null,
    input: {
      workspaceId: string;
      conversationId?: string;
      sourceChannel?: string | null;
      stream: boolean;
    },
  ): Promise<void> {
    if (!reservation) {
      return;
    }
    try {
      await reservation.release();
    } catch (error) {
      this.logger?.warn(
        {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          surface: input.sourceChannel ?? "assistant",
          stream: input.stream,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "Chat usage reservation release failed",
      );
    }
  }

  private async registerPreparedTurn(
    coordination: TurnCoordinationState,
    conversationId: string,
  ): Promise<void> {
    if (!coordination.lease) {
      coordination.lease = this.conversationTurnRegistry.start(conversationId);
      await coordination.lease.waitForPredecessor();
    }
    this.checkTurnCancellation(coordination, "preparing");
  }

  /**
   * Attempts the registered routines for this turn — a multi-turn skill selected *before*
   * grounding. Returns the routine's rendered reply when it claims the turn (so the host
   * persists it and skips retrieval), or null when no routines are registered, none is
   * active/activates, or the active routine yields the turn (off-topic) — in which case
   * the host falls through to normal selection + grounding. The next-step selector and
   * renderer generate through a model gateway bound to this turn's usage + workspace
   * context, so the runner is built per turn.
   */
  private attemptRoutineTurn(
    session: PreparedSession,
    accountId: string | undefined,
    responseLanguage: Promise<string | undefined>,
    activeRoutine: RoutineState | null,
    coordination: TurnCoordinationState,
    clarification?: {
      store?: DeferredClarificationStore;
      resolution?: PendingClarificationResolution;
      clarifier?: ConversationClarifier;
    },
    progress?: ConversationProgressPort,
  ): ReturnType<ChatTurnAssembly["attemptRoutineTurn"]> {
    return this.chatTurnAssembly.attemptRoutineTurn(session, {
      accountId,
      responseLanguage,
      activeRoutine,
      clarification,
      progress,
      coordination: this.turnAssemblyCoordination(coordination),
    });
  }

  private buildClarificationTurn(session: PreparedSession): TurnContext {
    return buildChatTurnContext(session);
  }

  private async resolvePendingForTurn(session: PreparedSession, accountId?: string): Promise<{
    store?: DeferredClarificationStore;
    resolution?: PendingClarificationResolution;
    clarifier?: ConversationClarifier;
  }> {
    const clarifier = this.clarifierFactory?.({ session, accountId }) ?? this.clarifier;
    if (!clarifier || !this.clarificationStore) {
      return {};
    }
    const store = new DeferredClarificationStore(this.clarificationStore);
    const resolution = await resolvePendingClarification({
      store,
      recentReader: typeof this.clarificationStore.loadRecent === "function"
        ? this.clarificationStore as RecentClarificationReader
        : undefined,
      clarifier,
      turn: this.buildClarificationTurn(session),
    });
    if (resolution.resolvedPending) {
      const offerOutcome = "offerOutcome" in resolution ? resolution.offerOutcome : undefined;
      const resolutionSource = "source" in resolution ? resolution.source : undefined;
      const decision = offerOutcome === "accepted_alternative"
        ? "offer_accepted_alternative"
        : offerOutcome === "ignored"
          ? "offer_ignored"
          : resolution.kind === "routine_activation" || resolution.kind === "retrieval_sense"
            ? "mapped"
            : (resolution.outcome ?? "declined");
      const surface = resolution.kind === "retrieval_sense" || resolutionSource === "retrieval_sense"
        ? "retrieval_sense"
        : "routine_activation";
      this.recordClarificationDecision?.({ surface, decision });
    }
    return { store, resolution, clarifier };
  }

  async resumeAwaitingDecisionTurn(
    input: ResumeAwaitingDecisionTurnInput,
  ): Promise<{ conversationId: string; resumed: boolean; assistantMessageId?: string }> {
    const coordination: TurnCoordinationState = {
      lease: this.conversationTurnRegistry.start(input.record.conversationId),
    };
    try {
      await coordination.lease?.waitForPredecessor();
      const modelCallTrace = createModelCallTraceCollector();
      return await runWithModelCallTrace(
        modelCallTrace,
        () => this.resumeAwaitingDecisionTurnWithinTrace(
          input,
          coordination,
          modelCallTrace,
        ),
      );
    } catch (error) {
      let preferredError = error;
      try {
        this.checkTurnCancellation(coordination);
      } catch (cancellationError) {
        preferredError = cancellationError;
      }
      throw preferredError;
    } finally {
      coordination.lease?.complete();
    }
  }

  private async resumeAwaitingDecisionTurnWithinTrace(
    input: ResumeAwaitingDecisionTurnInput,
    coordination: TurnCoordinationState,
    modelCallTrace: ModelCallTraceCollector,
  ): Promise<{ conversationId: string; resumed: boolean; assistantMessageId?: string }> {
    if (!this.routineProvider || !this.suspendedRoutineReader) {
      throw new Error("approval_resume_routine_provider_missing");
    }
    if (!this.agentService) {
      throw new Error("approval_resume_agent_service_missing");
    }

    this.checkTurnCancellation(coordination, "preparing");
    let session = await this.prepareDecisionResumeSession(input.record);
    // A resumed routine renders its own reply, so it needs the same response-language guard
    // as every other turn — otherwise the renderer falls back to a weak hint and a routine
    // step authored in another language leaks through (issue #755).
    this.checkTurnCancellation(coordination, "routing");
    session = this.withResponseLanguage(session, await this.detectResponseLanguage({
      workspaceId: input.record.workspaceId,
      accountId: input.decidedBy,
      query: session.userMessage.content,
    }, session));
    this.checkTurnCancellation(coordination, "routing");
    const modelGateway = new RoutineChatModelGateway(this.chatGateway, {
      workspaceContext: this.answerSupport.buildChatWorkspaceContext(session),
      usageContext: this.answerSupport.buildChatUsageContext(session, input.decidedBy, "routine_turn"),
    });
    const routineTurnPorts = await this.routineProvider.forTurn({
      modelGateway,
      agentId: session.agent.id,
      workspaceId: session.conversation.workspaceId,
      accountId: input.decidedBy,
      pinnedRoutineIds: [input.record.routineId],
      responseLanguage: session.responseLanguage,
      groundedAnswerRenderer: createRoutineGroundedAnswerRenderer({
        session,
        accountId: input.decidedBy,
        responseLanguage: session.responseLanguage,
        turnSkills: this.turnSkills,
      }),
      throwIfCancelled: () => this.checkTurnCancellation(coordination, "routing"),
    });
    this.checkTurnCancellation(coordination, "routing");
    if (!routineTurnPorts) {
      throw new Error("approval_resume_routine_ports_missing");
    }

    this.checkTurnCancellation(coordination, "routing");
    const result = await this.conversationEngine.resumeAwaitingDecision({
      agent: toConversationAgentConfig(session.agent),
      turn: this.buildClarificationTurn(session),
      sessionId: input.record.sessionId,
      decision: {
        handle: input.record.handle,
        optionId: input.optionId,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      },
      suspendedReader: {
        loadSuspended: (query) => this.suspendedRoutineReader!.loadSuspended(query),
      },
      routineRunner: routineTurnPorts.runner,
    });
    this.checkTurnCancellation(coordination, "rendering");

    if (!result.resumed) {
      throw new Error("approval_resume_suspended_state_missing");
    }

    const routineStateTransition: CapturedRoutineTransition = result.nextState
      ? { kind: "save", state: result.nextState }
      : { kind: "clear", sessionId: input.record.sessionId };
    const presentation = presentRoutineRenderableAnswer(this.chatAnswerPresenter, result.response);

    this.beginTurnEmission(coordination);
    const completed = await this.chatTurnLifecycle.completeAssistantTurn({
      workspaceId: input.record.workspaceId,
      accountId: input.decidedBy,
      session,
      presentation,
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: result.trace ? this.conversationTraceWithRoutineTrace(session.turnTrace, result.trace) : session.turnTrace,
      modelCallTrace,
      actions: result.actions,
      routineStateTransition,
      additionalAuditEvent: {
        accountId: input.decidedBy,
        workspaceId: input.record.workspaceId,
        eventType: "hitl.decision",
        eventStatus: "success",
        metadata: {
          handle: input.record.handle,
          conversationId: input.record.conversationId,
          agentId: input.record.agentId,
          routineId: input.record.routineId,
          stepId: input.record.stepId,
          optionId: input.optionId,
        },
      },
      transaction: input.transaction,
    });

    return {
      conversationId: input.record.conversationId,
      resumed: result.resumed,
      assistantMessageId: completed.assistantMessageId,
    };
  }

  asApprovalResumeRunner(): ResumeRunner {
    return {
      resume: (input) => this.resumeAwaitingDecisionTurn(input),
    };
  }

  private conversationTraceWithRoutineTrace(
    trace: ConversationTrace,
    routineTrace: NonNullable<Awaited<ReturnType<ConversationEngine["resumeAwaitingDecision"]>>["trace"]>,
  ): ConversationTrace {
    return {
      ...trace,
      stages: [
        ...trace.stages,
        {
          id: `routine-decision:${routineTrace.routineId}`,
          kind: "routine",
          status: "applied",
          startedAt: new Date().toISOString(),
          outputs: {
            routineId: routineTrace.routineId,
            filledSlotKeys: routineTrace.filledSlotKeys,
            steps: routineTrace.steps.map((step) => ({
              stepId: step.stepId,
              kind: step.kind,
              event: step.event,
            })),
          },
        },
      ],
    };
  }

  private async prepareDecisionResumeSession(record: PendingDecisionRecord): Promise<PreparedSession> {
    const conversation = await this.conversationRepository.findByIdAndWorkspaceId(
      record.conversationId,
      record.workspaceId,
    );
    if (!conversation || conversation.agentId !== record.agentId) {
      throw new Error("approval_resume_conversation_not_found");
    }
    const agent = await this.agentService!.resolve(record.workspaceId, record.agentId);
    const history = await this.messageRepository.listRecentByConversationId(
      record.workspaceId,
      record.conversationId,
      RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages,
    );
    const userMessage = [...history].reverse().find((message) => message.role === "user");
    if (!userMessage) {
      throw new Error("approval_resume_user_message_missing");
    }
    const retrieval = this.directDecisionResumeRetrieval(record, agent);
    return {
      agent,
      conversation,
      history,
      retrieval,
      turnRoute: CHAT_TURN_ROUTE.DIRECT,
      turnFraming: { isIdentityQuestion: false },
      userMessage,
      effectiveQuery: userMessage.content,
      pageContext: null,
      stagedContext: [toPreparedStagedContext(retrieval)],
      resolvedContext: resolveContextForTurn(null),
      turnTrace: {
        traceId: `approval-resume-${record.handle}`,
        startedAt: new Date().toISOString(),
        stages: [],
        links: [],
      },
    };
  }

  private directDecisionResumeRetrieval(
    record: PendingDecisionRecord,
    agent: PreparedSession["agent"],
  ): PreparedSession["retrieval"] {
    const now = new Date().toISOString();
    return {
      rewrittenQuery: "",
      contexts: [],
      systemPrompt: "",
      prompt: "",
      citations: [],
      responseIdentity: agent.name.trim() ? { name: agent.name.trim() } : null,
      responseSettings: {
        citationDisplayEnabled: false,
        suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
        suggestedQuestionsCount: 0,
        customInstruction: agent.customInstruction,
        responseLanguagePolicy: "match_user_question",
        responseLanguage: agent.assistantDefaultLocale ?? undefined,
      },
      diagnostics: {
        execution: {
          surface: "assistant",
          path: "assistant_direct",
          retrievalInvoked: false,
        },
        rewriteStatus: "skipped",
        rerankStatus: "skipped",
        originalCandidateCount: 0,
        rewrittenCandidateCount: 0,
        lexicalCandidateCount: 0,
        normalizedCandidateCount: 0,
        finalContextCount: 0,
        retrievalSkipped: true,
        candidateFallbackApplied: false,
        fallbackApplied: false,
        rewriteEligible: false,
        rewriteRan: false,
        materialDisagreement: false,
        rewriteProposal: {
          rewrittenQuery: "",
          semanticQuery: "",
          lexicalQuery: "",
          responseLanguagePolicy: "match_user_question",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0,
        },
        triggerAnalysis: {
          status: "skipped_non_retrieval",
          consideredRules: [],
          matchedRuleIds: [],
          unmatchedRuleIds: [],
          matchCount: 0,
          matcherVersion: "approval_resume",
        },
      },
      trace: {
        traceId: `approval-resume-${record.handle}`,
        startedAt: now,
        completedAt: now,
        totalDurationMs: 0,
        stages: [],
        links: [],
      },
    };
  }

  private async loadActiveRoutine(session: PreparedSession): Promise<RoutineState | null> {
    if (!this.routineStore) {
      return null;
    }
    return this.routineStore.loadActive({ sessionId: session.conversation.id });
  }

  private async loadSuspendedRoutine(session: PreparedSession): Promise<RoutineState | null> {
    return this.suspendedRoutineReader?.loadSuspended({ sessionId: session.conversation.id }) ?? null;
  }

  private conversationTraceWithStage(
    trace: ConversationTrace,
    stage: ConversationTrace["stages"][number],
  ): ConversationTrace {
    return this.chatTurnAssembly.conversationTraceWithStage(trace, stage);
  }

  private maybeClarifyRetrievalSense(input: {
    session: PreparedSession;
    accountId?: string;
    clarification: {
      store?: DeferredClarificationStore;
      resolution?: PendingClarificationResolution;
      clarifier?: ConversationClarifier;
    };
    activeRoutineAtTurnStart: boolean;
  }): Promise<RetrievalSenseClarificationTurn | null> {
    return this.chatTurnAssembly.maybeClarifyRetrievalSense(input);
  }

  private detectResponseLanguage(
    input: {
      workspaceId: string;
      accountId?: string;
      query: string;
    },
    session: PreparedSession,
  ): Promise<string | undefined> {
    if (!this.responseLanguageDetector) {
      return Promise.resolve(undefined);
    }
    return this.responseLanguageDetector.detect({
      query: input.query,
      history: session.history,
      workspaceContext: { workspaceId: input.workspaceId },
      usageContext: {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        conversationId: session.conversation.id,
        messageId: session.userMessage.id,
        surface: "assistant",
        operation: "response_language_detection",
        attemptKey: "response_language",
      },
    }).then((result) => {
      setTraceAttributes({ "chat.response.language": result.responseLanguage });
      return result.responseLanguage;
    }).catch(() => undefined);
  }

  /**
   * The turn's response language, sourced from the fused plan on the fast path and
   * from the staged detector otherwise. On the fast path the detector call is never
   * made, which is the fusion's response-language saving. The promise is lazy
   * (start-on-first-await): creating it must not resolve the plan, because the
   * routine activator — which supplies the routine candidates — has to be the
   * first resolver on turns with routines.
   */
  private planAwareResponseLanguagePromise(
    input: { workspaceId: string; accountId?: string; query: string },
    session: PreparedSession,
  ): Promise<string | undefined> {
    const handle = session.turnPlan;
    if (!handle) {
      return this.detectResponseLanguage(input, session);
    }
    return lazyPromise(() =>
      planAwareResponseLanguage({
        handle: () => handle.resolve(null),
        fallback: () => this.detectResponseLanguage(input, session),
      }),
    );
  }

  /**
   * The union-of-routes contextual directive candidates for the fused planner:
   * the same route-agnostic candidate set the directive matcher scopes at match
   * time (direct + retrieval + the turn's provisional route). Route + lifecycle
   * narrowing happens later at resolution, so the planner classifies the union.
   */
  private buildTurnPlanDirectiveCandidates(
    session: PreparedSession,
    accountId: string | undefined,
  ): TurnPlanDirectiveCandidate[] {
    const additionalDirectives = (session.agent.authoredDirectives ?? []).map(authoredDirectiveToSteeringDirective);
    const query = session.effectiveQuery ?? session.userMessage.content;
    return contextualDirectiveCandidates({
      routes: [session.turnRoute, CHAT_TURN_ROUTE.DIRECT, CHAT_TURN_ROUTE.RETRIEVAL],
      directivesForRoute: (route) =>
        this.directiveRuntime.directivesFor({
          workspaceId: session.agent.workspaceId,
          accountId,
          additionalDirectives,
          turnContext: { query, route },
        }),
    });
  }

  /**
   * Creates the lazy fused turn-plan handle for this turn when the gate allows and
   * no pre-engine bypass signal holds (active routine, pending clarification or
   * decision, or a parked routine). The handle is memoized on the session; the
   * earliest consumer (the plan-aware routine activator when routines are wired,
   * otherwise the turn interpreter / language / directive adapters) starts the one
   * planner call. A `bypassed`/`failed` outcome sends every adapter to its staged
   * fallback — all-or-nothing per turn.
   */
  private startTurnPlan(
    input: { workspaceId: string; accountId?: string; query: string },
    session: PreparedSession,
    bypass: { activeRoutine?: boolean; pendingClarification?: boolean; suspendedRoutine?: boolean },
    signal?: AbortSignal,
  ): void {
    const handle = startTurnPlan({
      coordinator: this.turnPlanCoordinator,
      gate: this.turnPlanningGate,
      workspaceId: session.agent.workspaceId,
      bypass,
      plan: () => ({
        query: input.query,
        history: session.history,
        ...resolveConversationTurnInterpretationContext({
          workspaceId: session.agent.workspaceId,
          responseIdentity: session.retrieval.responseIdentity,
          customInstruction: session.agent.customInstruction,
          agentSkillSettings: session.agent.skillSettings,
          conversationSummary: session.conversationSummary,
        }, this.turnPlanInterpretationContextSettings),
        directiveCandidates: this.buildTurnPlanDirectiveCandidates(session, input.accountId),
        workspaceContext: { workspaceId: session.agent.workspaceId },
        usageContext: {
          accountId: input.accountId,
          workspaceId: session.agent.workspaceId,
          conversationId: session.conversation.id,
          messageId: session.userMessage.id,
          surface: "assistant",
          operation: "turn_planning",
          attemptKey: `${session.userMessage.id}:turn_planning`,
        },
        signal,
      }),
    });
    if (handle) {
      session.turnPlan = handle;
    }
  }

  /**
   * Builds the localized "a teammate is joining, please wait" line shown on a
   * human-owned (suppressed) turn. Generation is best-effort: on any failure this
   * returns "" and the caller renders nothing rather than failing the turn.
   */
  private async generateHandoffWaitingMessage(
    input: {
      workspaceId: string;
      accountId?: string;
      query: string;
    },
    session: PreparedSession,
  ): Promise<string> {
    if (!this.handoffWaitingMessageGenerator) {
      return "";
    }
    // Only announce that a teammate is "joining" before one has actually replied.
    // Once a human operator has spoken in the thread they have already joined, so
    // further suppressed turns stay silent and let the operator handle them.
    if (session.history.some(isHumanAgentMessage)) {
      return "";
    }
    try {
      const message = await this.handoffWaitingMessageGenerator.generate({
        query: input.query,
        history: session.history,
        workspaceContext: { workspaceId: input.workspaceId },
        usageContext: {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          conversationId: session.conversation.id,
          messageId: session.userMessage.id,
          surface: "assistant",
          operation: "handoff_waiting_message",
          attemptKey: "handoff_waiting",
        },
      });
      setTraceAttributes({ "chat.handoff.waiting_message_generated": message.length > 0 });
      return message;
    } catch {
      setTraceAttributes({ "chat.handoff.waiting_message_generated": false });
      return "";
    }
  }

  private withResponseLanguage(session: PreparedSession, responseLanguage: string | undefined): PreparedSession {
    return {
      ...session,
      responseLanguage,
    };
  }

  /**
   * Produces the answer for a prepared turn. The conversation engine drives
   * selection + dispatch and renders the outcome through the shared registry,
   * returning its turn trace for audit (`engineTrace`).
   */
  private renderTurn(
    session: PreparedSession,
    input: {
      query: string;
      userExpectedLocale?: string | null;
      accountId?: string;
      coordination?: TurnCoordinationState;
    },
  ): ReturnType<ChatTurnAssembly["renderTurn"]> {
    return this.chatTurnAssembly.renderTurn(session, {
      ...input,
      coordination: input.coordination
        ? this.turnAssemblyCoordination(input.coordination)
        : undefined,
    });
  }

  private interpretChatTurnForPreparation(input: {
    request: {
      workspaceId: string;
      accountId?: string;
      query: string;
    };
    session: PreparedSession;
    resolvedRetrievalSense: boolean;
  }): ReturnType<ChatTurnAssembly["interpretChatTurnForPreparation"]> {
    return this.chatTurnAssembly.interpretChatTurnForPreparation(input);
  }

  private retrievalInputWithRewriteProposal(
    input: Parameters<ChatSessionPreparer["prepareRetrieval"]>[0],
    proposal?: StructuredRewriteResult,
  ): Parameters<ChatSessionPreparer["prepareRetrieval"]>[0] {
    return this.chatTurnAssembly.retrievalInputWithRewriteProposal(input, proposal);
  }

  private renderPreparedByEngine(
    session: PreparedSession,
    input: {
      request: {
        workspaceId: string;
        accountId?: string;
        query: string;
        userExpectedLocale?: string | null;
      };
      retrievalInput: Parameters<ChatSessionPreparer["prepareRetrieval"]>[0];
      responseLanguagePromise: Promise<string | undefined>;
      resolvedRetrievalSense: boolean;
      clarification?: {
        store?: DeferredClarificationStore;
        resolution?: PendingClarificationResolution;
        clarifier?: ConversationClarifier;
      };
      activeRoutineAtTurnStart?: boolean;
      coordination: TurnCoordinationState;
    },
  ): ReturnType<ChatTurnAssembly["renderPreparedByEngine"]> {
    return this.chatTurnAssembly.renderPreparedByEngine(session, {
      ...input,
      coordination: this.turnAssemblyCoordination(input.coordination),
    });
  }

  private async *streamTurn(
    session: PreparedSession,
    input: {
      query: string;
      userExpectedLocale?: string | null;
      accountId?: string;
      coordination?: TurnCoordinationState;
    },
  ): AsyncIterable<PreparedChatStreamTurnEvent> {
    yield* this.chatTurnAssembly.streamTurn(session, {
      ...input,
      coordination: input.coordination
        ? this.turnAssemblyCoordination(input.coordination)
        : undefined,
    });
  }

  private async *streamPreparedByEngine(
    session: PreparedSession,
    input: {
      request: {
        workspaceId: string;
        accountId?: string;
        query: string;
        userExpectedLocale?: string | null;
      };
      retrievalInput: Parameters<ChatSessionPreparer["prepareRetrieval"]>[0];
      responseLanguagePromise: Promise<string | undefined>;
      resolvedRetrievalSense: boolean;
      clarification?: {
        store?: DeferredClarificationStore;
        resolution?: PendingClarificationResolution;
        clarifier?: ConversationClarifier;
      };
      activeRoutineAtTurnStart?: boolean;
      coordination: TurnCoordinationState;
    },
  ): AsyncIterable<PreparedChatStreamTurnEvent & { session?: PreparedSession }> {
    yield* this.chatTurnAssembly.streamPreparedByEngine(session, {
      ...input,
      coordination: this.turnAssemblyCoordination(input.coordination),
    });
  }

  async answer(input: {
    workspaceId: string;
    agentId?: string | null;
    accountId?: string;
    conversationId?: string;
    bootstrapGreetingId?: string;
    query: string;
    stream: boolean;
    userExpectedLocale?: string | null;
    inputMetadata?: UserMessageInputMetadata;
    metadataFilter?: Record<string, unknown>;
    pageContext?: AssistantPageContext | null;
    sourceChannel?: string | null;
    channelContext?: ConversationChannelContext | null;
    chatSessionId?: string | null;
    /** @deprecated Use chatSessionId. */
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    verifiedCustomerId?: string | null;
    verifiedIdentity?: Record<string, unknown> | null;
  }): Promise<ChatResponse> {
    const coordination: TurnCoordinationState = {
      lease: input.conversationId
        ? this.conversationTurnRegistry.start(input.conversationId)
        : undefined,
    };
    try {
      await coordination.lease?.waitForPredecessor();
      const modelCallTrace = createModelCallTraceCollector();
      return await traceOperation({
        name: "chat.turn",
        attributes: chatTurnTraceAttributes(input),
        run: () => runWithModelCallTrace(
          modelCallTrace,
          () => this.answerWithinTrace(input, coordination, modelCallTrace),
        ),
      });
    } finally {
      coordination.lease?.complete();
    }
  }

  private async answerWithinTrace(input: {
    workspaceId: string;
    agentId?: string | null;
    accountId?: string;
    conversationId?: string;
    bootstrapGreetingId?: string;
    query: string;
    stream: boolean;
    userExpectedLocale?: string | null;
    inputMetadata?: UserMessageInputMetadata;
    metadataFilter?: Record<string, unknown>;
    pageContext?: AssistantPageContext | null;
    sourceChannel?: string | null;
    channelContext?: ConversationChannelContext | null;
    chatSessionId?: string | null;
    /** @deprecated Use chatSessionId. */
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    verifiedCustomerId?: string | null;
    verifiedIdentity?: Record<string, unknown> | null;
  }, coordination: TurnCoordinationState, modelCallTrace: ModelCallTraceCollector): Promise<ChatResponse> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");
    let usageReservation: UsageLimitReservation | null = null;

    try {
      usageReservation = await this.usageLimitPolicy.reserveAnswer({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        surface: input.sourceChannel ?? "assistant",
      });
      this.setTurnStage(coordination, "preparing");
      session = await this.chatSessionPreparer.prepare(input, { skipRetrieval: true });
      await this.registerPreparedTurn(coordination, session.conversation.id);
      const ownership = await this.conversationOwnershipReader?.load(session.conversation.id) ?? null;
      this.checkTurnCancellation(coordination, "routing");
      if (isHumanOwned(ownership)) {
        const waitingMessage = await this.generateHandoffWaitingMessage(input, session);
        this.checkTurnCancellation(coordination, "rendering");
        this.beginTurnEmission(coordination);
        await this.releaseUsageReservation(usageReservation, {
          ...input,
          conversationId: session.conversation.id,
        });
        return suppressedHumanOwnedResponse(session, waitingMessage);
      }

      const clarification = await this.resolvePendingForTurn(session, input.accountId);
      const activeRoutine = await this.loadActiveRoutine(session);
      const activeRoutineAtTurnStart = activeRoutine?.status === "active";
      const suspendedRoutine = await this.loadSuspendedRoutine(session);
      // Fuse this turn's classification calls into one plan (memoized on the session)
      // when eligible; the interpreter, response-language, and directive adapters then
      // consume it, falling back to their staged calls when it is absent or invalid.
      this.startTurnPlan(input, session, {
        activeRoutine: activeRoutineAtTurnStart,
        pendingClarification: clarification.resolution?.resolvedPending === true,
        suspendedRoutine: Boolean(suspendedRoutine),
      }, coordination.lease?.signal);
      const responseLanguagePromise = this.planAwareResponseLanguagePromise(input, session);
      // A routine is a multi-turn skill: attempt it before grounding. If it claims the
      // turn, there is no retrieval — the routine renders its own reply.
      const routineStartedAt = Date.now();
      this.checkTurnCancellation(coordination, "routing");
      const routineTurn = suspendedRoutine
        ? null
        : await this.attemptRoutineTurn(
            session,
            input.accountId,
            responseLanguagePromise,
            activeRoutine,
            coordination,
            clarification,
          );
      this.checkTurnCancellation(coordination, "routing");
      if (routineTurn) {
        session = this.withResponseLanguage(session, await responseLanguagePromise);
        const ownershipHandoff = routineTurn.handoff
          ? { reason: "routine_handoff" as const, ...routineTurn.handoff }
          : null;
        const actions = routineTurn.handoff
          ? [
              ...(routineTurn.actions ?? []),
              buildHandoffNotifyAction({
                conversationId: session.conversation.id,
                workspaceId: input.workspaceId,
                agentId: session.agent.id,
                userMessageId: session.userMessage.id,
                reason: "routine_handoff",
                routineId: routineTurn.handoff.routineId,
                stepId: routineTurn.handoff.stepId,
              }),
            ]
          : routineTurn.actions;
        this.beginTurnEmission(coordination);
        const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          session,
          presentation: routineTurn.presentation,
          answerStartedAt: routineStartedAt,
          stream: input.stream,
          engineTrace: routineTurn.engineTrace,
          modelCallTrace,
          actions,
          routineStateTransition: routineTurn.routineStateTransition,
          pendingDecisionTransition: routineTurn.pendingDecisionTransition,
          ownershipHandoff,
          suspended: routineTurn.suspended,
          commitRoutineState: routineTurn.commitRoutineState,
          clarificationTransition: routineTurn.clarificationTransition,
          commitClarificationState: routineTurn.commitClarificationState,
        });
        assistantMessageId = completedTurn.assistantMessageId;
        await usageReservation.commit();
        return completedTurn.response;
      }

      // The router is authoritative for fresh turns, but resolving a retrieval-sense
      // clarification forces this turn through grounded retrieval scoped to the chosen
      // sense — the short answer ("Hatha", "the first one") would otherwise route
      // direct and silently drop the document scope.
      const resolvedRetrievalSense = clarification.resolution?.kind === "retrieval_sense";
      const retrievalInput = retrievalInputForResolvedSense(input, clarification.resolution);
      const answerStartedAt = Date.now();
      if (!this.turnInterpreter && (this.retrievalSenseDetector || resolvedRetrievalSense)) {
        const interpreted = await this.interpretChatTurnForPreparation({
          request: {
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            query: retrievalInput.query,
          },
          session,
          resolvedRetrievalSense,
        });
        this.checkTurnCancellation(coordination, "routing");
        const routing = {
          route: interpreted.route,
          framing: interpreted.framing,
        };
        const preparedRetrievalInput = this.retrievalInputWithRewriteProposal(
          retrievalInput,
          interpreted.rewriteProposal,
        );
        const groundTurn = resolvedRetrievalSense || routing.route === CHAT_TURN_ROUTE.RETRIEVAL;
        session = this.withResponseLanguage(session, await responseLanguagePromise);
        session = groundTurn
          ? await this.chatSessionPreparer.prepareRetrieval(preparedRetrievalInput, session, routing.framing)
          : await this.chatSessionPreparer.prepareDirect(retrievalInput, session, routing.framing);
        this.checkTurnCancellation(coordination, "rendering");
        const clarificationTurn = groundTurn
          ? await this.maybeClarifyRetrievalSense({
              session,
              accountId: input.accountId,
              clarification,
              activeRoutineAtTurnStart,
            })
          : null;
        if (clarificationTurn?.kind === "continue" && clarificationTurn.documentScope) {
          session = await this.chatSessionPreparer.prepareRetrieval(
            {
              ...preparedRetrievalInput,
              documentScope: clarificationTurn.documentScope,
            },
            session,
            routing.framing,
          );
          this.checkTurnCancellation(coordination, "rendering");
        }
        if (clarificationTurn?.kind === "continue" && clarificationTurn.offerAlternatives) {
          session = {
            ...session,
            retrievalSenseOfferAlternatives: clarificationTurn.offerAlternatives,
          };
        }
        this.checkTurnCancellation(coordination, "rendering");
        const renderedTurn = clarificationTurn?.kind === "ask"
          ? { presentation: clarificationTurn.presentation, engineTrace: clarificationTurn.engineTrace, actions: undefined }
          : await this.renderTurn(session, { ...retrievalInput, coordination });
        this.checkTurnCancellation(coordination, "rendering");
        const { presentation, actions } = renderedTurn;
        const engineTrace = clarificationTurn?.kind === "continue" && clarificationTurn.stage && renderedTurn.engineTrace
          ? this.conversationTraceWithStage(renderedTurn.engineTrace, clarificationTurn.stage)
          : renderedTurn.engineTrace;
        const retrievalMissHandoff = retrievalMissHandoffForTurn({
          session,
          presentation,
          workspaceId: input.workspaceId,
          actions,
        });
        this.beginTurnEmission(coordination);
        const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          session,
          presentation,
          answerStartedAt,
          stream: input.stream,
          engineTrace,
          modelCallTrace,
          actions: retrievalMissHandoff.actions,
          ownershipHandoff: retrievalMissHandoff.ownershipHandoff,
          clarificationTransition: clarification.store?.getTransition(),
          commitClarificationState: clarification.store ? () => clarification.store!.commit() : undefined,
        });
        assistantMessageId = completedTurn.assistantMessageId;
        await usageReservation.commit();

        return completedTurn.response;
      }
      const preparedTurn = await this.renderPreparedByEngine(session, {
        request: {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          query: retrievalInput.query,
          userExpectedLocale: input.userExpectedLocale,
        },
        retrievalInput,
        responseLanguagePromise,
        resolvedRetrievalSense,
        clarification,
        activeRoutineAtTurnStart,
        coordination,
      });
      this.checkTurnCancellation(coordination, "rendering");
      session = preparedTurn.session;
      const renderedTurn = preparedTurn;
      const { presentation, actions } = renderedTurn;
      const engineTrace = renderedTurn.engineTrace;
      const retrievalMissHandoff = retrievalMissHandoffForTurn({
        session,
        presentation,
        workspaceId: input.workspaceId,
        actions,
      });
      this.beginTurnEmission(coordination);
      const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        session,
        presentation,
        answerStartedAt,
        stream: input.stream,
        engineTrace,
        modelCallTrace,
        actions: retrievalMissHandoff.actions,
        ownershipHandoff: retrievalMissHandoff.ownershipHandoff,
        clarificationTransition: clarification.store?.getTransition(),
        commitClarificationState: clarification.store ? () => clarification.store!.commit() : undefined,
      });
      assistantMessageId = completedTurn.assistantMessageId;
      await usageReservation.commit();

      return completedTurn.response;
    } catch (error) {
      let preferredError = error;
      try {
        this.checkTurnCancellation(coordination);
      } catch (cancellationError) {
        preferredError = cancellationError;
      }
      await this.releaseUsageReservation(usageReservation, {
        ...input,
        conversationId: session?.conversation.id ?? input.conversationId,
      });
      if (preferredError instanceof ChatTurnSupersededError) {
        throw preferredError;
      }
      const normalizedError = normalizeProviderCredentialError(preferredError);
      await this.chatTurnLifecycle.recordFailure(input, session, assistantMessageId, normalizedError, workflowPolicy);
      throw normalizedError;
    }
  }

  async *streamAnswer(input: {
    workspaceId: string;
    agentId?: string | null;
    accountId?: string;
    conversationId?: string;
    bootstrapGreetingId?: string;
    query: string;
    stream: boolean;
    userExpectedLocale?: string | null;
    inputMetadata?: UserMessageInputMetadata;
    metadataFilter?: Record<string, unknown>;
    pageContext?: AssistantPageContext | null;
    sourceChannel?: string | null;
    channelContext?: ConversationChannelContext | null;
    chatSessionId?: string | null;
    /** @deprecated Use chatSessionId. */
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    verifiedCustomerId?: string | null;
    verifiedIdentity?: Record<string, unknown> | null;
  }): AsyncIterable<ChatStreamEvent> {
    const streamStartedAt = Date.now();
    const coordination: TurnCoordinationState = {
      lease: input.conversationId
        ? this.conversationTurnRegistry.start(input.conversationId)
        : undefined,
    };
    try {
      await coordination.lease?.waitForPredecessor();
      const modelCallTrace = createModelCallTraceCollector();
      yield* runAsyncIterableWithModelCallTrace(modelCallTrace, () =>
        traceAsyncIterable({
          name: "chat.turn",
          attributes: chatTurnTraceAttributes(input),
          createIterable: () => this.streamAnswerWithinTrace(
            input,
            coordination,
            modelCallTrace,
            streamStartedAt,
          ),
        }));
    } finally {
      coordination.lease?.complete();
    }
  }

  private async *streamAnswerWithinTrace(input: {
    workspaceId: string;
    agentId?: string | null;
    accountId?: string;
    conversationId?: string;
    bootstrapGreetingId?: string;
    query: string;
    stream: boolean;
    userExpectedLocale?: string | null;
    inputMetadata?: UserMessageInputMetadata;
    metadataFilter?: Record<string, unknown>;
    pageContext?: AssistantPageContext | null;
    sourceChannel?: string | null;
    channelContext?: ConversationChannelContext | null;
    chatSessionId?: string | null;
    /** @deprecated Use chatSessionId. */
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    verifiedCustomerId?: string | null;
    verifiedIdentity?: Record<string, unknown> | null;
  }, coordination: TurnCoordinationState, modelCallTrace: ModelCallTraceCollector, streamStartedAt: number): AsyncIterable<ChatStreamEvent> {
    let firstAnswerChunkObserved = false;
    const observeFirstAnswerChunk = (
      route: "direct" | "retrieval" | "routine" | "other",
      deliveryMode: "live" | "committed" | "bounded_decline",
    ): void => {
      if (firstAnswerChunkObserved) {
        return;
      }
      firstAnswerChunkObserved = true;
      this.streamMetrics?.observeHistogram("chat_stream_first_answer_chunk_latency_ms", {
        help: "Latency from chat stream start to the first assistant answer chunk",
        labels: { route, delivery_mode: deliveryMode },
        value: Date.now() - streamStartedAt,
      });
    };
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;
    let lazySuggestionsPromise:
      | Promise<Pick<ChatPresentedAnswer, "suggestions">>
      | undefined;
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");
    let usageReservation: UsageLimitReservation | null = null;
    let usageReservationCommitted = false;
    let usageReservationReleased = false;
    let lastPublicStatus: ChatStatusStage | undefined;
    const shouldEmitStatus = (stage: ChatStatusStage): boolean => {
      this.checkTurnCancellation(coordination);
      if (lastPublicStatus === stage) {
        return false;
      }
      lastPublicStatus = stage;
      return true;
    };
    const releaseUsageReservation = async () => {
      if (!usageReservation || usageReservationCommitted || usageReservationReleased) {
        return;
      }
      usageReservationReleased = true;
      await this.releaseUsageReservation(usageReservation, {
        ...input,
        conversationId: session?.conversation.id ?? input.conversationId,
      });
    };

    try {
      // Keep the #868 turn stage "waiting" until after reserveAnswer succeeds:
      // supersession during acquisition must continue to report that stage.
      usageReservation = await this.usageLimitPolicy.reserveAnswer({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        surface: input.sourceChannel ?? "assistant",
      });
      this.setTurnStage(coordination, "preparing");
      session = await this.chatSessionPreparer.prepare(input, { skipRetrieval: true });
      await this.registerPreparedTurn(coordination, session.conversation.id);
      const ownership = await this.conversationOwnershipReader?.load(session.conversation.id) ?? null;
      this.checkTurnCancellation(coordination, "routing");
      if (isHumanOwned(ownership)) {
        if (shouldEmitStatus("interpreting")) {
          yield { type: "status", stage: "interpreting" };
          this.checkTurnCancellation(coordination);
        }
        if (shouldEmitStatus("composing")) {
          yield { type: "status", stage: "composing" };
          this.checkTurnCancellation(coordination, "rendering");
        }
        await releaseUsageReservation();
        const waitingMessage = await this.generateHandoffWaitingMessage(input, session);
        this.checkTurnCancellation(coordination, "rendering");
        this.beginTurnEmission(coordination);
        for (const text of committedAnswerChunks(waitingMessage)) {
          observeFirstAnswerChunk("other", "committed");
          yield { type: "chunk", text };
        }
        coordination.lease?.complete();
        yield { type: "done", ...suppressedHumanOwnedResponse(session, waitingMessage) };
        return;
      }

      const clarification = await this.resolvePendingForTurn(session, input.accountId);
      const activeRoutine = await this.loadActiveRoutine(session);
      const activeRoutineAtTurnStart = activeRoutine?.status === "active";
      const suspendedRoutine = await this.loadSuspendedRoutine(session);
      this.startTurnPlan(input, session, {
        activeRoutine: activeRoutineAtTurnStart,
        pendingClarification: clarification.resolution?.resolvedPending === true,
        suspendedRoutine: Boolean(suspendedRoutine),
      }, coordination.lease?.signal);
      const responseLanguagePromise = this.planAwareResponseLanguagePromise(input, session);

      // Match main's complete JSON preflight boundary: all state reads above must
      // succeed before the first SSE event commits the response.
      if (shouldEmitStatus("interpreting")) {
        yield { type: "status", stage: "interpreting" };
        this.checkTurnCancellation(coordination);
      }
      yield {
        type: "conversation",
        conversationId: session.conversation.id,
      };
      this.checkTurnCancellation(coordination, "routing");

      // A routine is a multi-turn skill: attempt it before grounding. If it claims the
      // turn, stream its rendered reply and finish — no retrieval.
      const routineStartedAt = Date.now();
      this.checkTurnCancellation(coordination, "routing");
      const routineResult: { value: Awaited<ReturnType<ChatService["attemptRoutineTurn"]>> } = { value: null };
      if (!suspendedRoutine) {
        // A routine attempt is speculative: it may yield back to interpretation and
        // retrieval. Keep its composing phase private until it claims the turn so the
        // public sequence never backtracks from composing to interpreting/searching.
        routineResult.value = await this.attemptRoutineTurn(
          session,
          input.accountId,
          responseLanguagePromise,
          activeRoutine,
          coordination,
          clarification,
        );
      }
      const routineTurn = routineResult.value;
      this.checkTurnCancellation(coordination, "routing");
      if (routineTurn) {
        if (shouldEmitStatus("composing")) {
          yield { type: "status", stage: "composing" };
          this.checkTurnCancellation(coordination, "rendering");
        }
        session = this.withResponseLanguage(session, await responseLanguagePromise);
        const ownershipHandoff = routineTurn.handoff
          ? { reason: "routine_handoff" as const, ...routineTurn.handoff }
          : null;
        const actions = routineTurn.handoff
          ? [
              ...(routineTurn.actions ?? []),
              buildHandoffNotifyAction({
                conversationId: session.conversation.id,
                workspaceId: input.workspaceId,
                agentId: session.agent.id,
                userMessageId: session.userMessage.id,
                reason: "routine_handoff",
                routineId: routineTurn.handoff.routineId,
                stepId: routineTurn.handoff.stepId,
              }),
            ]
          : routineTurn.actions;
        // Durably enqueue the action + advance routine state + persist the reply BEFORE
        // streaming the confirmation. The routine reply is rendered whole (not token-
        // streamed), so delaying the chunk costs nothing — but it means the visitor only
        // sees the "sent" confirmation once the request is actually in the outbox; if the
        // enqueue fails this throws before any chunk and the routine stays recoverable.
        this.beginTurnEmission(coordination);
        const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          session,
          presentation: routineTurn.presentation,
          answerStartedAt: routineStartedAt,
          stream: input.stream,
          engineTrace: routineTurn.engineTrace,
          modelCallTrace,
          actions,
          routineStateTransition: routineTurn.routineStateTransition,
          pendingDecisionTransition: routineTurn.pendingDecisionTransition,
          ownershipHandoff,
          suspended: routineTurn.suspended,
          commitRoutineState: routineTurn.commitRoutineState,
          clarificationTransition: routineTurn.clarificationTransition,
          commitClarificationState: routineTurn.commitClarificationState,
        });
        assistantMessageId = completedTurn.assistantMessageId;
        await usageReservation.commit();
        usageReservationCommitted = true;
        for (const text of committedAnswerChunks(routineTurn.presentation.answer)) {
          observeFirstAnswerChunk("routine", "committed");
          yield { type: "chunk", text };
        }
        coordination.lease?.complete();
        yield { type: "done", ...completedTurn.response };
        return;
      }

      // The router is authoritative for fresh turns, but resolving a retrieval-sense
      // clarification forces this turn through grounded retrieval scoped to the chosen
      // sense — the short answer ("Hatha", "the first one") would otherwise route
      // direct and silently drop the document scope.
      const resolvedRetrievalSense = clarification.resolution?.kind === "retrieval_sense";
      const retrievalInput = retrievalInputForResolvedSense(input, clarification.resolution);
      const answerStartedAt = Date.now();
      const useSenseCompatiblePath = Boolean(!this.turnInterpreter && (this.retrievalSenseDetector || resolvedRetrievalSense));
      let clarificationTurn:
        | {
            kind: "ask";
            presentation: ChatPresentedAnswer;
            engineTrace?: ConversationTrace;
          }
        | {
            kind: "continue";
            documentScope?: string[];
            offerAlternatives?: ClarificationCandidate[];
            stage?: ConversationTrace["stages"][number];
          }
        | null = null;
      if (useSenseCompatiblePath) {
        const interpreted = await this.interpretChatTurnForPreparation({
          request: {
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            query: retrievalInput.query,
          },
          session,
          resolvedRetrievalSense,
        });
        this.checkTurnCancellation(coordination, "routing");
        const routing = {
          route: interpreted.route,
          framing: interpreted.framing,
        };
        const preparedRetrievalInput = this.retrievalInputWithRewriteProposal(
          retrievalInput,
          interpreted.rewriteProposal,
        );
        const groundTurn = resolvedRetrievalSense || routing.route === CHAT_TURN_ROUTE.RETRIEVAL;
        session = this.withResponseLanguage(session, await responseLanguagePromise);
        if (groundTurn && shouldEmitStatus("searching")) {
          yield { type: "status", stage: "searching" };
          this.checkTurnCancellation(coordination, "routing");
        }
        session = groundTurn
          ? await this.chatSessionPreparer.prepareRetrieval(preparedRetrievalInput, session, routing.framing)
          : await this.chatSessionPreparer.prepareDirect(retrievalInput, session, routing.framing);
        this.checkTurnCancellation(coordination, "rendering");
        clarificationTurn = groundTurn
          ? await this.maybeClarifyRetrievalSense({
              session,
              accountId: input.accountId,
              clarification,
              activeRoutineAtTurnStart,
            })
          : null;
        if (clarificationTurn?.kind === "continue" && clarificationTurn.documentScope) {
          session = await this.chatSessionPreparer.prepareRetrieval(
            {
              ...preparedRetrievalInput,
              documentScope: clarificationTurn.documentScope,
            },
            session,
            routing.framing,
          );
          this.checkTurnCancellation(coordination, "rendering");
        }
        if (clarificationTurn?.kind === "continue" && clarificationTurn.offerAlternatives) {
          session = {
            ...session,
            retrievalSenseOfferAlternatives: clarificationTurn.offerAlternatives,
          };
        }
        if (clarificationTurn?.kind === "ask") {
          if (shouldEmitStatus("composing")) {
            yield { type: "status", stage: "composing" };
            this.checkTurnCancellation(coordination, "rendering");
          }
          this.checkTurnCancellation(coordination, "rendering");
          this.beginTurnEmission(coordination);
          const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            session,
            presentation: clarificationTurn.presentation,
            answerStartedAt,
            stream: input.stream,
            engineTrace: clarificationTurn.engineTrace,
            modelCallTrace,
            clarificationTransition: clarification.store?.getTransition(),
            commitClarificationState: clarification.store ? () => clarification.store!.commit() : undefined,
          });
          assistantMessageId = completedTurn.assistantMessageId;
          await usageReservation.commit();
          usageReservationCommitted = true;
          for (const text of committedAnswerChunks(clarificationTurn.presentation.answer)) {
            observeFirstAnswerChunk("retrieval", "committed");
            yield { type: "chunk", text };
          }
          coordination.lease?.complete();
          yield { type: "done", ...completedTurn.response };
          return;
        }
      }

      // Route to the capability that claims this turn and stream its answer. When
      // the reusable engine is wired, it drives the terminal selection/dispatch
      // stages; otherwise the host uses the same selection seam directly.
      let finalPresentation: ChatPresentedAnswer | null = null;
      let suggestions: TurnStreamSuggestions | null = null;
      let engineTrace: ConversationTrace | undefined;
      let actions: RoutineActionRequest[] | undefined;
      let emissionStarted = false;
      if (useSenseCompatiblePath) {
        this.checkTurnCancellation(coordination, "rendering");
      }
      const streamEvents = useSenseCompatiblePath
        ? this.streamTurn(session, { ...retrievalInput, coordination })
        : this.streamPreparedByEngine(session, {
            request: {
              workspaceId: input.workspaceId,
              accountId: input.accountId,
              query: retrievalInput.query,
              userExpectedLocale: input.userExpectedLocale,
            },
            retrievalInput,
            responseLanguagePromise,
            resolvedRetrievalSense,
            clarification,
            activeRoutineAtTurnStart,
            coordination,
          });
      for await (const event of streamEvents) {
        if (event.type === "status") {
          if (shouldEmitStatus(event.stage)) {
            yield event;
            this.checkTurnCancellation(coordination);
          }
          continue;
        }
        if (event.type === "chunk") {
          if (!emissionStarted) {
            this.beginTurnEmission(coordination);
            emissionStarted = true;
          }
          observeFirstAnswerChunk(event.route, event.deliveryMode);
          yield {
            type: "chunk",
            text: event.text,
          };
          continue;
        }
        finalPresentation = event.finalPresentation;
        suggestions = event.suggestions;
        engineTrace = event.engineTrace;
        actions = event.actions;
        const eventSession = (event as { session?: PreparedSession }).session;
        if (eventSession) {
          session = eventSession;
        }
      }
      if (clarificationTurn?.kind === "continue" && clarificationTurn.stage && engineTrace) {
        engineTrace = this.conversationTraceWithStage(engineTrace, clarificationTurn.stage);
      }
      if (!finalPresentation || !suggestions) {
        throw new Error("chat_stream_missing_final_presentation");
      }
      if (!session) {
        throw new Error("chat_stream_missing_prepared_session");
      }
      const preparedSession = session;
      // The lazy promise can call chatActionSuggestionService.evaluate (which may
      // hit an LLM). If completeAssistantTurn below throws, we rethrow but the
      // promise stays in flight — swallow its rejection so it can't surface as an
      // unhandled rejection. The post-`done` await still observes the failure and
      // skips emitting suggestions, which is the desired behavior.
      lazySuggestionsPromise = this.composeLazySuggestions({
        session: preparedSession,
        presentation: finalPresentation,
        suggestions,
        userExpectedLocale: input.userExpectedLocale,
      });
      lazySuggestionsPromise.catch(() => undefined);
      const presentation: ChatPresentedAnswer = {
        ...finalPresentation,
        suggestions: undefined,
      };
      const retrievalMissHandoff = retrievalMissHandoffForTurn({
        session: preparedSession,
        presentation,
        workspaceId: input.workspaceId,
        actions,
      });

      if (!emissionStarted) {
        this.beginTurnEmission(coordination);
      }
      const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        session: preparedSession,
        presentation,
        answerStartedAt,
        stream: input.stream,
        engineTrace,
        modelCallTrace,
        actions: retrievalMissHandoff.actions,
        ownershipHandoff: retrievalMissHandoff.ownershipHandoff,
        clarificationTransition: clarification.store?.getTransition(),
        commitClarificationState: clarification.store ? () => clarification.store!.commit() : undefined,
      });
      assistantMessageId = completedTurn.assistantMessageId;
      await usageReservation.commit();
      usageReservationCommitted = true;

      coordination.lease?.complete();
      yield {
        type: "done",
        ...completedTurn.response,
      };

    } catch (error) {
      let preferredError = error;
      try {
        this.checkTurnCancellation(coordination);
      } catch (cancellationError) {
        preferredError = cancellationError;
      }
      await releaseUsageReservation();
      if (preferredError instanceof ChatTurnSupersededError) {
        yield {
          type: "cancelled",
          conversationId: preferredError.conversationId,
          reason: "superseded",
          stage: preferredError.stage,
        };
        return;
      }
      const normalizedError = normalizeProviderCredentialError(preferredError);
      await this.chatTurnLifecycle.recordFailure(input, session, assistantMessageId, normalizedError, workflowPolicy);
      throw normalizedError;
    } finally {
      await releaseUsageReservation();
    }

    if (!lazySuggestionsPromise || !session) {
      return;
    }
    const conversationId = session.conversation.id;

    try {
      const lazySuggestions = await lazySuggestionsPromise;
      if (lazySuggestions.suggestions && lazySuggestions.suggestions.length > 0) {
        const suggestions = lazySuggestions.suggestions ?? [];
        if (assistantMessageId) {
          await this.chatTurnLifecycle.updateSuggestions({
            workspaceId: input.workspaceId,
            conversationId,
            assistantMessageId,
            suggestions,
          });
        }

        yield {
          type: "suggestions",
          conversationId,
          suggestions,
        };
      }
    } catch {
      // Lazy follow-up suggestions are best effort after the answer is already complete.
    }
  }

  private async composeLazySuggestions(input: {
    session: PreparedSession;
    presentation: ChatPresentedAnswer;
    suggestions: TurnStreamSuggestions;
    userExpectedLocale?: string | null;
  }): Promise<Pick<ChatPresentedAnswer, "suggestions">> {
    const { session, presentation, suggestions, userExpectedLocale } = input;
    // The skill decides where question suggestions come from: assistant-voice
    // replies settle their own onto the presentation; retrieval defers to the
    // host's expansion of the model's planned envelope suggestions.
    const questionSuggestions = suggestions.mode === "presentation"
      ? (presentation.suggestions ?? [])
      : (this.chatAnswerPresenter
          .applyAssistantSuggestions(session, presentation, suggestions.planned)
          .suggestions ?? []);
    const actionSuggestionsResult = await this.chatAnswerPresenter.applyActionSuggestions(
      session,
      presentation,
      userExpectedLocale,
    );
    const actionMergedSuggestions = actionSuggestionsResult.suggestions ?? [];
    return { suggestions: [...actionMergedSuggestions, ...questionSuggestions] };
  }

}
