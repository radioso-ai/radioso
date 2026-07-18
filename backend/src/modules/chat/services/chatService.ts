import { normalizeProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import { setTraceAttributes, traceAsyncIterable, traceOperation } from "../../../shared/observability/tracing/operations.js";
import type {
  ConversationEngine,
  ConversationClarificationStore,
  ConversationClarifier,
  ConversationModelGateway,
  ConversationRetrievalWorkPort,
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineRunner,
  ConversationRoutineSlotCorrection,
  ConversationRoutineStore,
  ConversationTrace,
  ConversationTurnInterpreter,
  ClarificationCandidate,
  ConversationChannelContext,
  ClarificationPolicy,
  RecentClarificationReader,
  RenderableTurn,
  RoutineActionRequest,
  RoutineAwaitingDecision,
  RoutineState,
  TurnContext,
  TurnOutcome,
} from "@radioso/conversation-contract";
import type { RoutineGroundedAnswerRenderer } from "@radioso/conversation-defaults";
import { CHAT_BEHAVIOR, RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../../shared/domain/actionCapabilities.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { ContextVariableRepositoryPort } from "../../../db/repositories/contextVariableRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { BootstrapGreetingCacheRepositoryPort } from "../../../db/repositories/bootstrapGreetingCacheRepository.js";
import type { PendingDecisionCreateInput, PendingDecisionRecord } from "../../../db/repositories/pendingDecisionRepository.js";
import type { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AgentService } from "../../agents/public.js";
import { buildPendingDecisionTransition, type ResumeRunner } from "../../approvals/public.js";
import type { ChatGateway, ChatGatewayInput } from "../contracts/chatGateway.js";
import type { ChatStreamEvent } from "../contracts/streamEvents.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import type { ChatResponse } from "../types/chatResponses.js";
import type { AssistantPageContext } from "../types/assistantApi.js";
import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";
import { NoopUsageLimitPolicy, type UsageLimitPolicy } from "../../../shared/domain/usageLimitPolicy.js";
import { ChatSessionPreparer, type PreparedSession } from "./chatSessionPreparer.js";
import {
  attemptRoutineTurnWithConversationEngine,
  runPreparedChatTurnStreamWithConversationEngine,
  runPreparedChatTurnWithConversationEngine,
} from "./conversationEngineChatTurn.js";
import type { RetrievalTurnPort } from "./retrievalTurnDispatch.js";
import {
  noopRouteScopedDirectiveRuntime,
  type RouteScopedDirectiveRuntime,
} from "./routeScopedDirectiveSteering.js";
import {
  type TurnSkill,
  type TurnStreamSuggestions,
} from "./turnOutcome.js";
import type { ChatTurnRuntime } from "./chatTurnRuntime.js";
import {
  DefaultTurnSelectionStrategy,
  type TurnSelectionStrategy,
} from "./turnSelectionStrategy.js";
import { ChatTurnSkillSelector } from "./turnSkillSelector.js";
import type { AgentSkillTurnSkillProvider } from "./agentSkillTurnSkillProvider.js";
import type {
  ChatConversationTurnInterpreter,
  ConversationTurnInterpretationResult,
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
import {
  DeferredRoutineStore,
  type CapturedRoutineTransition,
} from "./routines/deferredRoutineStore.js";
import {
  DeferredClarificationStore,
  type CapturedClarificationTransition,
} from "./clarification/deferredClarificationStore.js";
import {
  resolvePendingClarification,
  type PendingClarificationResolution,
} from "./clarification/pendingClarificationResolver.js";
import { retrievalInputForResolvedSense } from "./clarification/retrievalSenseResolutionInput.js";
import {
  evaluateRetrievalSenseClarification,
  type RetrievalExecutionDiagnostics,
  type RetrievalSenseDetectorPort,
  type StructuredRewriteResult,
} from "../../retrieval/public.js";
import type { ClarificationMetricDecision } from "./clarification/clarificationMetrics.js";
import {
  toConversationAgentConfig,
  toConversationInputEvent,
  toConversationMessages,
  toPreparedStagedContext,
} from "./conversationContractMappers.js";
import { resolveContextForTurn } from "../../context-variables/public.js";
import type { TurnRouter, TurnRouting } from "./turnRouter.js";
import type { ResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";
import type { HandoffWaitingMessageGenerator } from "../../../shared/services/handoffWaitingMessageGenerator.js";
import {
  isHumanOwned,
  type ConversationOwnershipReader,
} from "../../handoff/public.js";
import { HANDOFF_NOTIFY_ACTION_TYPE } from "./routines/contactRoutine.js";
import { APPROVAL_REQUEST_ACTION_TYPE } from "./actions/approvalRequestActionHandler.js";
import { SKILL_TURN_OUTCOME } from "./assistantTurnOutcomeTypes.js";

export type { ChatGateway } from "../contracts/chatGateway.js";
export type { ChatStreamEvent } from "../contracts/streamEvents.js";
export { BlankChatAnswerError } from "./chatAnswerErrors.js";

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

const retrievalDiagnosticsMetadata = (
  session: PreparedSession,
): {
  route: PreparedSession["turnRoute"];
  contextCount: number;
  rewriteStatus?: RetrievalExecutionDiagnostics["rewriteStatus"];
  triggerStatus?: NonNullable<RetrievalExecutionDiagnostics["triggerAnalysis"]>["status"];
} => ({
  route: session.turnRoute,
  contextCount: session.retrieval.contexts.length,
  rewriteStatus: session.retrieval.diagnostics.rewriteStatus,
  triggerStatus: session.retrieval.diagnostics.triggerAnalysis?.status,
});

type RetrievalSenseClarificationTurn =
  | {
      kind: "ask";
      presentation: ChatPresentedAnswer;
      engineTrace: ConversationTrace;
    }
  | {
      kind: "continue";
      documentScope?: string[];
      offerAlternatives?: ClarificationCandidate[];
      stage?: ConversationTrace["stages"][number];
    };

const CLARIFICATION_TURN_SKILL = "clarification.answer";

const clarificationTraceStage = (
  turn: RetrievalSenseClarificationTurn | null,
): ConversationTrace["stages"][number] | undefined =>
  turn?.kind === "continue"
    ? turn.stage
    : turn?.engineTrace.stages.find((stage) => stage.kind === "clarification");

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
    });
    for await (const chunk of textStream) {
      if (chunk.length > 0) {
        yield chunk;
      }
    }
  }
}

