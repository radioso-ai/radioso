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
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
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
import { withRoutineReplyDelivery } from "./routines/routineReplyDelivery.js";
import { routineReplyFor } from "./routines/routineReplyFor.js";
import {
  createEphemeralChatTurnEffectProfile,
  type EphemeralChatTurnEffectProfile,
} from "./chatTurnEffectProfile.js";
import {
  exportTestExecutionReplayContinuation,
  type TestExecutionReplayContinuationV1,
} from "./testExecutionContinuation.js";
import { buildTurnTraceForPresentation } from "./chatTurnLifecycle.js";
import { observeReplayFirstAnswerChunkLatency } from "./streamPerformanceMetrics.js";
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
import type { OperatorNoticePreview, TurnTraceEnvelope } from "./turnTraceEnvelope.js";
import type { ChatRoutineTurnReporter } from "../contracts/routineTurnState.js";
import { routineEndingNoticeAction } from "./operatorNoticeAction.js";
import { buildRoutineEndingNotifyAction, operatorNoticeForTurn } from "./routineEndingEffects.js";
import {
  formatRoutineEndingNotification,
  routineEndingNotificationFromAction,
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
  /** Records a streamed replay's time to its first answer chunk; latency only, never content. */
  streamMetrics?: Pick<MetricsRegistry, "observeHistogram"> | null;
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
  /** Cancels a private replay when its owning HTTP stream exceeds the disconnect ceiling. */
  signal?: AbortSignal;
}

interface ReplayCoordination {
  signal: AbortSignal;
  checkpoint: () => void;
}

/** A replayed turn prepared up to the point it answers; `run` and `stream` share it. */
interface PreparedReplayTurn {
  input: WorkbenchReplayInput;
  agent: ReturnType<typeof materializeAgentFromConfig>;
  session: PreparedSession;
  assembly: ChatTurnAssembly;
  effects: EphemeralChatTurnEffectProfile;
  routineStore: ReturnType<EphemeralChatTurnEffectProfile["routineStore"]>;
  clarificationStore: DeferredClarificationStore;
  clarification: ChatTurnAssemblyClarification;
  coordination?: ReplayCoordination;
  responseLanguagePromise: Promise<string | undefined>;
  activeRoutine: RoutineState | null;
  /** What the engine's rendered and streamed answer paths both receive. */
  engineInput: Parameters<ChatTurnAssembly["renderPreparedByEngine"]>[1];
  requestReceivedAt: number;
  answerStartedAt: number;
}

/**
 * A non-routine turn's answer as either engine path settles it, with the effects of any coverage
 * routine that took the turn over after its evidence (#1260).
 */
type RenderedReplayAnswer = Awaited<ReturnType<ChatTurnAssembly["renderPreparedByEngine"]>>;

export class WorkbenchReplayRunner {
  constructor(private readonly options: WorkbenchReplayRunnerOptions) {}

  async run(input: WorkbenchReplayInput): Promise<WorkbenchReplayResult> {
    const turn = await this.prepareTurn(input);
    const routineResult = await this.routineTurn(turn);
    if (routineResult) {
      return routineResult;
    }
    const rendered = await turn.assembly.renderPreparedByEngine(turn.session, turn.engineInput);
    return this.settleRenderedTurn(turn, rendered, { stream: false });
  }

  /**
   * {@link run}, yielding the answer's text as the engine generates it. It settles to the result
   * `run` returns for the same turn, with its trace marked as streamed, except for question
   * suggestions: a streamed answer leaves their expansion to its host, and this runner does not
   * expand them.
   */
  async *stream(input: WorkbenchReplayInput): AsyncGenerator<string, WorkbenchReplayResult> {
    const turn = await this.prepareTurn(input);
    const observeFirstChunk = this.firstAnswerChunkObserver(turn.requestReceivedAt);
    const routineResult = yield* this.routineTurnStream(turn, observeFirstChunk);
    if (routineResult) {
      return routineResult;
    }
    let rendered: RenderedReplayAnswer | undefined;
    for await (const event of turn.assembly.streamPreparedByEngine(turn.session, turn.engineInput)) {
      if (event.type === "chunk" && event.text) {
        observeFirstChunk(event.route, event.deliveryMode);
        yield event.text;
      } else if (event.type === "final") {
        const { type: _final, suggestions: _suggestions, finalPresentation, session, ...effects } = event;
        rendered = { ...effects, session: session ?? turn.session, presentation: finalPresentation };
      }
    }
    if (!rendered) {
      throw new Error("workbench_replay_stream_missing_final_presentation");
    }
    return this.settleRenderedTurn(turn, rendered, { stream: true });
  }

