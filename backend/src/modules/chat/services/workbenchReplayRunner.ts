import type { ChatSuggestion } from "../types/chatResponses.js";
import type {
  ClarificationPolicy,
  ConversationClarifier,
  ConversationEngine,
  RoutineActionRequest,
  RoutineState,
} from "@radioso/conversation-contract";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { AgentRevision } from "../../agents/public.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ModelCallUsageAttribution } from "../../../shared/domain/modelCallUsageContext.js";
import type { ResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";
import {
  applyAgentConfigOverride,
  steeringDirectivesFromAuthored,
  materializeAgentFromConfig,
  type InternalAgentConfig,
} from "../../agents/public.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import { visitorMatchContext } from "./visitorMatchContext.js";
import {
  contextualDirectiveCandidates,
  lazyPromise,
  planAwareResponseLanguage,
  startTurnPlan,
  type TurnPlanCoordinator,
} from "./turnPlanCoordinator.js";
import { detectTurnResponseLanguage } from "./turnResponseLanguage.js";
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
  historicalWorkbenchReplayBaseline,
  type PrepareChatSessionInput,
  type PreparedSession,
} from "./chatSessionPreparer.js";
import type { SkillEffectPolicy, TurnExecutionMode } from "../../../shared/domain/turnExecutionMode.js";
import type { ChatRoutineProvider } from "../contracts/routineProvider.js";
import type { RoutineInvocation } from "../contracts/routineInvocation.js";
import {
  ChatTurnAssembly,
  type ChatTurnAssemblyFactory,
  type ChatTurnAssemblyClarification,
  type ChatTurnAssemblyOptions,
  type ChatTurnAssemblyRoutineResult,
} from "./chatTurnAssembly.js";
import {
  createEphemeralChatTurnEffectProfile,
  type EphemeralChatTurnEffectProfile,
} from "./chatTurnEffectProfile.js";
import {
  exportTestExecutionReplayContinuation,
  type TestExecutionReplayContinuationV1,
} from "./testExecutionContinuation.js";
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
import type { ChatRoutineTurnReporter } from "../contracts/routineTurnState.js";
import { buildHandoffNotifyAction } from "./handoffOwnership.js";
import {
  formatHandoffNotification,
  handoffNotificationFromAction,
  type FormattedHandoffNotification,
} from "../../operatorNotifications/public.js";
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
import { buildAgentChatWorkspaceContext } from "./agentChatWorkspaceContext.js";

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
  /** Ephemeral turn identity; never a production conversation-message row. */
  messageId?: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  /** Follow-up questions the replayed turn would offer, for previewing a directive
   * addressed to that generator rather than to the answer. */
  suggestions?: ChatSuggestion[];
  groundingSummary?: GroundingSummary;
  turnTrace?: TurnTraceEnvelope;
  actions?: RoutineActionRequest[];
  pendingDecisionTransition?: ChatTurnAssemblyRoutineResult["pendingDecisionTransition"];
  handoff?: ChatTurnAssemblyRoutineResult["handoff"];
  /** Present only for the trusted multi-turn test-execution adapter. */
  continuation?: TestExecutionReplayContinuationV1;
  resolvedConfig: WorkbenchReplayResolvedConfig;
}

interface WorkbenchReplayRunnerOptions {
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
  /**
   * Post-evidence answer coverage for a replayed turn. Composition supplies the
   * repository-less variant, so the assessment runs (and coverage-gated directives and
   * routines can fire, exactly as in a live turn) without any durable write.
   */
  coverageHeadRecorder?: ChatTurnAssemblyOptions["coverageHeadRecorder"];
  logger?: Pick<AppLogger, "warn">;
}

/**
 * A starting routine position for a replayed turn. It is the full {@link RoutineState}
 * minus `sessionId` (the runner injects the ephemeral conversation id).
 */
export type WorkbenchReplayRoutineStartState = Omit<RoutineState, "sessionId">;

