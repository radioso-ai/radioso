import { normalizeProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import { setTraceAttributes, traceAsyncIterable, traceOperation } from "../../../shared/observability/tracing/operations.js";
import type {
  ConversationEngine,
  ConversationClarificationStore,
  ConversationClarifier,
  ConversationModelGateway,
  ConversationRoutineActivator,
  ConversationRoutineRunner,
  ConversationRoutineStore,
  ConversationTrace,
  ClarificationPolicy,
  RecentClarificationReader,
  RenderableTurn,
  RoutineActionRequest,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../../shared/domain/actionCapabilities.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { BootstrapGreetingCacheRepositoryPort } from "../../../db/repositories/bootstrapGreetingCacheRepository.js";
import type { AgentService } from "../../agents/public.js";
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
import {
  evaluateRetrievalSenseClarification,
  type RetrievalSenseDetectorPort,
} from "../../retrieval/public.js";
import type { ClarificationMetricDecision } from "./clarification/clarificationMetrics.js";
import {
  toConversationAgentConfig,
  toConversationInputEvent,
  toConversationMessages,
} from "./conversationContractMappers.js";
import type { TurnRouter, TurnRouting } from "./turnRouter.js";
import type { ResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";

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

export class ModelChatGateway implements ChatGateway {
  constructor(private readonly inference: ModelInferencePipeline) {}

  async answer(input: ChatGatewayInput): Promise<string> {
    const result = await this.inference.complete({
      operation: input.usageContext,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      maxOutputTokens: CHAT_BEHAVIOR.answer.maxOutputTokens,
      reasoningEffort: CHAT_BEHAVIOR.answer.reasoningEffort,
      validateResult(result) {
        if (!result.text?.trim()) {
          throw new BlankChatAnswerError();
        }
      },
    });
    return result.text;
  }

  async *streamAnswer(input: ChatGatewayInput): AsyncIterable<string> {
    const { textStream } = this.inference.stream({
      operation: input.usageContext,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      maxOutputTokens: CHAT_BEHAVIOR.answer.maxOutputTokens,
      reasoningEffort: CHAT_BEHAVIOR.answer.reasoningEffort,
    });
    for await (const chunk of textStream) {
      if (chunk.length > 0) {
        yield chunk;
      }
    }
  }
}

export class OpenAIChatGateway extends ModelChatGateway {}

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
    pinnedRoutineIds?: string[];
    responseLanguage?: string | Promise<string | undefined>;
  }): Promise<{
    activator: ConversationRoutineActivator;
    runner: ConversationRoutineRunner;
  } | null>;
}

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
  directiveSteering?: RouteScopedDirectiveRuntime;
  selectionStrategy?: TurnSelectionStrategy;
  turnRouter: TurnRouter;
  /** The reusable conversation engine drives every chat turn; composition always wires it. */
  conversationEngine: ConversationEngine;
  /** Optional: when wired, routine-emitted fire-and-forget actions are enqueued to the outbox. */
  actionOutbox?: ChatActionOutboxPort;
  assistantTurnPersistence?: AssistantTurnPersistencePort;
  actionCapabilities?: ActionCapabilityMap;
  capabilityPolicy?: CapabilityPolicy;
  logger?: Pick<AppLogger, "warn">;
  /** Optional: durable per-session routine state store (with {@link routineProvider}). */
  routineStore?: ConversationRoutineStore;
  /** Optional: registered routines + activation. Empty/absent leaves turns unchanged. */
  routineProvider?: ChatRoutineProvider;
  /** Optional shared per-turn language detector for routine, direct, and retrieval replies. */
  responseLanguageDetector?: ResponseLanguageDetector;
  clarifier?: ConversationClarifier;
  clarifierFactory?: (input: { session: PreparedSession; accountId?: string }) => ConversationClarifier;
  clarificationStore?: ConversationClarificationStore & Partial<RecentClarificationReader>;
  recordClarificationDecision?: (input: { surface: string; decision: ClarificationMetricDecision }) => void;
  retrievalSenseDetector?: RetrievalSenseDetectorPort;
  retrievalSenseClarificationPolicy?: ClarificationPolicy;
}