  private firstAnswerChunkObserver(requestReceivedAt: number): (route: string, deliveryMode: string) => void {
    let observed = false;
    return (route, deliveryMode) => {
      if (observed) {
        return;
      }
      observed = true;
      observeReplayFirstAnswerChunkLatency(this.options.streamMetrics, Date.now() - requestReceivedAt, {
        route,
        delivery_mode: deliveryMode,
      });
    };
  }

  private async prepareTurn(input: WorkbenchReplayInput): Promise<PreparedReplayTurn> {
    input.signal?.throwIfAborted();
    const requestReceivedAt = Date.now();
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
    const coordination: ReplayCoordination | undefined = input.signal
      ? {
          signal: input.signal,
          checkpoint: () => input.signal?.throwIfAborted(),
        }
      : undefined;
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
    return {
      input,
      agent,
      session,
      assembly,
      effects,
      routineStore,
      clarificationStore,
      clarification,
      coordination,
      responseLanguagePromise,
      activeRoutine,
      engineInput: {
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
        coordination,
      },
      requestReceivedAt,
      answerStartedAt: Date.now(),
    };
  }

  /** The turn's result when a routine claims it, its routine, clarification, and directive state committed. */
  private async routineTurn(turn: PreparedReplayTurn): Promise<WorkbenchReplayResult | null> {
    const routineResult = await turn.assembly.attemptRoutineTurn(turn.session, {
      accountId: turn.input.accountId ?? undefined,
      responseLanguage: turn.responseLanguagePromise,
      activeRoutine: turn.activeRoutine,
      clarification: turn.clarification,
      coordination: turn.coordination,
    });
    return routineResult ? this.settleRoutineTurn(turn, routineResult, { stream: false }) : null;
  }

  /**
   * {@link routineTurn}, but claims the turn without generating its reply, then asks the same
   * delivery rule live chat applies ({@link routineReplyFor}) whether to stream it. A turn with
   * no durable effect (a slot ask, a re-ask, a step instruction, a grounded step answer) yields
   * its reply's text as the model writes it; a turn that does something durable — an action, a
   * decision gate, a hand-off, any routine ending, or a skill step that already acted outside
   * the conversation — is rendered and settled before any text reaches the caller, exactly as a
   * live visitor would see it. Yields nothing when no routine claims the turn, so the caller
   * falls through to grounded retrieval.
   */
  private async *routineTurnStream(
    turn: PreparedReplayTurn,
    observeFirstChunk: (route: string, deliveryMode: string) => void,
  ): AsyncGenerator<string, WorkbenchReplayResult | null> {
    const claim = await turn.assembly.claimRoutineTurn(turn.session, {
      accountId: turn.input.accountId ?? undefined,
      responseLanguage: turn.responseLanguagePromise,
      activeRoutine: turn.activeRoutine,
      clarification: turn.clarification,
      coordination: turn.coordination,
    });
    if (!claim) {
      return null;
    }
    const outcome = await routineReplyFor({
      session: turn.session,
      workspaceId: turn.input.workspaceId,
      claim,
    });
    let routineResult: ChatTurnAssemblyRoutineResult;
    if (outcome.delivery === "stream") {
      const reply = outcome.stream();
      let shown = false;
      let step = await reply.next();
      while (!step.done) {
        if (!shown) {
          observeFirstChunk("routine", "live");
          shown = true;
        }
        yield step.value;
        step = await reply.next();
      }
      // A provider that ignores the abort can finish its reply after the disconnect ceiling
      // cancelled the turn; a cancelled turn commits nothing.
      turn.coordination?.checkpoint();
      routineResult = step.value;
    } else {
      routineResult = outcome.turn;
    }
    const result = await this.settleRoutineTurn(turn, routineResult, {
      stream: true,
      reply: outcome.delivery,
    });
    if (outcome.delivery === "whole" && result.answer) {
      observeFirstChunk("routine", "committed");
      yield result.answer;
    }
    return result;
  }