export interface WorkbenchReplayInput {
  workspaceId: string;
  /**
   * What the replayed turn is allowed to do to the outside world. Required, because the durable
   * effects a replay avoids and the external effects a turn's skills perform are different things:
   * the ephemeral profile stops every write, and only this decides whether a notify, a webhook, a
   * contact send, or an external MCP tool actually fires. A replay that leaves it unstated fires
   * them, so no caller gets to omit it.
   */
  executionMode: TurnExecutionMode;
  /** Caller-requested skill-effect override; only meaningful in `safe_test` (see {@link resolveSkillEffectPolicy}). */
  skillEffects?: SkillEffectPolicy;
  accountId?: string | null;
  sourceAgentId: string;
  /** Stable private identity supplied by a trusted execution aggregate. */
  conversationId?: string;
  /** Trusted runner-only immutable candidate. Public chat never accepts this input. */
  candidateRevision?: AgentRevision;
  baselineAgentConfig: InternalAgentConfig;
  agentConfigOverride?: Partial<InternalAgentConfig>;
  /** The turn's text; for a `routineInvocation` this is its rendered form (`renderRoutineInvocation`). */
  query: string;
  /** Drive the turn as a calling agent's tool call: the named routine is admitted directly with this input. */
  routineInvocation?: RoutineInvocation | null;
  history: MessageRecord[];
  pageContext?: AssistantPageContext | null;
  clientContextCapabilities?: AssistantClientContextCapabilities;
  userExpectedLocale?: string | null;
  routineStartState?: WorkbenchReplayRoutineStartState | null;
  pendingClarificationStartState?: Omit<import("@radioso/conversation-contract").PendingClarification, "sessionId"> | null;
  directiveStateStartState?: import("../../directives/public.js").DirectiveFiringState | null;
  /** Already validated safe-test samples. They bypass every live resolver. */
  preResolvedHostVariables?: readonly import("../../context-variables/public.js").ResolvedVariableInput[];
  retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  usageAttribution?: ModelCallUsageAttribution;
  /**
   * Rolling conversation summary frozen in the snapshot at capture time. Replay uses
   * it verbatim and never regenerates or persists the summary.
   */
  conversationSummary?: string | null;
  /**
   * Includes each filled routine slot's value on this replayed turn's trace. Absent/false
   * (the default) is what every caller of this runner gets except one: only the Test Chat
   * entry point (`TrustedTestExecutionRunnerAdapter`) sets it, because Test Chat's trace is
   * stored in `agent_test_execution_attempts` under Test Chat's own retention. Eval replay
   * (`evalRunService.ts`, `evalMessageCaseRepository.ts`) must never set it: an eval case can
   * be captured from a customer conversation, and eval persists its trace into append-only
   * `eval_runs`/revision-eval evidence with a 90-day retention and no per-conversation erasure
   * path — a captured slot value there would outlive the conversation it came from.
   */
  includeSlotValues?: boolean;
}

export class WorkbenchReplayRunner {
  constructor(private readonly options: WorkbenchReplayRunnerOptions) {}