export class ChatService {
  private readonly chatGateway: ChatGateway;
  private readonly auditService: AuditService;
  private readonly usageLimitPolicy: UsageLimitPolicy;
  private readonly selectionStrategy: TurnSelectionStrategy;
  private readonly conversationEngine: ConversationEngine;
  private readonly chatAnswerPresenter: ChatAnswerPresenter;
  private readonly chatSessionPreparer: ChatSessionPreparer;
  private readonly chatTurnLifecycle: ChatTurnLifecycle;
  private readonly turnSkills: TurnSkill[];
  private readonly turnSkillSelector: ChatTurnSkillSelector;
  private readonly directiveRuntime: RouteScopedDirectiveRuntime;
  private readonly answerSupport = new ChatAnswerSupport();
  private readonly routineStore?: ConversationRoutineStore;
  private readonly routineProvider?: ChatRoutineProvider;
  private readonly clarifier?: ConversationClarifier;
  private readonly clarifierFactory?: (input: { session: PreparedSession; accountId?: string }) => ConversationClarifier;
  private readonly clarificationStore?: ConversationClarificationStore & Partial<RecentClarificationReader>;
  private readonly recordClarificationDecision?: (input: { surface: string; decision: ClarificationMetricDecision }) => void;
  private readonly retrievalSenseDetector?: RetrievalSenseDetectorPort;
  private readonly retrievalSenseClarificationPolicy: ClarificationPolicy;
  private readonly turnRouter: TurnRouter;
  private readonly responseLanguageDetector?: ResponseLanguageDetector;

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
      directiveSteering = noopRouteScopedDirectiveRuntime,
      selectionStrategy = new DefaultTurnSelectionStrategy(),
      turnRouter,
      conversationEngine,
      actionOutbox,
      assistantTurnPersistence,
      actionCapabilities,
      capabilityPolicy,
      logger,
      routineStore,
      routineProvider,
      responseLanguageDetector,
      clarifier,
      clarifierFactory,
      clarificationStore,
      recordClarificationDecision,
      retrievalSenseDetector,
      retrievalSenseClarificationPolicy,
    } = options;
    this.routineStore = routineStore;
    this.routineProvider = routineProvider;
    this.responseLanguageDetector = responseLanguageDetector;
    this.clarifier = clarifier;
    this.clarifierFactory = clarifierFactory;
    this.clarificationStore = clarificationStore;
    this.recordClarificationDecision = recordClarificationDecision;
    this.retrievalSenseDetector = retrievalSenseDetector;
    this.retrievalSenseClarificationPolicy = retrievalSenseClarificationPolicy ?? {
      floor: 0,
      margin: 0.15,
      maxOptions: 4,
    };
    this.chatGateway = chatGateway;
    this.auditService = auditService;
    this.usageLimitPolicy = usageLimitPolicy;
    this.selectionStrategy = selectionStrategy;
    this.turnRouter = turnRouter;
    this.conversationEngine = conversationEngine;
    this.directiveRuntime = directiveSteering;
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
    );
    this.chatSessionPreparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      auditService,
      workspaceRepository,
      agentService,
      bootstrapGreetingCacheRepository,
    );
    // One selection seam shared by the engine turn and the host streaming path, so
    // streamed and non-streamed turns resolve the terminal skill identically.
    this.turnSkillSelector = new ChatTurnSkillSelector(this.turnSkills, this.selectionStrategy);
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
    routineStateTransition?: CapturedRoutineTransition | null;
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
      pinnedRoutineIds: activeRoutine?.status === "active" ? [activeRoutine.routineId] : [],
      responseLanguage,
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
      clarifier: clarification?.clarifier ?? this.clarifier,
      clarificationStore: deferredClarificationStore,
      loopGuardCandidateIds: clarification?.resolution?.kind === "normal"
        ? clarification.resolution.loopGuardCandidateIds
        : undefined,
      suppressNewClarification: clarification?.resolution?.suppressNewClarification,
      presentRoutineReply: (response) => this.chatAnswerPresenter.presentNonRetrievalAnswer(response.answer),
    });
    if (!outcome) {
      return null;
    }
    this.recordTraceClarificationDecisions(outcome.result.trace);
    return {
      presentation: outcome.presentation,
      engineTrace: outcome.result.trace,
      actions: outcome.result.actions,
      routineStateTransition: deferredStore.getTransition(),
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
      if (decision === "asked" || decision === "auto_picked" || decision === "suppressed") {
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
      const decision = resolution.kind === "routine_activation" || resolution.kind === "retrieval_sense"
        ? "mapped"
        : (resolution.outcome ?? "declined");
      const surface = resolution.kind === "retrieval_sense" ? "retrieval_sense" : "routine_activation";
      this.recordClarificationDecision?.({ surface, decision });
    }
    return { store, resolution, clarifier };
  }

  private async loadActiveRoutine(session: PreparedSession): Promise<RoutineState | null> {
    if (!this.routineStore) {
      return null;
    }
    return this.routineStore.loadActive({ sessionId: session.conversation.id });
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
      return {
        kind: "continue",
        ...(effect.stage ? { stage: effect.stage } : {}),
        ...(effect.documentScope ? { documentScope: effect.documentScope } : {}),
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
  private async renderTurn(
    session: PreparedSession,
    input: { query: string; userExpectedLocale?: string | null; accountId?: string },
  ): Promise<{ presentation: ChatPresentedAnswer; engineTrace?: ConversationTrace; actions?: RoutineActionRequest[] }> {
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: this.conversationEngine,
      session,
      turnSkillSelector: this.turnSkillSelector,
      turnSkills: this.turnSkills,
      directiveRuntime: this.directiveRuntime,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId,
    });
    return { presentation, engineTrace: result.trace, actions: result.actions };
  }

  private async *streamTurn(
    session: PreparedSession,
    input: { query: string; userExpectedLocale?: string | null; accountId?: string },
  ): AsyncIterable<PreparedChatStreamTurnEvent> {
    for await (const event of runPreparedChatTurnStreamWithConversationEngine({
      engine: this.conversationEngine,
      session,
      turnSkillSelector: this.turnSkillSelector,
      turnSkills: this.turnSkills,
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
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
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
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
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
      const responseLanguagePromise = this.detectResponseLanguage(input, session);
      const clarification = await this.resolvePendingForTurn(session, input.accountId);
      const activeRoutine = await this.loadActiveRoutine(session);
      const activeRoutineAtTurnStart = activeRoutine?.status === "active";
      // A routine is a multi-turn skill: attempt it before grounding. If it claims the
      // turn, there is no retrieval — the routine renders its own reply.
      const routineStartedAt = Date.now();
      const routineTurn = await this.attemptRoutineTurn(
        session,
        input.accountId,
        responseLanguagePromise,
        activeRoutine,
        clarification,
      );
      if (routineTurn) {
        session = this.withResponseLanguage(session, await responseLanguagePromise);
        const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          session,
          presentation: routineTurn.presentation,
          answerStartedAt: routineStartedAt,
          stream: input.stream,
          engineTrace: routineTurn.engineTrace,
          actions: routineTurn.actions,
          routineStateTransition: routineTurn.routineStateTransition,
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
      const routing = await this.routeTurn(input, session);
      const resolvedRetrievalSense = clarification.resolution?.kind === "retrieval_sense";
      const groundTurn = resolvedRetrievalSense || routing.route === CHAT_TURN_ROUTE.RETRIEVAL;
      const retrievalInput = clarification.resolution?.kind === "retrieval_sense"
        ? { ...input, documentScope: clarification.resolution.documentScope }
        : input;
      session = this.withResponseLanguage(session, await responseLanguagePromise);
      session = groundTurn
        ? await this.chatSessionPreparer.prepareRetrieval(retrievalInput, session, routing.framing)
        : await this.chatSessionPreparer.prepareDirect(input, session, routing.framing);
      const answerStartedAt = Date.now();
      const clarificationTurn = groundTurn
        ? await this.maybeClarifyRetrievalSense({
            session,
            accountId: input.accountId,
            clarification,
            activeRoutineAtTurnStart,
          })
        : null;
      if (clarificationTurn?.kind === "continue" && clarificationTurn.documentScope) {
        session = await this.chatSessionPreparer.prepareRetrieval({
          ...input,
          documentScope: clarificationTurn.documentScope,
        }, session, routing.framing);
      }
      const renderedTurn = clarificationTurn?.kind === "ask"
        ? { presentation: clarificationTurn.presentation, engineTrace: clarificationTurn.engineTrace, actions: undefined }
        : await this.renderTurn(session, input);
      const { presentation, actions } = renderedTurn;
      const engineTrace = clarificationTurn?.kind === "continue" && clarificationTurn.stage && renderedTurn.engineTrace
        ? this.conversationTraceWithStage(renderedTurn.engineTrace, clarificationTurn.stage)
        : renderedTurn.engineTrace;
      const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        session,
        presentation,
        answerStartedAt,
        stream: input.stream,
        engineTrace,
        actions,
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
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
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
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
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
      const responseLanguagePromise = this.detectResponseLanguage(input, session);
      const clarification = await this.resolvePendingForTurn(session, input.accountId);
      const activeRoutine = await this.loadActiveRoutine(session);
      const activeRoutineAtTurnStart = activeRoutine?.status === "active";

      yield {
        type: "conversation",
        conversationId: session.conversation.id,
      };

      // A routine is a multi-turn skill: attempt it before grounding. If it claims the
      // turn, stream its rendered reply and finish — no retrieval.
      const routineStartedAt = Date.now();
      const routineTurn = await this.attemptRoutineTurn(
        session,
        input.accountId,
        responseLanguagePromise,
        activeRoutine,
        clarification,
      );
      if (routineTurn) {
        session = this.withResponseLanguage(session, await responseLanguagePromise);
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
          actions: routineTurn.actions,
          routineStateTransition: routineTurn.routineStateTransition,
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
      const routing = await this.routeTurn(input, session);
      const resolvedRetrievalSense = clarification.resolution?.kind === "retrieval_sense";
      const groundTurn = resolvedRetrievalSense || routing.route === CHAT_TURN_ROUTE.RETRIEVAL;
      const retrievalInput = clarification.resolution?.kind === "retrieval_sense"
        ? { ...input, documentScope: clarification.resolution.documentScope }
        : input;
      session = this.withResponseLanguage(session, await responseLanguagePromise);
      session = groundTurn
        ? await this.chatSessionPreparer.prepareRetrieval(retrievalInput, session, routing.framing)
        : await this.chatSessionPreparer.prepareDirect(input, session, routing.framing);
      const answerStartedAt = Date.now();
      const clarificationTurn = groundTurn
        ? await this.maybeClarifyRetrievalSense({
            session,
            accountId: input.accountId,
            clarification,
            activeRoutineAtTurnStart,
          })
        : null;
      if (clarificationTurn?.kind === "continue" && clarificationTurn.documentScope) {
        session = await this.chatSessionPreparer.prepareRetrieval({
          ...input,
          documentScope: clarificationTurn.documentScope,
        }, session, routing.framing);
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

      // Route to the capability that claims this turn and stream its answer. When
      // the reusable engine is wired, it drives the terminal selection/dispatch
      // stages; otherwise the host uses the same selection seam directly.
      let finalPresentation: ChatPresentedAnswer | null = null;
      let suggestions: TurnStreamSuggestions | null = null;
      let engineTrace: ConversationTrace | undefined;
      let actions: RoutineActionRequest[] | undefined;
      for await (const event of this.streamTurn(session, input)) {
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
      }
      if (clarificationTurn?.kind === "continue" && clarificationTurn.stage && engineTrace) {
        engineTrace = this.conversationTraceWithStage(engineTrace, clarificationTurn.stage);
      }
      if (!finalPresentation || !suggestions) {
        throw new Error("chat_stream_missing_final_presentation");
      }
      // The lazy promise can call chatActionSuggestionService.evaluate (which may
      // hit an LLM). If completeAssistantTurn below throws, we rethrow but the
      // promise stays in flight — swallow its rejection so it can't surface as an
      // unhandled rejection. The post-`done` await still observes the failure and
      // skips emitting suggestions, which is the desired behavior.
      lazySuggestionsPromise = this.composeLazySuggestions({
        session,
        presentation: finalPresentation,
        suggestions,
        userExpectedLocale: input.userExpectedLocale,
      });
      lazySuggestionsPromise.catch(() => undefined);
      const presentation: ChatPresentedAnswer = {
        ...finalPresentation,
        suggestions: undefined,
      };

      const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        session,
        presentation,
        answerStartedAt,
        stream: input.stream,
        engineTrace,
        actions,
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