  /**
   * Commits a claimed routine turn's routine, clarification, and directive state, then presents
   * its result. `run`'s whole claim and `stream`'s claim (rendered whole or streamed) both reach
   * this, so a Test Chat routine reply persists identically either way. `delivery.reply`, present
   * only from the streaming entry, marks the trace with how the reply reached the caller
   * ({@link withRoutineReplyDelivery}) — `run`'s non-stream turn never carries that mark, same as
   * a live non-SSE turn.
   */
  private async settleRoutineTurn(
    turn: PreparedReplayTurn,
    routineResult: ChatTurnAssemblyRoutineResult,
    delivery: { stream: boolean; reply?: "stream" | "whole" },
  ): Promise<WorkbenchReplayResult> {
    turn.coordination?.checkpoint();
    await routineResult.commitRoutineState();
    await routineResult.commitClarificationState?.();
    await turn.session.directiveStateStore?.commit();
    return this.presentResult({
      input: turn.input,
      agent: turn.agent,
      session: turn.session,
      presentation: routineResult.presentation,
      engineTrace: delivery.reply
        ? withRoutineReplyDelivery(routineResult.engineTrace, delivery.reply)
        : routineResult.engineTrace,
      requestReceivedAt: turn.requestReceivedAt,
      answerStartedAt: turn.answerStartedAt,
      stream: delivery.stream,
      actions: routineResult.actions,
      pendingDecisionTransition: routineResult.pendingDecisionTransition,
      handoff: routineResult.handoff,
      operatorNotice: routineResult.operatorNotice,
      routineReporter: routineResult.routineReporter,
      continuation: this.continuation(turn.effects, turn.session.conversation.id, turn.routineStore),
    });
  }