  async run(input: WorkbenchReplayInput): Promise<WorkbenchReplayResult> {
    if (input.candidateRevision && input.executionMode !== "safe_test") {
      throw new Error("workbench_candidate_revision_requires_safe_test");
    }
    const mergedConfig = applyAgentConfigOverride(
      input.baselineAgentConfig,
      input.agentConfigOverride ?? {},
    );
    const agent = materializeAgentFromConfig(mergedConfig, {
      agentId: input.sourceAgentId,
      workspaceId: input.workspaceId,
    });
    const effects = createEphemeralChatTurnEffectProfile(input.history, {
      conversationId: input.conversationId,
      directiveState: input.directiveStateStartState,
    });
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
      executionMode: input.executionMode,
      skillEffects: input.skillEffects,
      // This runner builds the ephemeral in-memory effect profile (createEphemeralChatTurnEffectProfile)
      // below; it is the one place that knows no conversation row is ever persisted for this turn.
      conversationDurability: "ephemeral",
      retrievalSettingsOverride: input.retrievalSettingsOverride,
      usageAttribution: input.usageAttribution,
      ...(input.routineInvocation ? { routineInvocation: input.routineInvocation } : {}),
    };
    const session = await preparer.prepare(prepareInput, {
      skipRetrieval: true,
      preResolvedAgent: agent,
      preResolvedRevision: input.candidateRevision,
      trustedTestRunner: input.executionMode === "safe_test" ? true : undefined,
      // A full-execution replay reuses an immutable baseline captured with the
      // workbench/eval case. It is not current authoring state and it is never
      // available on a public chat path.
      historicalWorkbenchReplayBaseline,
      preResolvedHostVariables: input.executionMode === "safe_test" ? input.preResolvedHostVariables : undefined,
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
      effects.clarificationStore(
        input.pendingClarificationStartState
          ? { ...input.pendingClarificationStartState, sessionId: session.conversation.id }
          : null,
      ),
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
    // Only the caller sets `includeSlotValues` — Test Chat does (its trace lives in
    // agent_test_execution_attempts under Test Chat's own retention); eval replay never
    // does, since eval persists into append-only eval_runs/revision-eval evidence that
    // outlives a source conversation with no per-conversation erasure path.
    const assembly = this.options.turnAssemblyFactory?.create({
      chatSessionPreparer: preparer,
      directiveStateStore: effects.directiveStateStore,
      routineStore,
      coverageHeadRecorder: this.options.coverageHeadRecorder,
      includeSlotValues: input.includeSlotValues === true,
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
      includeSlotValues: input.includeSlotValues === true,
      clarifier,
      recordClarificationDecision: this.options.recordClarificationDecision,
      retrievalSenseDetector: this.options.retrievalSenseDetector,
      retrievalSenseClarificationPolicy:
        this.options.retrievalSenseClarificationPolicy
        ?? DEFAULT_RETRIEVAL_SENSE_CLARIFICATION_POLICY,
      agentSkillTurnSkillProvider: this.options.agentSkillTurnSkillProvider,
      coverageHeadRecorder: this.options.coverageHeadRecorder,
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
      await routineResult.commitRoutineState();
      await routineResult.commitClarificationState?.();
      await session.directiveStateStore?.commit();
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
        routineReporter: routineResult.routineReporter,
        continuation: this.continuation(effects, session.conversation.id, routineStore),
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
    await clarificationStore.commit();
    await rendered.session.directiveStateStore?.commit();
    return this.presentResult({
      input,
      agent,
      session: rendered.session,
      presentation: rendered.presentation,
      engineTrace: rendered.engineTrace,
      answerStartedAt,
      actions: rendered.actions,
      continuation: this.continuation(effects, session.conversation.id, routineStore),
    });
  }

  private startReplayTurnPlan(session: PreparedSession, input: WorkbenchReplayInput): void {
    const additionalDirectives = steeringDirectivesFromAuthored(session.agent.authoredDirectives);
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
        visitorContext: visitorMatchContext(session).context,
        workspaceContext: buildAgentChatWorkspaceContext(session.agent),
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

  private detectResponseLanguage(
    input: WorkbenchReplayInput,
    session: PreparedSession,
  ): Promise<string | undefined> {
    return detectTurnResponseLanguage({
      detector: this.options.responseLanguageDetector,
      request: {
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
      },
      logContext: { workspaceId: input.workspaceId, conversationId: session.conversation.id },
      logger: this.options.logger,
    });
  }

  /**
   * The hand-off message content the suppressed `handoff.notify` action carries — the
   * subject and body fields/values a real dispatch renders — built through the same
   * payload builder and text formatter the real dispatch handler uses
   * (`buildHandoffNotifyAction`, `handoffNotificationFromAction`, `formatHandoffNotification`)
   * so this content cannot drift from what a live handoff sends. It is not the full
   * delivered payload: live delivery additionally appends an `Open: <conversation URL>`
   * line and, for a webhook, its own structured fields (see `emailWebhookSink.ts`) — a
   * replayed turn has no durable conversation to link to, so this preview omits both.
   * `routineReporter` resolves the routine's display name from the routines this turn ran
   * against — the same authored name a live handoff's database-backed subject resolver
   * would find — without a further lookup.
   */
  private handoffPreviewFor(input: {
    input: WorkbenchReplayInput;
    agent: ReturnType<typeof materializeAgentFromConfig>;
    session: PreparedSession;
    handoff?: ChatTurnAssemblyRoutineResult["handoff"];
    routineReporter?: ChatRoutineTurnReporter;
  }): FormattedHandoffNotification | undefined {
    if (!input.handoff) {
      return undefined;
    }
    const action = buildHandoffNotifyAction({
      conversationId: input.session.conversation.id,
      workspaceId: input.input.workspaceId,
      agentId: input.agent.id,
      userMessageId: input.session.userMessage.id,
      reason: "routine_handoff",
      routineId: input.handoff.routineId,
      stepId: input.handoff.stepId,
      collected: input.handoff.collected,
    });
    const notification = handoffNotificationFromAction({
      payload: action.payload,
      fallback: { conversationId: input.session.conversation.id, workspaceId: input.input.workspaceId },
      subject: {
        agentName: input.agent.name,
        routineName: input.routineReporter?.describeRoutineName(input.handoff.routineId) ?? null,
      },
    });
    return formatHandoffNotification(notification);
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
    routineReporter?: ChatRoutineTurnReporter;
    continuation?: TestExecutionReplayContinuationV1;
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
    // A Test Chat/eval replay never dispatches this turn's actions (the caller drops them,
    // see TrustedTestExecutionRunnerAdapter.run), so a hand-off notify never actually sends.
    // Carry its message content on the trace instead.
    const handoffPreview = this.handoffPreviewFor(input);
    return {
      answer: input.presentation.answer,
      messageId: input.session.userMessage.id,
      citations: input.presentation.citations,
      answerSegments: input.presentation.answerSegments,
      // Carried so a coach preview can show the effect of a directive addressed to
      // the follow-up question generator, which leaves the answer untouched.
      suggestions: input.presentation.suggestions,
      groundingSummary: input.presentation.groundingSummary,
      turnTrace: handoffPreview && tracePresentation.turnTrace
        ? { ...tracePresentation.turnTrace, handoffPreview }
        : tracePresentation.turnTrace,
      actions: input.actions,
      pendingDecisionTransition: input.pendingDecisionTransition,
      handoff: input.handoff,
      ...(input.continuation ? { continuation: input.continuation } : {}),
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

  private continuation(
    effects: ReturnType<typeof createEphemeralChatTurnEffectProfile>,
    sessionId: string,
    routineStore: ReturnType<EphemeralChatTurnEffectProfile["routineStore"]>,
  ): TestExecutionReplayContinuationV1 {
    return exportTestExecutionReplayContinuation(effects.snapshot({ sessionId, routineStore }));
  }
}