export class OpenAIChatGateway extends ModelChatGateway {}

export const buildRoutinePendingDecisionTransition = (input: {
  session: PreparedSession;
  awaitingDecision?: RoutineAwaitingDecision;
  routineStateTransition?: CapturedRoutineTransition | null;
}): PendingDecisionCreateInput | null => {
  if (!input.awaitingDecision) {
    return null;
  }
  if (
    input.routineStateTransition?.kind !== "save" ||
    input.routineStateTransition.state.status !== "suspended"
  ) {
    throw new Error("routine_awaiting_decision_without_suspended_state");
  }
  return buildPendingDecisionTransition({
    conversationId: input.session.conversation.id,
    sessionId: input.routineStateTransition.state.sessionId,
    workspaceId: input.session.conversation.workspaceId,
    agentId: input.session.agent.id,
    routineId: input.routineStateTransition.state.routineId,
    awaitingDecision: input.awaitingDecision,
  });
};

type PreparedChatStreamTurnEvent =
  | { type: "chunk"; text: string }
  | {
      type: "final";
      finalPresentation: ChatPresentedAnswer;
      suggestions: TurnStreamSuggestions;
      engineTrace?: ConversationTrace;
      actions?: RoutineActionRequest[];
    };

/**
 * The routines this turn may resume or activate. Composition loads/compiles the
 * agent-scoped registrations, assembles the concrete `RoutineRegistry`, and returns
 * the engine ports for this turn. Null means no applicable routines, so ChatService
 * skips the routine state store and falls through to normal chat.
 */
export interface ChatRoutineProvider {
  forTurn(input: {
    modelGateway: ConversationModelGateway;
    agentId: string;
    workspaceId?: string;
    accountId?: string;
    pinnedRoutineIds?: string[];
    responseLanguage?: string | Promise<string | undefined>;
    groundedAnswerRenderer?: RoutineGroundedAnswerRenderer;
  }): Promise<{
    activator: ConversationRoutineActivator;
    runner: ConversationRoutineRunner;
    slotCorrection?: ConversationRoutineSlotCorrection;
    reentryGate?: ConversationRoutineReentryGate;
  } | null>;
}

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

