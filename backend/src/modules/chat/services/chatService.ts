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
  ConversationRoutineStore,
  ConversationTrace,
  ClarificationCandidate,
  ConversationChannelContext,
  ClarificationPolicy,
  RecentClarificationReader,
  RoutineActionRequest,
  RoutineState,
} from "@radioso/conversation-contract";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
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
import type { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import type { FacetExtractionJobStore } from "../../facets/public.js";
import type { AgentService } from "../../agents/public.js";
import type { ApprovalResumeResult, ResumeRunner } from "../../approvals/public.js";
import type { ChatGateway } from "../contracts/chatGateway.js";
import type { ChatStatusStage, ChatStreamEvent } from "../contracts/streamEvents.js";
import { observeFirstAnswerChunkLatency } from "./streamPerformanceMetrics.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import type { ChatResponse } from "../types/chatResponses.js";
import type {
  AssistantClientContextCapabilities,
  AssistantPageContext,
} from "../types/assistantApi.js";
import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import { visitorMatchContext } from "./visitorMatchContext.js";
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
import {
  ApprovalResumeTurn,
  type SuspendedRoutineReader,
} from "./approvalResumeTurn.js";
import { DeferredClarificationStore } from "./clarification/deferredClarificationStore.js";
import {
  resolvePendingClarification,
  type PendingClarificationResolution,
} from "./clarification/pendingClarificationResolver.js";
import { retrievalInputForResolvedSense } from "./clarification/retrievalSenseResolutionInput.js";
import {
  type RetrievalSenseDetectorPort,
} from "../../retrieval/public.js";
import {
  contextualDirectiveCandidates,
  lazyPromise,
  planAwareResponseLanguage,
  startTurnPlan,
  type ChatTurnPlanHandle,
  type TurnPlanCoordinator,
} from "./turnPlanCoordinator.js";
import type { TurnPlanDirectiveCandidate } from "./turnPlanService.js";
import { authoredDirectiveToSteeringDirective } from "../../agents/public.js";
import {
  type ClarificationMetricDecision,
  type ClarificationMetricReason,
} from "./clarification/clarificationMetrics.js";
import type { TurnRouter } from "./turnRouter.js";
import type { ResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";
import type { HandoffWaitingMessageGenerator } from "../../../shared/services/handoffWaitingMessageGenerator.js";
import type { ModelCallUsageAttribution } from "../../../shared/domain/modelCallUsageContext.js";
import type { TurnExecutionMode } from "../../../shared/domain/turnExecutionMode.js";
import { pageReadCapabilityFromRequest } from "./pageRead/pageReadCapabilityResolver.js";
import {
  isHumanOwned,
  type ConversationOwnershipReader,
} from "../../handoff/public.js";
import {
  buildHandoffNotifyAction,
  isHumanAgentMessage,
  retrievalMissHandoffForTurn,
  suppressedHumanOwnedResponse,
} from "./handoffOwnership.js";
import {
  ChatTurnSupersededError,
  InMemoryConversationTurnRegistry,
  type ConversationTurnLease,
  type ConversationTurnRegistry,
  type ConversationTurnStage,
} from "./conversationTurnRegistry.js";
import { GENERATION_SURFACE } from "../../../shared/domain/generationSurface.js";

export type { ChatGateway } from "../contracts/chatGateway.js";
export type { ChatStreamEvent } from "../contracts/streamEvents.js";
export type { ChatRoutineProvider } from "./chatTurnAssembly.js";
export { buildRoutinePendingDecisionTransition } from "./chatTurnAssembly.js";
export { BlankChatAnswerError } from "./chatAnswerErrors.js";
export { ModelChatGateway, OpenAIChatGateway } from "./chatGateways.js";
export type { SuspendedRoutineReader } from "./approvalResumeTurn.js";
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
  /** Optional: when wired, an eligible visitor message enqueues a facet extraction job (spec 956). */
  facetExtractionJobs?: Pick<FacetExtractionJobStore, "enqueue">;
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
  /** Optional: fused turn-planning coordinator. */
  turnPlanCoordinator?: TurnPlanCoordinator;
  /** Retrieval-owned settings seams used to preserve custom rewrite guidance. */
  turnPlanInterpretationContextSettings?: TurnInterpretationContextSettings;
  /** Per-conversation turn coordinator; application composition wires one process-wide instance. */
  conversationTurnRegistry?: ConversationTurnRegistry;
  workspaceInvalidationPublisher?: WorkspaceInvalidationPublisher;
}

interface TurnCoordinationState {
  lease?: ConversationTurnLease;
}

export interface ChatAnswerInput {
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
  clientContextCapabilities?: AssistantClientContextCapabilities;
  sourceChannel?: string | null;
  channelContext?: ConversationChannelContext | null;
  chatSessionId?: string | null;
  /** @deprecated Use chatSessionId. */
  anonymousSessionId?: string | null;
  sourceOrigin?: string | null;
  verifiedCustomerId?: string | null;
  verifiedIdentity?: Record<string, unknown> | null;
  previewRoutineIds?: string[];
  usageAttribution?: ModelCallUsageAttribution;
  executionMode?: TurnExecutionMode;
}

export interface ChatTurnReceipt {
  response: ChatResponse;
  userMessageId: string;
}

export class ChatService {
  private readonly conversationRepository: ConversationRepositoryPort;
  private readonly messageRepository: MessageRepositoryPort;
  private readonly auditService: AuditService;
  private readonly usageLimitPolicy: UsageLimitPolicy;
  private readonly chatAnswerPresenter: ChatAnswerPresenter;
  private readonly chatSessionPreparer: ChatSessionPreparer;
  private readonly chatTurnAssembly: ChatTurnAssembly;
  private readonly chatTurnLifecycle: ChatTurnLifecycle;
  private readonly approvalResumeTurn: ApprovalResumeTurn;
  private readonly turnSkills: TurnSkill[];
  private readonly logger?: Pick<AppLogger, "warn">;
  private readonly answerSupport = new ChatAnswerSupport();
  private readonly routineStore?: ConversationRoutineStore;
  private readonly suspendedRoutineReader?: SuspendedRoutineReader;
  private readonly conversationOwnershipReader?: ConversationOwnershipReader;
  private readonly clarifier?: ConversationClarifier;
  private readonly clarifierFactory?: (input: { session: PreparedSession; accountId?: string }) => ConversationClarifier;
  private readonly clarificationStore?: ConversationClarificationStore & Partial<RecentClarificationReader>;
  private readonly recordClarificationDecision?: (input: { surface: string; decision: ClarificationMetricDecision; reason?: ClarificationMetricReason }) => void;
  private readonly retrievalSenseDetector?: RetrievalSenseDetectorPort;
  private readonly directiveRuntime: RouteScopedDirectiveRuntime;
  private readonly turnInterpreter?: ChatConversationTurnInterpreter;
  private readonly turnPlanCoordinator?: TurnPlanCoordinator;
  private readonly turnPlanInterpretationContextSettings?: TurnInterpretationContextSettings;
  private readonly responseLanguageDetector?: ResponseLanguageDetector;
  private readonly handoffWaitingMessageGenerator?: HandoffWaitingMessageGenerator;
  private readonly conversationTurnRegistry: ConversationTurnRegistry;
  private readonly streamMetrics?: Pick<MetricsRegistry, "observeHistogram" | "incrementCounter"> | null;

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
      facetExtractionJobs,
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
      turnPlanInterpretationContextSettings,
      conversationTurnRegistry = new InMemoryConversationTurnRegistry(),
      workspaceInvalidationPublisher,
    } = options;
    this.conversationRepository = conversationRepository;
    this.messageRepository = messageRepository;
    this.routineStore = routineStore;
    this.suspendedRoutineReader = suspendedRoutineReader;
    this.conversationOwnershipReader = conversationOwnershipReader;
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
    this.auditService = auditService;
    this.usageLimitPolicy = usageLimitPolicy;
    this.turnInterpreter = turnInterpreter;
    this.turnPlanCoordinator = turnPlanCoordinator;
    this.turnPlanInterpretationContextSettings = turnPlanInterpretationContextSettings;
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
      turnRuntime.metrics,
      workspaceInvalidationPublisher,
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
      facetExtractionJobs,
      workspaceInvalidationPublisher,
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
    this.approvalResumeTurn = new ApprovalResumeTurn({
      conversationRepository,
      messageRepository,
      agentService,
      chatGateway,
      chatAnswerPresenter: this.chatAnswerPresenter,
      chatAnswerSupport: this.answerSupport,
      turnSkills: this.turnSkills,
      conversationEngine,
      chatTurnLifecycle: this.chatTurnLifecycle,
      conversationTurnRegistry,
      routineProvider,
      suspendedRoutineReader,
      detectResponseLanguage: (input, session) => this.detectResponseLanguage(input, session),
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
      turn: buildChatTurnContext(session),
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
    input: Parameters<ResumeRunner["resume"]>[0],
  ): Promise<ApprovalResumeResult> {
    return this.approvalResumeTurn.resume(input);
  }

  asApprovalResumeRunner(): ResumeRunner {
    return this.approvalResumeTurn.asRunner();
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
   * direct + retrieval + the turn's provisional route. Candidate identities
   * preserve route scope so same-named directives are classified independently;
   * lifecycle narrowing remains owned by the directive runtime.
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
   * The bounded visitor context handed to the planner's directive classification.
   * Counts only — never values — reach the trace: the context can carry visitor
   * data, and the redaction boundary is upstream in the snapshot.
   */
  private planVisitorContext(session: PreparedSession): Record<string, unknown> {
    const { context, dropped, clamped } = visitorMatchContext(session);
    const variableCount = Object.keys(context).length;
    if (variableCount > 0 || dropped.length > 0) {
      setTraceAttributes({
        "chat.directive_match.visitor_context_variables": variableCount,
        "chat.directive_match.visitor_context_dropped": dropped.length,
        "chat.directive_match.visitor_context_clamped": clamped.length,
      });
    }
    return context;
  }

  /**
   * Creates the lazy fused turn-plan handle for this turn when no pre-engine
   * bypass signal holds (active routine, pending clarification or
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
      bypass,
      plan: () => ({
        query: input.query,
        history: session.history,
        ...resolveConversationTurnInterpretationContext({
          workspaceId: session.agent.workspaceId,
          agentSkillSettings: session.agent.skillSettings,
          conversationSummary: session.conversationSummary,
        }, this.turnPlanInterpretationContextSettings),
        pageReadCapability: session.pageReadCapability,
        directiveCandidates: this.buildTurnPlanDirectiveCandidates(session, input.accountId),
        visitorContext: this.planVisitorContext(session),
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

  async answer(input: ChatAnswerInput): Promise<ChatResponse> {
    return (await this.answerWithReceipt(input)).response;
  }

  /** Internal composition seam for callers that need the persisted input/output pair. */
  async answerWithReceipt(input: ChatAnswerInput): Promise<ChatTurnReceipt> {
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

  private async answerWithinTrace(
    input: ChatAnswerInput,
    coordination: TurnCoordinationState,
    modelCallTrace: ModelCallTraceCollector,
  ): Promise<ChatTurnReceipt> {
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
      session = await this.chatSessionPreparer.prepare({
        ...input,
        pageReadCapability: pageReadCapabilityFromRequest(
          input.clientContextCapabilities,
          input.pageContext,
        ),
      }, { skipRetrieval: true });
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
        return {
          response: suppressedHumanOwnedResponse(session, waitingMessage),
          userMessageId: session.userMessage.id,
        };
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
        : await this.chatTurnAssembly.attemptRoutineTurn(session, {
            accountId: input.accountId,
            responseLanguage: responseLanguagePromise,
            activeRoutine,
            clarification,
            coordination: this.turnAssemblyCoordination(coordination),
          });
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
          executionMode: input.executionMode,
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
        return { response: completedTurn.response, userMessageId: session.userMessage.id };
      }

      // The router is authoritative for fresh turns, but resolving a retrieval-sense
      // clarification forces this turn through grounded retrieval scoped to the chosen
      // sense — the short answer ("Hatha", "the first one") would otherwise route
      // direct and silently drop the document scope.
      const resolvedRetrievalSense = clarification.resolution?.kind === "retrieval_sense";
      const retrievalInput = retrievalInputForResolvedSense(input, clarification.resolution);
      const answerStartedAt = Date.now();
      if (!this.turnInterpreter && (this.retrievalSenseDetector || resolvedRetrievalSense)) {
        const interpreted = await this.chatTurnAssembly.interpretChatTurnForPreparation({
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
        const preparedRetrievalInput = this.chatTurnAssembly.retrievalInputWithRewriteProposal(
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
          ? await this.chatTurnAssembly.maybeClarifyRetrievalSense({
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
          : await this.chatTurnAssembly.renderTurn(session, {
              ...retrievalInput,
              coordination: this.turnAssemblyCoordination(coordination),
            });
        this.checkTurnCancellation(coordination, "rendering");
        const { presentation, actions } = renderedTurn;
        const engineTrace = clarificationTurn?.kind === "continue" && clarificationTurn.stage && renderedTurn.engineTrace
          ? this.chatTurnAssembly.conversationTraceWithStage(renderedTurn.engineTrace, clarificationTurn.stage)
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
          executionMode: input.executionMode,
          engineTrace,
          modelCallTrace,
          actions: retrievalMissHandoff.actions,
          ownershipHandoff: retrievalMissHandoff.ownershipHandoff,
          clarificationTransition: clarification.store?.getTransition(),
          commitClarificationState: clarification.store ? () => clarification.store!.commit() : undefined,
        });
        assistantMessageId = completedTurn.assistantMessageId;
        await usageReservation.commit();

        return { response: completedTurn.response, userMessageId: session.userMessage.id };
      }
      const preparedTurn = await this.chatTurnAssembly.renderPreparedByEngine(session, {
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
        coordination: this.turnAssemblyCoordination(coordination),
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
        executionMode: input.executionMode,
        engineTrace,
        modelCallTrace,
        actions: retrievalMissHandoff.actions,
        ownershipHandoff: retrievalMissHandoff.ownershipHandoff,
        clarificationTransition: clarification.store?.getTransition(),
        commitClarificationState: clarification.store ? () => clarification.store!.commit() : undefined,
      });
      assistantMessageId = completedTurn.assistantMessageId;
      await usageReservation.commit();

      return { response: completedTurn.response, userMessageId: session.userMessage.id };
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
        await this.chatTurnLifecycle.recordSupersession(input, session, assistantMessageId, preferredError, workflowPolicy);
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
    clientContextCapabilities?: AssistantClientContextCapabilities;
    sourceChannel?: string | null;
    channelContext?: ConversationChannelContext | null;
    chatSessionId?: string | null;
    /** @deprecated Use chatSessionId. */
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    verifiedCustomerId?: string | null;
    verifiedIdentity?: Record<string, unknown> | null;
    previewRoutineIds?: string[];
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
    clientContextCapabilities?: AssistantClientContextCapabilities;
    sourceChannel?: string | null;
    channelContext?: ConversationChannelContext | null;
    chatSessionId?: string | null;
    /** @deprecated Use chatSessionId. */
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    verifiedCustomerId?: string | null;
    verifiedIdentity?: Record<string, unknown> | null;
    previewRoutineIds?: string[];
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
      observeFirstAnswerChunkLatency(this.streamMetrics, Date.now() - streamStartedAt, {
        route,
        delivery_mode: deliveryMode,
      });
    };
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;
    let lazySuggestionsPromise:
      | Promise<Pick<ChatPresentedAnswer, "suggestions">>
      | undefined;
    let persistedQuestionSuggestions: NonNullable<ChatPresentedAnswer["suggestions"]> = [];
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
      session = await this.chatSessionPreparer.prepare({
        ...input,
        pageReadCapability: pageReadCapabilityFromRequest(
          input.clientContextCapabilities,
          input.pageContext,
        ),
      }, { skipRetrieval: true });
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
      const routineResult: { value: Awaited<ReturnType<ChatTurnAssembly["attemptRoutineTurn"]>> } = { value: null };
      if (!suspendedRoutine) {
        // A routine attempt is speculative: it may yield back to interpretation and
        // retrieval. Keep its composing phase private until it claims the turn so the
        // public sequence never backtracks from composing to interpreting/searching.
        routineResult.value = await this.chatTurnAssembly.attemptRoutineTurn(session, {
          accountId: input.accountId,
          responseLanguage: responseLanguagePromise,
          activeRoutine,
          clarification,
          coordination: this.turnAssemblyCoordination(coordination),
        });
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
        const interpreted = await this.chatTurnAssembly.interpretChatTurnForPreparation({
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
        const preparedRetrievalInput = this.chatTurnAssembly.retrievalInputWithRewriteProposal(
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
          ? await this.chatTurnAssembly.maybeClarifyRetrievalSense({
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
        ? this.chatTurnAssembly.streamTurn(session, {
            ...retrievalInput,
            coordination: this.turnAssemblyCoordination(coordination),
          })
        : this.chatTurnAssembly.streamPreparedByEngine(session, {
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
            coordination: this.turnAssemblyCoordination(coordination),
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
        engineTrace = this.chatTurnAssembly.conversationTraceWithStage(engineTrace, clarificationTurn.stage);
      }
      if (!finalPresentation || !suggestions) {
        throw new Error("chat_stream_missing_final_presentation");
      }
      if (!session) {
        throw new Error("chat_stream_missing_prepared_session");
      }
      const preparedSession = session;
      persistedQuestionSuggestions = this.composeQuestionSuggestions({
        session: preparedSession,
        presentation: finalPresentation,
        suggestions,
      });
      // The lazy promise can call chatActionSuggestionService.evaluate (which may
      // hit an LLM). If completeAssistantTurn below throws, we rethrow but the
      // promise stays in flight — swallow its rejection so it can't surface as an
      // unhandled rejection. The post-`done` await still observes the failure and
      // skips emitting suggestions, which is the desired behavior.
      lazySuggestionsPromise = this.composeLazySuggestions({
        session: preparedSession,
        presentation: finalPresentation,
        questionSuggestions: persistedQuestionSuggestions,
        userExpectedLocale: input.userExpectedLocale,
      });
      lazySuggestionsPromise.catch(() => undefined);
      const presentation: ChatPresentedAnswer = {
        ...finalPresentation,
        // Finalized question suggestions are already available synchronously. Persist
        // them with the answer so the directive firing committed below always refers
        // to durable visitor-facing output. Action chips remain lazy enrichment.
        suggestions: persistedQuestionSuggestions.length > 0
          ? persistedQuestionSuggestions
          : undefined,
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
        // Preserve the streaming protocol: suggestions arrive in their own event
        // after `done`, even though the question subset is already durable.
        suggestions: undefined,
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
        await this.chatTurnLifecycle.recordSupersession(input, session, assistantMessageId, preferredError, workflowPolicy);
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

    let suggestionsToEmit = persistedQuestionSuggestions;
    try {
      const lazySuggestions = await lazySuggestionsPromise;
      const enrichedSuggestions = lazySuggestions.suggestions ?? [];
      if (enrichedSuggestions.length > 0) {
        if (assistantMessageId) {
          await this.chatTurnLifecycle.updateSuggestions({
            workspaceId: input.workspaceId,
            conversationId,
            assistantMessageId,
            suggestions: enrichedSuggestions,
          });
        }
        suggestionsToEmit = enrichedSuggestions;
      }
    } catch {
      // Lazy action enrichment is best effort. The question suggestions were
      // persisted with the answer, so keep serving that durable subset when the
      // enrichment call or its audit update fails.
    }
    if (suggestionsToEmit.length > 0) {
      yield {
        type: "suggestions",
        conversationId,
        suggestions: suggestionsToEmit,
      };
    }
  }

  private composeQuestionSuggestions(input: {
    session: PreparedSession;
    presentation: ChatPresentedAnswer;
    suggestions: TurnStreamSuggestions;
  }): NonNullable<ChatPresentedAnswer["suggestions"]> {
    const { session, presentation, suggestions } = input;
    // The skill decides where question suggestions come from: assistant-voice
    // replies settle their own onto the presentation; retrieval defers to the
    // host's expansion of the model's planned envelope suggestions. This is
    // synchronous so the host can record visible generator output before the
    // turn's one directive-state commit.
    return suggestions.mode === "presentation"
      ? (presentation.suggestions ?? [])
      : (this.chatAnswerPresenter
          .applyAssistantSuggestions(session, presentation, suggestions.planned)
          .suggestions ?? []);
  }

  private async composeLazySuggestions(input: {
    session: PreparedSession;
    presentation: ChatPresentedAnswer;
    questionSuggestions: NonNullable<ChatPresentedAnswer["suggestions"]>;
    userExpectedLocale?: string | null;
  }): Promise<Pick<ChatPresentedAnswer, "suggestions">> {
    const { session, presentation, questionSuggestions, userExpectedLocale } = input;
    let actionSuggestionsResult: Pick<ChatPresentedAnswer, "suggestions">;
    try {
      actionSuggestionsResult = await this.chatAnswerPresenter.applyActionSuggestions(
        session,
        presentation,
        userExpectedLocale,
      );
    } catch {
      // Action chips are best-effort enrichment. Question suggestions have already
      // survived their own final filtering and remain useful when that enrichment
      // fails independently.
      return { suggestions: questionSuggestions };
    }
    const actionMergedSuggestions = actionSuggestionsResult.suggestions ?? [];
    return { suggestions: [...actionMergedSuggestions, ...questionSuggestions] };
  }

}