  /**
   * Commits a rendered answer's routine, clarification, and directive state, then presents its
   * result. A coverage routine that took the turn over saved its state through a deferred store;
   * committing it here, as live chat commits it with the turn, is what lets the exported
   * continuation carry that routine into the next turn. Coverage reactions are not committed:
   * replay's coverage recorder has no repository, so it records none.
   */
  private async settleRenderedTurn(
    turn: PreparedReplayTurn,
    rendered: RenderedReplayAnswer,
    delivery: { stream: boolean },
  ): Promise<WorkbenchReplayResult> {
    turn.coordination?.checkpoint();
    await rendered.commitRoutineState?.();
    await turn.clarificationStore.commit();
    await rendered.session.directiveStateStore?.commit();
    return this.presentResult({
      input: turn.input,
      agent: turn.agent,
      session: rendered.session,
      presentation: rendered.presentation,
      engineTrace: rendered.engineTrace,
      requestReceivedAt: turn.requestReceivedAt,
      answerStartedAt: turn.answerStartedAt,
      stream: delivery.stream,
      actions: rendered.actions,
      pendingDecisionTransition: rendered.pendingDecisionTransition,
      handoff: rendered.handoff,
      operatorNotice: rendered.operatorNotice,
      routineReporter: rendered.routineReporter,
      continuation: this.continuation(turn.effects, turn.session.conversation.id, turn.routineStore),
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
   * The message content the suppressed `handoff.notify` / `completion.notify` action carries —
   * the subject and body a real dispatch renders, authored notice text included — built through
   * the same action builder and text formatter the real dispatch handler uses
   * (`buildRoutineEndingNotifyAction`, `routineEndingNotificationFromAction`,
   * `formatRoutineEndingNotification`) so this content cannot drift from what a live notice
   * sends. It is not the full delivered payload: live delivery additionally appends an
   * `Open: <conversation URL>` line and, for a webhook, its own structured fields (see
   * `emailWebhookSink.ts`) — a replayed turn has no durable conversation to link to, so this
   * preview omits both. `routineReporter` resolves the routine's display name from the routines
   * this turn ran against — the same authored name a live notice's database-backed subject
   * resolver would find — without a further lookup; the conversation facts come from the
   * replayed session the same way.
   */
  private operatorNoticePreviewFor(input: {
    input: WorkbenchReplayInput;
    agent: ReturnType<typeof materializeAgentFromConfig>;
    session: PreparedSession;
    handoff?: ChatTurnAssemblyRoutineResult["handoff"];
    operatorNotice?: ChatTurnAssemblyRoutineResult["operatorNotice"];
    routineReporter?: ChatRoutineTurnReporter;
  }): OperatorNoticePreview | undefined {
    const notice = operatorNoticeForTurn(input);
    if (!notice) {
      return undefined;
    }
    const ending = routineEndingNoticeAction(notice.terminalKind);
    const action = buildRoutineEndingNotifyAction({
      conversationId: input.session.conversation.id,
      workspaceId: input.input.workspaceId,
      agentId: input.agent.id,
      userMessageId: input.session.userMessage.id,
      notice,
    });
    const notification = routineEndingNotificationFromAction({
      kind: ending.notificationKind,
      payload: action.payload,
      ids: { conversationId: input.session.conversation.id, workspaceId: input.input.workspaceId, agentId: input.agent.id },
      fallback: { reason: ending.reason },
      subject: {
        agentId: input.agent.id,
        agentName: input.agent.name,
        routineName: input.routineReporter?.describeRoutineName(notice.routineId) ?? null,
        conversation: {
          entryPageUrl: input.session.conversation.entryPageUrl ?? null,
        },
      },
    });
    const formatted = formatRoutineEndingNotification(notification);
    return { kind: ending.notificationKind, subject: formatted.subject, lines: formatted.lines };
  }

  private presentResult(input: {
    input: WorkbenchReplayInput;
    agent: ReturnType<typeof materializeAgentFromConfig>;
    session: PreparedSession;
    presentation: ChatPresentedAnswer;
    engineTrace?: Parameters<typeof buildTurnTraceForPresentation>[0]["engineTrace"];
    requestReceivedAt: number;
    answerStartedAt: number;
    /** Whether the turn's text was delivered as a stream, as a live chat SSE turn's is. */
    stream: boolean;
    actions?: RoutineActionRequest[];
    pendingDecisionTransition?: ChatTurnAssemblyRoutineResult["pendingDecisionTransition"];
    handoff?: ChatTurnAssemblyRoutineResult["handoff"];
    operatorNotice?: ChatTurnAssemblyRoutineResult["operatorNotice"];
    routineReporter?: ChatRoutineTurnReporter;
    continuation?: TestExecutionReplayContinuationV1;
  }): WorkbenchReplayResult {
    const tracePresentation = buildTurnTraceForPresentation({
      workspaceId: input.input.workspaceId,
      accountId: input.input.accountId ?? undefined,
      session: input.session,
      presentation: input.presentation,
      requestReceivedAt: input.requestReceivedAt,
      answerStartedAt: input.answerStartedAt,
      stream: input.stream,
      engineTrace: input.engineTrace,
    });
    // A replay never dispatches this turn's actions, so an operator notice never actually sends;
    // Test Chat carries its message content on the trace instead. That content lists the
    // routine's collected slot values and substitutes them into the authored subject and intro,
    // so it follows the same opt-in as slot values on the routine trace: only a caller that set
    // `includeSlotValues` (Test Chat) gets a preview. Eval replay persists its trace to
    // append-only evidence no conversation erasure reaches, so it gets none.
    const handoffPreview = input.input.includeSlotValues === true ? this.operatorNoticePreviewFor(input) : undefined;
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