const buildApprovalRequestAction = (input: {
  handle: string;
  conversationId: string;
  workspaceId: string;
  agentId: string;
  routineId?: string;
  stepId?: string;
}): RoutineActionRequest => ({
  type: APPROVAL_REQUEST_ACTION_TYPE,
  payload: {
    handle: input.handle,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
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
  selectionStrategy?: TurnSelectionStrategy;
  turnRouter: TurnRouter;
  turnInterpreter?: ChatConversationTurnInterpreter;
  /** The reusable conversation engine drives every chat turn; composition always wires it. */
  conversationEngine: ConversationEngine;
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
  recordClarificationDecision?: (input: { surface: string; decision: ClarificationMetricDecision }) => void;
  retrievalSenseDetector?: RetrievalSenseDetectorPort;
  retrievalSenseClarificationPolicy?: ClarificationPolicy;
  agentSkillTurnSkillProvider?: AgentSkillTurnSkillProvider;
}

export class ChatService {
  private readonly conversationRepository: ConversationRepositoryPort;
  private readonly messageRepository: MessageRepositoryPort;
  private readonly agentService?: Pick<AgentService, "resolve">;
  private readonly chatGateway: ChatGateway;
  private readonly auditService: AuditService;
  private readonly usageLimitPolicy: UsageLimitPolicy;
  private readonly selectionStrategy: TurnSelectionStrategy;
  private readonly conversationEngine: ConversationEngine;
  private readonly chatAnswerPresenter: ChatAnswerPresenter;
  private readonly chatSessionPreparer: ChatSessionPreparer;
  private readonly chatTurnLifecycle: ChatTurnLifecycle;
  private readonly turnSkills: TurnSkill[];
  private readonly agentSkillTurnSkillProvider?: AgentSkillTurnSkillProvider;
  private readonly directiveRuntime: RouteScopedDirectiveRuntime;
  private readonly logger?: Pick<AppLogger, "warn">;
  private readonly answerSupport = new ChatAnswerSupport();
  private readonly routineStore?: ConversationRoutineStore;
  private readonly suspendedRoutineReader?: SuspendedRoutineReader;
  private readonly conversationOwnershipReader?: ConversationOwnershipReader;
  private readonly routineProvider?: ChatRoutineProvider;
  private readonly clarifier?: ConversationClarifier;
  private readonly clarifierFactory?: (input: { session: PreparedSession; accountId?: string }) => ConversationClarifier;
  private readonly clarificationStore?: ConversationClarificationStore & Partial<RecentClarificationReader>;
  private readonly recordClarificationDecision?: (input: { surface: string; decision: ClarificationMetricDecision }) => void;
  private readonly retrievalSenseDetector?: RetrievalSenseDetectorPort;
  private readonly retrievalSenseClarificationPolicy: ClarificationPolicy;
  private readonly turnRouter: TurnRouter;
  private readonly turnInterpreter?: ChatConversationTurnInterpreter;
  private readonly responseLanguageDetector?: ResponseLanguageDetector;
  private readonly handoffWaitingMessageGenerator?: HandoffWaitingMessageGenerator;

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
      selectionStrategy = new DefaultTurnSelectionStrategy(),
      turnRouter,
      turnInterpreter,
      conversationEngine,
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
    this.retrievalSenseClarificationPolicy = retrievalSenseClarificationPolicy ?? {
      floor: 0,
      margin: 0.15,
      askMargin: 0,
      maxOptions: 4,
    };
    this.chatGateway = chatGateway;
    this.auditService = auditService;
    this.usageLimitPolicy = usageLimitPolicy;
    this.selectionStrategy = selectionStrategy;
    this.turnRouter = turnRouter;
    this.turnInterpreter = turnInterpreter;
    this.conversationEngine = conversationEngine;
    this.directiveRuntime = directiveSteering;
    this.agentSkillTurnSkillProvider = agentSkillTurnSkillProvider;
    this.logger = logger;
    this.chatAnswerPresenter = turnRuntime.chatAnswerPresenter;
    this.turnSkills = turnRuntime.turnSkills;
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
    );
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
  private async attemptRoutineTurn(
    session: PreparedSession,
    accountId: string | undefined,
    responseLanguage: Promise<string | undefined>,
    activeRoutine: RoutineState | null,
    clarification?: {
      store?: DeferredClarificationStore;
      resolution?: PendingClarificationResolution;
      clarifier?: ConversationClarifier;
    },
  ): Promise<{
    presentation: ChatPresentedAnswer;
    engineTrace?: ConversationTrace;
    actions?: RoutineActionRequest[];
    handoff?: { routineId: string; stepId: string };
    routineStateTransition?: CapturedRoutineTransition | null;
    pendingDecisionTransition?: PendingDecisionCreateInput | null;
    suspended?: boolean;
    clarificationTransition?: CapturedClarificationTransition | null;
    // Flushes the routine-state transition the engine made this turn. Called by the
    // lifecycle only after the turn's actions are durably enqueued, so a crash before
    // enqueue leaves the routine recoverable rather than advanced past a lost action.
    commitRoutineState: () => Promise<void>;
    commitClarificationState?: () => Promise<void>;
  } | null> {
    if (!this.routineStore || !this.routineProvider) {
      return null;
    }
    const modelGateway = new RoutineChatModelGateway(this.chatGateway, {
      workspaceContext: this.answerSupport.buildChatWorkspaceContext(session),
      usageContext: this.answerSupport.buildChatUsageContext(session, accountId, "routine_turn"),
    });
    const routineTurnPorts = await this.routineProvider.forTurn({
      modelGateway,
      agentId: session.agent.id,
      workspaceId: session.conversation.workspaceId,
      accountId,
      pinnedRoutineIds: await this.routineCatalogPinIds(session, activeRoutine),
      responseLanguage,
      groundedAnswerRenderer: createRoutineGroundedAnswerRenderer({
        session,
        accountId,
        responseLanguage,
        turnSkills: this.turnSkills,
      }),
    });
    if (!routineTurnPorts) {
      return null;
    }
    const activator = clarification?.resolution?.kind === "routine_activation"
      ? clarification.resolution.activator
      : routineTurnPorts.activator;
    const deferredStore = new DeferredRoutineStore(this.routineStore);
    const deferredClarificationStore = clarification?.store;
    const outcome = await attemptRoutineTurnWithConversationEngine({
      engine: this.conversationEngine,
      session,
      accountId,
      directiveRuntime: this.directiveRuntime,
      routineStore: deferredStore,
      routineRunner: routineTurnPorts.runner,
      routineActivator: activator,
      routineSlotCorrection: routineTurnPorts.slotCorrection,
      routineReentryGate: routineTurnPorts.reentryGate,
      clarifier: clarification?.clarifier ?? this.clarifier,
      clarificationStore: deferredClarificationStore,
      loopGuardCandidateIds: clarification?.resolution?.kind === "normal"
        ? clarification.resolution.loopGuardCandidateIds
        : undefined,
      suppressNewClarification: clarification?.resolution?.suppressNewClarification,
      presentRoutineReply: (response) => presentRoutineRenderableAnswer(this.chatAnswerPresenter, response),
    });
    if (!outcome) {
      return null;
    }
    this.recordTraceClarificationDecisions(outcome.result.trace);
    const routineStateTransition = deferredStore.getTransition();
    const pendingDecisionTransition = buildRoutinePendingDecisionTransition({
      session,
      awaitingDecision: outcome.result.awaitingDecision,
      routineStateTransition,
    });
    // Suspending at an approval gate notifies an operator out-of-band; the action is
    // enqueued in the same turn transaction as the pending_decisions row, so the
    // notification can never outrun (or be lost relative to) the durable decision.
    const actions = pendingDecisionTransition
      ? [
          ...(outcome.result.actions ?? []),
          buildApprovalRequestAction({
            handle: pendingDecisionTransition.handle,
            conversationId: pendingDecisionTransition.conversationId,
            workspaceId: pendingDecisionTransition.workspaceId,
            agentId: pendingDecisionTransition.agentId,
            routineId: pendingDecisionTransition.routineId,
            stepId: pendingDecisionTransition.stepId,
          }),
        ]
      : outcome.result.actions;
    return {
      presentation: outcome.presentation,
      engineTrace: outcome.result.trace,
      actions,
      handoff: outcome.result.handoff,
      routineStateTransition,
      pendingDecisionTransition,
      suspended: Boolean(outcome.result.awaitingDecision),
      clarificationTransition: deferredClarificationStore?.getTransition(),
      commitRoutineState: () => deferredStore.commit(),
      commitClarificationState: deferredClarificationStore ? () => deferredClarificationStore.commit() : undefined,
    };
  }

  private buildClarificationTurn(session: PreparedSession): TurnContext {
    return {
      agent: toConversationAgentConfig(session.agent),
      sessionId: session.conversation.id,
      inputEvent: toConversationInputEvent(session.userMessage),
      history: toConversationMessages(session.history),
      stagedContext: [],
      steering: [],
    };
  }

  private recordTraceClarificationDecisions(trace?: ConversationTrace): void {
    if (!trace || !this.recordClarificationDecision) {
      return;
    }
    for (const stage of trace.stages) {
      if (stage.kind !== "clarification") {
        continue;
      }
      const outputs = stage.outputs ?? {};
      const surface = typeof outputs.surface === "string" ? outputs.surface : "unknown";
      const decision = typeof outputs.decision === "string" ? outputs.decision : "";
      if (decision === "asked" || decision === "offered" || decision === "auto_picked" || decision === "suppressed") {
        this.recordClarificationDecision({ surface, decision });
      }
    }
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

  async resumeAwaitingDecisionTurn(input: {
    record: PendingDecisionRecord;
    optionId: string;
    payload?: unknown;
    decidedBy: string;
    transaction: Db;
  }): Promise<{ conversationId: string; resumed: boolean; assistantMessageId?: string }> {
    if (!this.routineProvider || !this.suspendedRoutineReader) {
      throw new Error("approval_resume_routine_provider_missing");
    }
    if (!this.agentService) {
      throw new Error("approval_resume_agent_service_missing");
    }

    let session = await this.prepareDecisionResumeSession(input.record);
    // A resumed routine renders its own reply, so it needs the same response-language guard
    // as every other turn — otherwise the renderer falls back to a weak hint and a routine
    // step authored in another language leaks through (issue #755).
    session = this.withResponseLanguage(session, await this.detectResponseLanguage({
      workspaceId: input.record.workspaceId,
      accountId: input.decidedBy,
      query: session.userMessage.content,
    }, session));
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
    });
    if (!routineTurnPorts) {
      throw new Error("approval_resume_routine_ports_missing");
    }

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

    if (!result.resumed) {
      throw new Error("approval_resume_suspended_state_missing");
    }

    const routineStateTransition: CapturedRoutineTransition = result.nextState
      ? { kind: "save", state: result.nextState }
      : { kind: "clear", sessionId: input.record.sessionId };
    const presentation = presentRoutineRenderableAnswer(this.chatAnswerPresenter, result.response);

    const completed = await this.chatTurnLifecycle.completeAssistantTurn({
      workspaceId: input.record.workspaceId,
      accountId: input.decidedBy,
      session,
      presentation,
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: result.trace ? this.conversationTraceWithRoutineTrace(session.turnTrace, result.trace) : session.turnTrace,
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

  private async routineCatalogPinIds(session: PreparedSession, activeRoutine: RoutineState | null): Promise<string[]> {
    const pinned = new Set<string>();
    if (activeRoutine?.status === "active") {
      pinned.add(activeRoutine.routineId);
    }
    if (!activeRoutine && this.routineStore?.loadCompleted) {
      const completed = await this.routineStore.loadCompleted({ sessionId: session.conversation.id });
      for (const state of completed) {
        pinned.add(state.routineId);
      }
    }
    return [...pinned];
  }

  private async loadSuspendedRoutine(session: PreparedSession): Promise<RoutineState | null> {
    return this.suspendedRoutineReader?.loadSuspended({ sessionId: session.conversation.id }) ?? null;
  }

  private conversationTraceWithStage(
    trace: ConversationTrace,
    stage: ConversationTrace["stages"][number],
  ): ConversationTrace {
    const previous = trace.stages.at(-1);
    return {
      ...trace,
      stages: [...trace.stages, stage],
      links: previous
        ? [...(trace.links ?? []), { from: previous.id, to: stage.id, kind: "sequence" }]
        : trace.links,
    };
  }

  private async maybeClarifyRetrievalSense(input: {
    session: PreparedSession;
    accountId?: string;
    clarification: {
      store?: DeferredClarificationStore;
      resolution?: PendingClarificationResolution;
      clarifier?: ConversationClarifier;
    };
    activeRoutineAtTurnStart: boolean;
  }): Promise<{
    kind: "ask";
    presentation: ChatPresentedAnswer;
    engineTrace: ConversationTrace;
  } | {
    kind: "continue";
    stage?: ConversationTrace["stages"][number];
    documentScope?: string[];
    offerAlternatives?: ClarificationCandidate[];
  } | null> {
    if (
      !input.clarification.store ||
      !input.clarification.clarifier ||
      input.clarification.resolution?.suppressNewClarification
    ) {
      return null;
    }
    const effect = await evaluateRetrievalSenseClarification({
      detector: this.retrievalSenseDetector,
      workspaceId: input.session.conversation.workspaceId,
      rankedCandidates: input.session.retrieval.contexts,
      conversationId: input.session.conversation.id,
      messageId: input.session.userMessage.id,
      originalQuery: input.session.userMessage.content,
      conversationLanguage: input.session.agent.assistantDefaultLocale ?? undefined,
      usageContext: {
        workspaceId: input.session.conversation.workspaceId,
        conversationId: input.session.conversation.id,
        messageId: input.session.userMessage.id,
        surface: "assistant",
        operation: "clarification",
        attemptKey: input.session.userMessage.id,
      },
      policy: this.retrievalSenseClarificationPolicy,
      suppressAsk: input.activeRoutineAtTurnStart,
      suppressNewClarification: input.clarification.resolution?.suppressNewClarification,
      loopGuardCandidateIds: input.clarification.resolution?.kind === "normal"
        ? input.clarification.resolution.loopGuardCandidateIds
        : undefined,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    if (!effect) {
      return null;
    }
    const engineTrace = effect.stage
      ? this.conversationTraceWithStage(input.session.turnTrace, effect.stage)
      : input.session.turnTrace;
    if (effect.stage) {
      this.recordTraceClarificationDecisions(engineTrace);
    }
    if (effect.kind !== "ask") {
      if (effect.kind === "offer") {
        await input.clarification.store.save(effect.pending);
      }
      return {
        kind: "continue",
        ...(effect.stage ? { stage: effect.stage } : {}),
        ...(effect.documentScope ? { documentScope: effect.documentScope } : {}),
        ...(effect.kind === "offer" ? { offerAlternatives: effect.alternatives } : {}),
      };
    }
    const answer = await input.clarification.clarifier.phraseQuestion({
      candidates: effect.candidates,
      turn: this.buildClarificationTurn(input.session),
    });
    await input.clarification.store.save(effect.pending);
    return {
      kind: "ask",
      presentation: this.chatAnswerPresenter.presentNonRetrievalAnswer(answer),
      engineTrace,
    };
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

  private async turnSelectionRuntime(
    session: PreparedSession,
    input: {
      prependTurnSkills?: TurnSkill[];
      forceSkillName?: () => string | null | undefined;
    } = {},
  ): Promise<{
    turnSkills: TurnSkill[];
    turnSkillSelector: ChatTurnSkillSelector;
  }> {
    const agentSkillRuntime = await this.agentSkillTurnSkillProvider?.forSession(session);
    const turnSkills = [
      ...(input.prependTurnSkills ?? []),
      ...this.turnSkills,
      ...(agentSkillRuntime?.turnSkills ?? []),
    ];
    return {
      turnSkills,
      turnSkillSelector: new ChatTurnSkillSelector(turnSkills, this.selectionStrategy, {
        agentSkillStates: agentSkillRuntime?.skillStates,
        logger: this.logger,
        forceSkillName: input.forceSkillName,
      }),
    };
  }

  /**
   * Produces the answer for a prepared turn. The conversation engine drives
   * selection + dispatch and renders the outcome through the shared registry,
   * returning its turn trace for audit (`engineTrace`).
   */
  private async renderTurn(
    session: PreparedSession,
    input: { query: string; userExpectedLocale?: string | null; accountId?: string },
  ): Promise<{ presentation: ChatPresentedAnswer; engineTrace?: ConversationTrace; actions?: RoutineActionRequest[] }> {
    const { turnSkills, turnSkillSelector } = await this.turnSelectionRuntime(session);
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: this.conversationEngine,
      session,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.directiveRuntime,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId,
    });
    return { presentation, engineTrace: result.trace, actions: result.actions };
  }

  private async interpretChatTurnForPreparation(input: {
    request: {
      workspaceId: string;
      accountId?: string;
      query: string;
    };
    session: PreparedSession;
    resolvedRetrievalSense: boolean;
  }): Promise<ConversationTurnInterpretationResult> {
    const interpreted = this.turnInterpreter
      ? await this.turnInterpreter.interpretChatTurn({
        query: input.request.query,
        history: input.session.history,
        responseIdentity: input.session.retrieval.responseIdentity,
        customInstruction: input.session.agent.customInstruction,
        workspaceId: input.request.workspaceId,
        accountId: input.request.accountId,
        conversationId: input.session.conversation.id,
        messageId: input.session.userMessage.id,
        agentSkillSettings: input.session.agent.skillSettings,
      })
      : await this.routeTurn(input.request, input.session);
    return input.resolvedRetrievalSense
      ? { ...interpreted, route: CHAT_TURN_ROUTE.RETRIEVAL }
      : interpreted;
  }

  private retrievalInputWithRewriteProposal(
    input: Parameters<ChatSessionPreparer["prepareRetrieval"]>[0],
    proposal?: StructuredRewriteResult,
  ): Parameters<ChatSessionPreparer["prepareRetrieval"]>[0] {
    return proposal
      ? { ...input, precomputedRewriteProposal: proposal }
      : input;
  }

  private clarificationTurnSkill(state: { current: RetrievalSenseClarificationTurn | null }): TurnSkill {
    return {
      definition: { name: CLARIFICATION_TURN_SKILL, outcomeKinds: ["clarification"] },
      selects: () => state.current?.kind === "ask",
      dispatch: () => {
        if (state.current?.kind !== "ask") {
          throw new Error("clarification_turn_skill_without_question");
        }
        return {
          kind: "clarification",
          skillName: CLARIFICATION_TURN_SKILL,
          outcome: {
            status: "completed",
            answer: state.current.presentation.answer,
          },
          stagedContext: [],
          steering: [],
          trace: state.current.engineTrace,
        } satisfies TurnOutcome;
      },
      renderer: {
        supports: (outcome) => outcome.skillName === CLARIFICATION_TURN_SKILL,
        render: async () => {
          if (state.current?.kind !== "ask") {
            throw new Error("clarification_turn_render_without_question");
          }
          return state.current.presentation;
        },
      },
    };
  }

  private buildEnginePreparationPorts(input: {
    request: {
      workspaceId: string;
      accountId?: string;
      query: string;
    };
    retrievalInput: Parameters<ChatSessionPreparer["prepareRetrieval"]>[0];
    responseLanguagePromise: Promise<string | undefined>;
    resolvedRetrievalSense: boolean;
    sessionRef: { current: PreparedSession };
    clarificationState?: { current: RetrievalSenseClarificationTurn | null };
    clarification?: {
      store?: DeferredClarificationStore;
      resolution?: PendingClarificationResolution;
      clarifier?: ConversationClarifier;
    };
    activeRoutineAtTurnStart?: boolean;
  }): {
    turnInterpreter: ConversationTurnInterpreter;
    retrievalWork: ConversationRetrievalWorkPort;
  } {
    const turnInterpreter: ConversationTurnInterpreter = {
      interpret: async () => {
        const interpreted = await this.interpretChatTurnForPreparation({
          request: input.request,
          session: input.sessionRef.current,
          resolvedRetrievalSense: input.resolvedRetrievalSense,
        });
        const routing = {
          route: interpreted.route,
          framing: interpreted.framing,
        };
        input.sessionRef.current = {
          ...input.sessionRef.current,
          turnRoute: routing.route,
          turnFraming: routing.framing,
        };
        if (routing.route === CHAT_TURN_ROUTE.DIRECT) {
          input.sessionRef.current = this.withResponseLanguage(
            input.sessionRef.current,
            await input.responseLanguagePromise,
          );
          input.sessionRef.current = await this.chatSessionPreparer.prepareDirect(
            input.retrievalInput,
            input.sessionRef.current,
            routing.framing,
          );
        }
        return {
          route: routing.route,
          framing: routing.framing,
          metadata: "rewriteProposal" in interpreted && interpreted.rewriteProposal
            ? { rewriteProposal: interpreted.rewriteProposal }
            : undefined,
        };
      },
    };
    const retrievalWork: ConversationRetrievalWorkPort = {
      run: async ({ interpretation }) => {
        const rewriteProposal =
          interpretation.metadata?.rewriteProposal && typeof interpretation.metadata.rewriteProposal === "object"
            ? interpretation.metadata.rewriteProposal as StructuredRewriteResult
            : undefined;
        const preparedRetrievalInput = this.retrievalInputWithRewriteProposal(input.retrievalInput, rewriteProposal);
        const directiveSteering = input.sessionRef.current.directiveSteering;
        input.sessionRef.current = await this.chatSessionPreparer.prepareRetrieval(
          preparedRetrievalInput,
          input.sessionRef.current,
          input.sessionRef.current.turnFraming,
        );
        if (directiveSteering) {
          input.sessionRef.current = {
            ...input.sessionRef.current,
            directiveSteering,
          };
        }
        if (input.clarificationState && input.clarification) {
          input.clarificationState.current = await this.maybeClarifyRetrievalSense({
            session: input.sessionRef.current,
            accountId: input.request.accountId,
            clarification: input.clarification,
            activeRoutineAtTurnStart: input.activeRoutineAtTurnStart ?? false,
          });
          if (input.clarificationState.current?.kind === "continue" && input.clarificationState.current.documentScope) {
            input.sessionRef.current = await this.chatSessionPreparer.prepareRetrieval(
              {
                ...preparedRetrievalInput,
                documentScope: input.clarificationState.current.documentScope,
              },
              input.sessionRef.current,
              input.sessionRef.current.turnFraming,
            );
          }
          if (input.clarificationState.current?.kind === "continue" && input.clarificationState.current.offerAlternatives) {
            input.sessionRef.current = {
              ...input.sessionRef.current,
              retrievalSenseOfferAlternatives: input.clarificationState.current.offerAlternatives,
            };
          }
        }
        return {
          stagedContext: input.sessionRef.current.stagedContext,
          trace: input.sessionRef.current.turnTrace,
          metadata: retrievalDiagnosticsMetadata(input.sessionRef.current),
        };
      },
    };
    return { turnInterpreter, retrievalWork };
  }

  private async renderPreparedByEngine(
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
    },
  ): Promise<{
    session: PreparedSession;
    presentation: ChatPresentedAnswer;
    engineTrace?: ConversationTrace;
    actions?: RoutineActionRequest[];
  }> {
    const sessionRef = { current: { ...session, effectiveQuery: input.retrievalInput.query } };
    const clarificationState: { current: RetrievalSenseClarificationTurn | null } = { current: null };
    const { turnInterpreter, retrievalWork } = this.buildEnginePreparationPorts({
      request: input.request,
      retrievalInput: input.retrievalInput,
      responseLanguagePromise: input.responseLanguagePromise,
      resolvedRetrievalSense: input.resolvedRetrievalSense,
      sessionRef,
      clarificationState,
      clarification: input.clarification,
      activeRoutineAtTurnStart: input.activeRoutineAtTurnStart,
    });
    const { turnSkills, turnSkillSelector } = await this.turnSelectionRuntime(
      sessionRef.current,
      {
        prependTurnSkills: [this.clarificationTurnSkill(clarificationState)],
        forceSkillName: () => clarificationState.current?.kind === "ask" ? CLARIFICATION_TURN_SKILL : null,
      },
    );
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: this.conversationEngine,
      session: sessionRef.current,
      getSession: () => sessionRef.current,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.directiveRuntime,
      turnInterpreter,
      retrievalWork,
      beforeRender: async () => {
        sessionRef.current = this.withResponseLanguage(sessionRef.current, await input.responseLanguagePromise);
      },
      query: input.request.query,
      userExpectedLocale: input.request.userExpectedLocale,
      accountId: input.request.accountId,
    });
    const stage = clarificationTraceStage(clarificationState.current);
    const engineTrace = stage
      ? this.conversationTraceWithStage(result.trace, stage)
      : result.trace;
    return { session: sessionRef.current, presentation, engineTrace, actions: result.actions };
  }

  private async *streamTurn(
    session: PreparedSession,
    input: { query: string; userExpectedLocale?: string | null; accountId?: string },
  ): AsyncIterable<PreparedChatStreamTurnEvent> {
    const { turnSkills, turnSkillSelector } = await this.turnSelectionRuntime(session);
    for await (const event of runPreparedChatTurnStreamWithConversationEngine({
      engine: this.conversationEngine,
      session,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.directiveRuntime,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId,
    })) {
      if (event.type === "chunk") {
        yield event;
        continue;
      }
      yield {
        type: "final",
        finalPresentation: event.presentation,
        suggestions: event.suggestions,
        engineTrace: event.engineTrace,
        actions: event.result.actions,
      };
    }
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
    },
  ): AsyncIterable<PreparedChatStreamTurnEvent & { session?: PreparedSession }> {
    const sessionRef = { current: { ...session, effectiveQuery: input.retrievalInput.query } };
    const clarificationState: { current: RetrievalSenseClarificationTurn | null } = { current: null };
    const { turnInterpreter, retrievalWork } = this.buildEnginePreparationPorts({
      request: input.request,
      retrievalInput: input.retrievalInput,
      responseLanguagePromise: input.responseLanguagePromise,
      resolvedRetrievalSense: input.resolvedRetrievalSense,
      sessionRef,
      clarificationState,
      clarification: input.clarification,
      activeRoutineAtTurnStart: input.activeRoutineAtTurnStart,
    });
    const { turnSkills, turnSkillSelector } = await this.turnSelectionRuntime(
      sessionRef.current,
      {
        prependTurnSkills: [this.clarificationTurnSkill(clarificationState)],
        forceSkillName: () => clarificationState.current?.kind === "ask" ? CLARIFICATION_TURN_SKILL : null,
      },
    );
    for await (const event of runPreparedChatTurnStreamWithConversationEngine({
      engine: this.conversationEngine,
      session: sessionRef.current,
      getSession: () => sessionRef.current,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.directiveRuntime,
      turnInterpreter,
      retrievalWork,
      beforeRender: async () => {
        sessionRef.current = this.withResponseLanguage(sessionRef.current, await input.responseLanguagePromise);
      },
      query: input.request.query,
      userExpectedLocale: input.request.userExpectedLocale,
      accountId: input.request.accountId,
    })) {
      if (event.type === "chunk") {
        yield event;
        continue;
      }
      const stage = clarificationTraceStage(clarificationState.current);
      yield {
        type: "final",
        finalPresentation: event.presentation,
        suggestions: event.suggestions,
        engineTrace: stage
          ? this.conversationTraceWithStage(event.engineTrace, stage)
          : event.engineTrace,
        actions: event.result.actions,
        session: sessionRef.current,
      };
    }
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
    return traceOperation({
      name: "chat.turn",
      attributes: chatTurnTraceAttributes(input),
      run: () => this.answerWithinTrace(input),
    });
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
  }): Promise<ChatResponse> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");
    const usageReservation = await this.usageLimitPolicy.reserveAnswer({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      surface: input.sourceChannel ?? "assistant",
    });

    try {
      session = await this.chatSessionPreparer.prepare(input, { skipRetrieval: true });
      const ownership = await this.conversationOwnershipReader?.load(session.conversation.id) ?? null;
      if (isHumanOwned(ownership)) {
        await usageReservation.release();
        const waitingMessage = await this.generateHandoffWaitingMessage(input, session);
        return suppressedHumanOwnedResponse(session, waitingMessage);
      }

      const responseLanguagePromise = this.detectResponseLanguage(input, session);
      const clarification = await this.resolvePendingForTurn(session, input.accountId);
      const activeRoutine = await this.loadActiveRoutine(session);
      const activeRoutineAtTurnStart = activeRoutine?.status === "active";
      const suspendedRoutine = await this.loadSuspendedRoutine(session);
      // A routine is a multi-turn skill: attempt it before grounding. If it claims the
      // turn, there is no retrieval — the routine renders its own reply.
      const routineStartedAt = Date.now();
      const routineTurn = suspendedRoutine
        ? null
        : await this.attemptRoutineTurn(
            session,
            input.accountId,
            responseLanguagePromise,
            activeRoutine,
            clarification,
          );
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
        const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          session,
          presentation: routineTurn.presentation,
          answerStartedAt: routineStartedAt,
          stream: input.stream,
          engineTrace: routineTurn.engineTrace,
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
        }
        if (clarificationTurn?.kind === "continue" && clarificationTurn.offerAlternatives) {
          session = {
            ...session,
            retrievalSenseOfferAlternatives: clarificationTurn.offerAlternatives,
          };
        }
        const renderedTurn = clarificationTurn?.kind === "ask"
          ? { presentation: clarificationTurn.presentation, engineTrace: clarificationTurn.engineTrace, actions: undefined }
          : await this.renderTurn(session, retrievalInput);
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
        const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          session,
          presentation,
          answerStartedAt,
          stream: input.stream,
          engineTrace,
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
      });
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
      const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        session,
        presentation,
        answerStartedAt,
        stream: input.stream,
        engineTrace,
        actions: retrievalMissHandoff.actions,
        ownershipHandoff: retrievalMissHandoff.ownershipHandoff,
        clarificationTransition: clarification.store?.getTransition(),
        commitClarificationState: clarification.store ? () => clarification.store!.commit() : undefined,
      });
      assistantMessageId = completedTurn.assistantMessageId;
      await usageReservation.commit();

      return completedTurn.response;
    } catch (error) {
      await usageReservation.release();
      const normalizedError = normalizeProviderCredentialError(error);
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
    yield* traceAsyncIterable({
      name: "chat.turn",
      attributes: chatTurnTraceAttributes(input),
      createIterable: () => this.streamAnswerWithinTrace(input),
    });
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
  }): AsyncIterable<ChatStreamEvent> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;
    let lazySuggestionsPromise:
      | Promise<Pick<ChatPresentedAnswer, "suggestions">>
      | undefined;
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");
    const usageReservation = await this.usageLimitPolicy.reserveAnswer({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      surface: input.sourceChannel ?? "assistant",
    });
    let usageReservationCommitted = false;
    let usageReservationReleased = false;
    const releaseUsageReservation = async () => {
      if (usageReservationCommitted || usageReservationReleased) {
        return;
      }
      usageReservationReleased = true;
      await usageReservation.release();
    };

    try {
      session = await this.chatSessionPreparer.prepare(input, { skipRetrieval: true });
      const ownership = await this.conversationOwnershipReader?.load(session.conversation.id) ?? null;
      if (isHumanOwned(ownership)) {
        await releaseUsageReservation();
        const waitingMessage = await this.generateHandoffWaitingMessage(input, session);
        yield { type: "done", ...suppressedHumanOwnedResponse(session, waitingMessage) };
        return;
      }

      const responseLanguagePromise = this.detectResponseLanguage(input, session);
      const clarification = await this.resolvePendingForTurn(session, input.accountId);
      const activeRoutine = await this.loadActiveRoutine(session);
      const activeRoutineAtTurnStart = activeRoutine?.status === "active";
      const suspendedRoutine = await this.loadSuspendedRoutine(session);

      yield {
        type: "conversation",
        conversationId: session.conversation.id,
      };

      // A routine is a multi-turn skill: attempt it before grounding. If it claims the
      // turn, stream its rendered reply and finish — no retrieval.
      const routineStartedAt = Date.now();
      const routineTurn = suspendedRoutine
        ? null
        : await this.attemptRoutineTurn(
            session,
            input.accountId,
            responseLanguagePromise,
            activeRoutine,
            clarification,
          );
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
        // Durably enqueue the action + advance routine state + persist the reply BEFORE
        // streaming the confirmation. The routine reply is rendered whole (not token-
        // streamed), so delaying the chunk costs nothing — but it means the visitor only
        // sees the "sent" confirmation once the request is actually in the outbox; if the
        // enqueue fails this throws before any chunk and the routine stays recoverable.
        const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          session,
          presentation: routineTurn.presentation,
          answerStartedAt: routineStartedAt,
          stream: input.stream,
          engineTrace: routineTurn.engineTrace,
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
        if (routineTurn.presentation.answer) {
          yield { type: "chunk", text: routineTurn.presentation.answer };
        }
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
        }
        if (clarificationTurn?.kind === "continue" && clarificationTurn.offerAlternatives) {
          session = {
            ...session,
            retrievalSenseOfferAlternatives: clarificationTurn.offerAlternatives,
          };
        }
        if (clarificationTurn?.kind === "ask") {
          const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            session,
            presentation: clarificationTurn.presentation,
            answerStartedAt,
            stream: input.stream,
            engineTrace: clarificationTurn.engineTrace,
            clarificationTransition: clarification.store?.getTransition(),
            commitClarificationState: clarification.store ? () => clarification.store!.commit() : undefined,
          });
          assistantMessageId = completedTurn.assistantMessageId;
          await usageReservation.commit();
          usageReservationCommitted = true;
          yield { type: "chunk", text: clarificationTurn.presentation.answer };
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
      const streamEvents = useSenseCompatiblePath
        ? this.streamTurn(session, retrievalInput)
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
          });
      for await (const event of streamEvents) {
        if (event.type === "chunk") {
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

	      const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
	        workspaceId: input.workspaceId,
	        accountId: input.accountId,
	        session: preparedSession,
        presentation,
        answerStartedAt,
        stream: input.stream,
        engineTrace,
        actions: retrievalMissHandoff.actions,
        ownershipHandoff: retrievalMissHandoff.ownershipHandoff,
        clarificationTransition: clarification.store?.getTransition(),
        commitClarificationState: clarification.store ? () => clarification.store!.commit() : undefined,
      });
      assistantMessageId = completedTurn.assistantMessageId;
      await usageReservation.commit();
      usageReservationCommitted = true;

      yield {
        type: "done",
        ...completedTurn.response,
      };

    } catch (error) {
      await releaseUsageReservation();
      const normalizedError = normalizeProviderCredentialError(error);
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

  private async routeTurn(
    input: {
      workspaceId: string;
      accountId?: string;
      query: string;
    },
    session: PreparedSession,
  ): Promise<TurnRouting> {
    const routing = await this.turnRouter.classify({
      query: input.query,
      history: session.history,
      responseIdentity: session.retrieval.responseIdentity,
      customInstruction: session.agent.customInstruction,
      workspaceContext: { workspaceId: input.workspaceId },
      usageContext: {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        conversationId: session.conversation.id,
        messageId: session.userMessage.id,
        surface: "assistant",
        attemptKey: session.userMessage.id,
      },
    });
    return {
      route: routing.route,
      framing: routing.framing,
    };
  }

}
