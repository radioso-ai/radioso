import type {
  ConversationClarifier,
  ConversationEngine,
  ConversationModelGateway,
  ConversationProgressPort,
  ConversationRetrievalWorkPort,
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineRunner,
  ConversationRoutineSlotCorrection,
  ConversationRoutineStore,
  ConversationTrace,
  ConversationTurnInterpreter,
  ClarificationCandidate,
  ClarificationPolicy,
  RoutineActionRequest,
  RoutineAwaitingDecision,
  RoutineState,
  TurnContext,
  TurnOutcome,
} from "@radioso/conversation-contract";
import type { RoutineGroundedAnswerRenderer } from "@radioso/conversation-defaults";

import type { AppLogger } from "../../../shared/observability/logger.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import { buildPendingDecisionTransition } from "../../approvals/public.js";
import type { ChatGateway } from "../contracts/chatGateway.js";
import type { ChatStatusStage } from "../contracts/streamEvents.js";
import type { ChatAnswerPresenter, ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import {
  ChatSessionPreparer,
  type PreparedSession,
} from "./chatSessionPreparer.js";
import {
  attemptRoutineTurnWithConversationEngine,
  runPreparedChatTurnStreamWithConversationEngine,
  runPreparedChatTurnWithConversationEngine,
} from "./conversationEngineChatTurn.js";
import type { RouteScopedDirectiveRuntime } from "./routeScopedDirectiveSteering.js";
import type { DirectiveStateStore } from "../../directives/public.js";
import {
  type TurnSkill,
  type TurnStreamSuggestions,
} from "./turnOutcome.js";
import type { TurnSelectionStrategy } from "./turnSelectionStrategy.js";
import { ChatTurnSkillSelector } from "./turnSkillSelector.js";
import type { AgentSkillTurnRuntime, AgentSkillTurnSkillProvider } from "./agentSkillTurnSkillProvider.js";
import type {
  ChatConversationTurnInterpreter,
  ConversationTurnInterpretationResult,
} from "./conversationTurnInterpreter.js";
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
import type { PendingClarificationResolution } from "./clarification/pendingClarificationResolver.js";
import {
  evaluateRetrievalSenseClarification,
  phraseRetrievalSenseAsk,
  type AgenticRetrievalToolFactory,
  type RetrievalExecutionDiagnostics,
  type RetrievalSenseDetectorPort,
  type StructuredRewriteResult,
} from "../../retrieval/public.js";
import {
  clarificationDecisionMetric,
  type ClarificationMetricDecision,
  type ClarificationMetricReason,
} from "./clarification/clarificationMetrics.js";
import {
  toConversationAgentConfig,
  toConversationInputEvent,
  toConversationMessages,
} from "./conversationContractMappers.js";
import type { TurnRouter, TurnRouting } from "./turnRouter.js";
import { APPROVAL_REQUEST_ACTION_TYPE } from "./actions/approvalRequestActionHandler.js";
import type { ChatTurnPlanHandle } from "./turnPlanCoordinator.js";

const CLARIFICATION_TURN_SKILL = "clarification.answer";

type PrepareRetrievalInput = Parameters<ChatSessionPreparer["prepareRetrieval"]>[0];

export type RetrievalSenseClarificationTurn =
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

const clarificationTraceStage = (
  turn: RetrievalSenseClarificationTurn | null,
): ConversationTrace["stages"][number] | undefined =>
  turn?.kind === "continue"
    ? turn.stage
    : turn?.engineTrace.stages.find((stage) => stage.kind === "clarification");

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

export interface ChatRoutineProvider {
  forTurn(input: {
    modelGateway: ConversationModelGateway;
    agentId: string;
    workspaceId?: string;
    accountId?: string;
    pinnedRoutineIds?: string[];
    /**
     * Operator-only workbench test override: routine definition ids (drafts included)
     * to make eligible for this turn, bypassing the published-only gate. Empty/absent
     * for every live end-user turn.
     */
    previewRoutineIds?: string[];
    responseLanguage?: string | Promise<string | undefined>;
    groundedAnswerRenderer?: RoutineGroundedAnswerRenderer;
    throwIfCancelled?: () => void;
    turnPlan?: ChatTurnPlanHandle;
  }): Promise<{
    activator: ConversationRoutineActivator;
    runner: ConversationRoutineRunner;
    slotCorrection?: ConversationRoutineSlotCorrection;
    reentryGate?: ConversationRoutineReentryGate;
  } | null>;
}

export const buildRoutinePendingDecisionTransition = (input: {
  session: PreparedSession;
  awaitingDecision?: RoutineAwaitingDecision;
  routineStateTransition?: CapturedRoutineTransition | null;
}) => {
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

export const buildChatTurnContext = (session: PreparedSession): TurnContext => ({
  agent: toConversationAgentConfig(session.agent),
  sessionId: session.conversation.id,
  inputEvent: toConversationInputEvent(session.userMessage),
  history: toConversationMessages(session.history),
  stagedContext: [],
  steering: [],
});

export type ChatTurnAssemblyStage = "routing" | "rendering";

export interface ChatTurnAssemblyCoordinationHook {
  readonly signal?: AbortSignal;
  checkpoint(stage: ChatTurnAssemblyStage): void;
}

export interface ChatTurnAssemblyClarification {
  store?: DeferredClarificationStore;
  resolution?: PendingClarificationResolution;
  clarifier?: ConversationClarifier;
}

export interface ChatTurnAssemblyRoutineResult {
  presentation: ChatPresentedAnswer;
  engineTrace?: ConversationTrace;
  actions?: RoutineActionRequest[];
  handoff?: { routineId: string; stepId: string };
  routineStateTransition?: CapturedRoutineTransition | null;
  pendingDecisionTransition?: ReturnType<typeof buildPendingDecisionTransition> | null;
  suspended?: boolean;
  clarificationTransition?: CapturedClarificationTransition | null;
  commitRoutineState: () => Promise<void>;
  commitClarificationState?: () => Promise<void>;
}

export type PreparedChatStreamTurnEvent =
  | { type: "status"; stage: ChatStatusStage }
  | {
      type: "chunk";
      text: string;
      deliveryMode: "live" | "committed" | "bounded_decline";
      route: "direct" | "retrieval" | "other";
    }
  | {
      type: "final";
      finalPresentation: ChatPresentedAnswer;
      suggestions: TurnStreamSuggestions;
      engineTrace?: ConversationTrace;
      actions?: RoutineActionRequest[];
    };

export interface ChatTurnAssemblyOptions {
  chatGateway: Pick<ChatGateway, "answer">;
  chatAnswerPresenter: ChatAnswerPresenter;
  chatSessionPreparer: ChatSessionPreparer;
  conversationEngine: ConversationEngine;
  turnSkills: TurnSkill[];
  selectionStrategy: TurnSelectionStrategy;
  directiveRuntime: RouteScopedDirectiveRuntime;
  directiveStateStore: DirectiveStateStore;
  turnRouter: TurnRouter;
  turnInterpreter?: ChatConversationTurnInterpreter;
  routineStore?: ConversationRoutineStore;
  routineProvider?: ChatRoutineProvider;
  clarifier?: ConversationClarifier;
  recordClarificationDecision?: (input: {
    surface: string;
    decision: ClarificationMetricDecision;
    reason?: ClarificationMetricReason;
  }) => void;
  retrievalSenseDetector?: RetrievalSenseDetectorPort;
  retrievalSenseClarificationPolicy: ClarificationPolicy;
  agentSkillTurnSkillProvider?: AgentSkillTurnSkillProvider;
  logger?: Pick<AppLogger, "warn">;
}

export type ChatTurnAssemblySharedOptions = Omit<
  ChatTurnAssemblyOptions,
  "chatSessionPreparer" | "directiveStateStore" | "routineStore"
>;

export interface ChatTurnAssemblyEffectPorts {
  chatSessionPreparer: ChatSessionPreparer;
  directiveStateStore: DirectiveStateStore;
  routineStore?: ConversationRoutineStore;
}

/**
 * Binds the runtime behavior shared by durable chat and ephemeral replay once.
 * Each surface supplies only its persistence/state effect ports.
 */
export class ChatTurnAssemblyFactory {
  constructor(private readonly shared: ChatTurnAssemblySharedOptions) {}

  create(effects: ChatTurnAssemblyEffectPorts): ChatTurnAssembly {
    return new ChatTurnAssembly({ ...this.shared, ...effects });
  }
}

export class ChatTurnAssembly {
  private readonly answerSupport = new ChatAnswerSupport();

  constructor(private readonly options: ChatTurnAssemblyOptions) {}

  async attemptRoutineTurn(
    session: PreparedSession,
    input: {
      accountId?: string;
      responseLanguage: Promise<string | undefined>;
      activeRoutine: RoutineState | null;
      clarification?: ChatTurnAssemblyClarification;
      progress?: ConversationProgressPort;
      coordination?: ChatTurnAssemblyCoordinationHook;
    },
  ): Promise<ChatTurnAssemblyRoutineResult | null> {
    if (!this.options.routineStore || !this.options.routineProvider) {
      return null;
    }
    const modelGateway = new RoutineChatModelGateway(this.options.chatGateway, {
      workspaceContext: this.answerSupport.buildChatWorkspaceContext(session),
      usageContext: this.answerSupport.buildChatUsageContext(session, input.accountId, "routine_turn"),
      signal: input.coordination?.signal,
    });
    const routineTurnPorts = await this.options.routineProvider.forTurn({
      modelGateway,
      agentId: session.agent.id,
      workspaceId: session.conversation.workspaceId,
      accountId: input.accountId,
      pinnedRoutineIds: await this.routineCatalogPinIds(session, input.activeRoutine),
      previewRoutineIds: session.previewRoutineIds,
      responseLanguage: input.responseLanguage,
      groundedAnswerRenderer: createRoutineGroundedAnswerRenderer({
        session,
        accountId: input.accountId,
        responseLanguage: input.responseLanguage,
        turnSkills: this.options.turnSkills,
      }),
      throwIfCancelled: input.coordination
        ? () => input.coordination?.checkpoint("routing")
        : undefined,
      turnPlan: session.turnPlan,
    });
    if (!routineTurnPorts) {
      return null;
    }
    const activator = input.clarification?.resolution?.kind === "routine_activation"
      ? input.clarification.resolution.activator
      : routineTurnPorts.activator;
    const deferredStore = new DeferredRoutineStore(this.options.routineStore);
    const deferredClarificationStore = input.clarification?.store;
    input.coordination?.checkpoint("routing");
    const outcome = await attemptRoutineTurnWithConversationEngine({
      engine: this.options.conversationEngine,
      session,
      accountId: input.accountId,
      directiveRuntime: this.options.directiveRuntime,
      directiveStateStore: this.options.directiveStateStore,
      routineStore: deferredStore,
      routineRunner: routineTurnPorts.runner,
      routineActivator: activator,
      routineSlotCorrection: routineTurnPorts.slotCorrection,
      routineReentryGate: routineTurnPorts.reentryGate,
      clarifier: input.clarification?.clarifier ?? this.options.clarifier,
      clarificationStore: deferredClarificationStore,
      loopGuardCandidateIds: input.clarification?.resolution?.kind === "normal"
        ? input.clarification.resolution.loopGuardCandidateIds
        : undefined,
      suppressNewClarification: input.clarification?.resolution?.suppressNewClarification,
      progress: input.progress,
      presentRoutineReply: (response) =>
        presentRoutineRenderableAnswer(this.options.chatAnswerPresenter, response),
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
      commitClarificationState: deferredClarificationStore
        ? () => deferredClarificationStore.commit()
        : undefined,
    };
  }

  async renderTurn(
    session: PreparedSession,
    input: {
      query: string;
      userExpectedLocale?: string | null;
      accountId?: string;
      coordination?: ChatTurnAssemblyCoordinationHook;
    },
  ): Promise<{
    presentation: ChatPresentedAnswer;
    engineTrace?: ConversationTrace;
    actions?: RoutineActionRequest[];
  }> {
    const { turnSkills, turnSkillSelector } = await this.turnSelectionRuntime(session, {
      coordination: input.coordination,
    });
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: this.options.conversationEngine,
      session,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.options.directiveRuntime,
      directiveStateStore: this.options.directiveStateStore,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId,
    });
    return { presentation, engineTrace: result.trace, actions: result.actions };
  }

  async renderPreparedByEngine(
    session: PreparedSession,
    input: {
      request: {
        workspaceId: string;
        accountId?: string;
        query: string;
        userExpectedLocale?: string | null;
      };
      retrievalInput: PrepareRetrievalInput;
      responseLanguagePromise: Promise<string | undefined>;
      resolvedRetrievalSense: boolean;
      clarification?: ChatTurnAssemblyClarification;
      activeRoutineAtTurnStart?: boolean;
      coordination?: ChatTurnAssemblyCoordinationHook;
    },
  ): Promise<{
    session: PreparedSession;
    presentation: ChatPresentedAnswer;
    engineTrace?: ConversationTrace;
    actions?: RoutineActionRequest[];
  }> {
    const sessionRef = { current: { ...session, effectiveQuery: input.retrievalInput.query } };
    const clarificationState: { current: RetrievalSenseClarificationTurn | null } = { current: null };
    const { turnSkills, turnSkillSelector, agentSkillRuntime } = await this.turnSelectionRuntime(
      sessionRef.current,
      {
        prependTurnSkills: [this.clarificationTurnSkill(clarificationState)],
        forceSkillName: () => clarificationState.current?.kind === "ask" ? CLARIFICATION_TURN_SKILL : null,
        coordination: input.coordination,
      },
    );
    const { turnInterpreter, retrievalWork } = this.buildEnginePreparationPorts({
      request: input.request,
      retrievalInput: input.retrievalInput,
      responseLanguagePromise: input.responseLanguagePromise,
      resolvedRetrievalSense: input.resolvedRetrievalSense,
      sessionRef,
      clarificationState,
      clarification: input.clarification,
      activeRoutineAtTurnStart: input.activeRoutineAtTurnStart,
      agenticRetrievalToolFactories: agentSkillRuntime?.agenticRetrievalToolFactories,
      coordination: input.coordination,
    });
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: this.options.conversationEngine,
      session: sessionRef.current,
      getSession: () => sessionRef.current,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.options.directiveRuntime,
      directiveStateStore: this.options.directiveStateStore,
      turnInterpreter,
      retrievalWork,
      beforeRender: async () => {
        sessionRef.current = this.withResponseLanguage(
          sessionRef.current,
          await input.responseLanguagePromise,
        );
        input.coordination?.checkpoint("rendering");
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

  async *streamTurn(
    session: PreparedSession,
    input: {
      query: string;
      userExpectedLocale?: string | null;
      accountId?: string;
      coordination?: ChatTurnAssemblyCoordinationHook;
    },
  ): AsyncIterable<PreparedChatStreamTurnEvent> {
    const { turnSkills, turnSkillSelector } = await this.turnSelectionRuntime(session, {
      coordination: input.coordination,
    });
    for await (const event of runPreparedChatTurnStreamWithConversationEngine({
      engine: this.options.conversationEngine,
      session,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.options.directiveRuntime,
      directiveStateStore: this.options.directiveStateStore,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId,
      signal: input.coordination?.signal,
    })) {
      if (event.type === "status" || event.type === "chunk") {
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

  async *streamPreparedByEngine(
    session: PreparedSession,
    input: {
      request: {
        workspaceId: string;
        accountId?: string;
        query: string;
        userExpectedLocale?: string | null;
      };
      retrievalInput: PrepareRetrievalInput;
      responseLanguagePromise: Promise<string | undefined>;
      resolvedRetrievalSense: boolean;
      clarification?: ChatTurnAssemblyClarification;
      activeRoutineAtTurnStart?: boolean;
      coordination?: ChatTurnAssemblyCoordinationHook;
    },
  ): AsyncIterable<PreparedChatStreamTurnEvent & { session?: PreparedSession }> {
    const sessionRef = { current: { ...session, effectiveQuery: input.retrievalInput.query } };
    const clarificationState: { current: RetrievalSenseClarificationTurn | null } = { current: null };
    const { turnSkills, turnSkillSelector, agentSkillRuntime } = await this.turnSelectionRuntime(
      sessionRef.current,
      {
        prependTurnSkills: [this.clarificationTurnSkill(clarificationState)],
        forceSkillName: () => clarificationState.current?.kind === "ask" ? CLARIFICATION_TURN_SKILL : null,
        coordination: input.coordination,
      },
    );
    const { turnInterpreter, retrievalWork } = this.buildEnginePreparationPorts({
      request: input.request,
      retrievalInput: input.retrievalInput,
      responseLanguagePromise: input.responseLanguagePromise,
      resolvedRetrievalSense: input.resolvedRetrievalSense,
      sessionRef,
      clarificationState,
      clarification: input.clarification,
      activeRoutineAtTurnStart: input.activeRoutineAtTurnStart,
      agenticRetrievalToolFactories: agentSkillRuntime?.agenticRetrievalToolFactories,
      coordination: input.coordination,
    });
    for await (const event of runPreparedChatTurnStreamWithConversationEngine({
      engine: this.options.conversationEngine,
      session: sessionRef.current,
      getSession: () => sessionRef.current,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.options.directiveRuntime,
      directiveStateStore: this.options.directiveStateStore,
      turnInterpreter,
      retrievalWork,
      beforeRender: async () => {
        sessionRef.current = this.withResponseLanguage(
          sessionRef.current,
          await input.responseLanguagePromise,
        );
        input.coordination?.checkpoint("rendering");
      },
      query: input.request.query,
      userExpectedLocale: input.request.userExpectedLocale,
      accountId: input.request.accountId,
      signal: input.coordination?.signal,
    })) {
      if (event.type === "status" || event.type === "chunk") {
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

  private async turnSelectionRuntime(
    session: PreparedSession,
    input: {
      prependTurnSkills?: TurnSkill[];
      forceSkillName?: () => string | null | undefined;
      coordination?: ChatTurnAssemblyCoordinationHook;
    } = {},
  ): Promise<{
    turnSkills: TurnSkill[];
    turnSkillSelector: ChatTurnSkillSelector;
    agentSkillRuntime?: AgentSkillTurnRuntime;
  }> {
    const coordination = input.coordination;
    const agentSkillRuntime = await this.options.agentSkillTurnSkillProvider?.forSession(
      session,
      coordination
        ? { throwIfCancelled: () => coordination.checkpoint("rendering") }
        : undefined,
    );
    const availableTurnSkills = [
      ...(input.prependTurnSkills ?? []),
      ...this.options.turnSkills,
      ...(agentSkillRuntime?.turnSkills ?? []),
    ];
    const turnSkills = coordination
      ? availableTurnSkills.map((skill) => ({
          ...skill,
          dispatch: (preparedSession: PreparedSession) => {
            coordination.checkpoint("rendering");
            return skill.dispatch(preparedSession);
          },
        }))
      : availableTurnSkills;
    return {
      turnSkills,
      turnSkillSelector: new ChatTurnSkillSelector(turnSkills, this.options.selectionStrategy, {
        agentSkillStates: agentSkillRuntime?.skillStates,
        logger: this.options.logger,
        forceSkillName: input.forceSkillName,
      }),
      ...(agentSkillRuntime ? { agentSkillRuntime } : {}),
    };
  }

  private buildEnginePreparationPorts(input: {
    request: {
      workspaceId: string;
      accountId?: string;
      query: string;
    };
    retrievalInput: PrepareRetrievalInput;
    responseLanguagePromise: Promise<string | undefined>;
    resolvedRetrievalSense: boolean;
    sessionRef: { current: PreparedSession };
    clarificationState?: { current: RetrievalSenseClarificationTurn | null };
    clarification?: ChatTurnAssemblyClarification;
    activeRoutineAtTurnStart?: boolean;
    agenticRetrievalToolFactories?: (session: PreparedSession) => ReadonlyArray<AgenticRetrievalToolFactory>;
    coordination?: ChatTurnAssemblyCoordinationHook;
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
        input.coordination?.checkpoint("routing");
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
          input.sessionRef.current = await this.options.chatSessionPreparer.prepareDirect(
            input.retrievalInput,
            input.sessionRef.current,
            routing.framing,
          );
          input.coordination?.checkpoint("rendering");
        }
        const metadata: Record<string, unknown> = {
          ...(interpreted.source ? { source: interpreted.source } : {}),
          ...("rewriteProposal" in interpreted && interpreted.rewriteProposal
            ? { rewriteProposal: interpreted.rewriteProposal }
            : {}),
        };
        return {
          route: routing.route,
          framing: routing.framing,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        };
      },
    };
    const retrievalWork: ConversationRetrievalWorkPort = {
      run: async ({ interpretation }) => {
        const rewriteProposal =
          interpretation.metadata?.rewriteProposal && typeof interpretation.metadata.rewriteProposal === "object"
            ? interpretation.metadata.rewriteProposal as StructuredRewriteResult
            : undefined;
        const agenticToolFactories = input.agenticRetrievalToolFactories?.(input.sessionRef.current) ?? [];
        const preparedRetrievalInput = {
          ...this.retrievalInputWithRewriteProposal(input.retrievalInput, rewriteProposal),
          ...(agenticToolFactories.length > 0 ? { agenticToolFactories } : {}),
        };
        const directiveSteering = input.sessionRef.current.directiveSteering;
        const directiveStateStore = input.sessionRef.current.directiveStateStore;
        input.sessionRef.current = this.withResponseLanguage(
          input.sessionRef.current,
          await input.responseLanguagePromise,
        );
        input.sessionRef.current = await this.options.chatSessionPreparer.prepareRetrieval(
          preparedRetrievalInput,
          input.sessionRef.current,
          input.sessionRef.current.turnFraming,
        );
        input.coordination?.checkpoint("rendering");
        if (directiveSteering) {
          input.sessionRef.current = {
            ...input.sessionRef.current,
            directiveSteering,
          };
        }
        if (directiveStateStore) {
          input.sessionRef.current = {
            ...input.sessionRef.current,
            directiveStateStore,
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
            const scopedDirectiveSteering = input.sessionRef.current.directiveSteering;
            const scopedDirectiveStateStore = input.sessionRef.current.directiveStateStore;
            input.sessionRef.current = await this.options.chatSessionPreparer.prepareRetrieval(
              {
                ...preparedRetrievalInput,
                documentScope: input.clarificationState.current.documentScope,
              },
              input.sessionRef.current,
              input.sessionRef.current.turnFraming,
            );
            input.coordination?.checkpoint("rendering");
            if (scopedDirectiveSteering) {
              input.sessionRef.current = {
                ...input.sessionRef.current,
                directiveSteering: scopedDirectiveSteering,
              };
            }
            if (scopedDirectiveStateStore) {
              input.sessionRef.current = {
                ...input.sessionRef.current,
                directiveStateStore: scopedDirectiveStateStore,
              };
            }
          }
          if (input.clarificationState.current?.kind === "continue" && input.clarificationState.current.offerAlternatives) {
            input.sessionRef.current = {
              ...input.sessionRef.current,
              retrievalSenseOfferAlternatives: input.clarificationState.current.offerAlternatives,
            };
          }
        }
        input.coordination?.checkpoint("rendering");
        return {
          stagedContext: input.sessionRef.current.stagedContext,
          trace: input.sessionRef.current.turnTrace,
          metadata: retrievalDiagnosticsMetadata(input.sessionRef.current),
        };
      },
    };
    return { turnInterpreter, retrievalWork };
  }

  async interpretChatTurnForPreparation(input: {
    request: {
      workspaceId: string;
      accountId?: string;
      query: string;
    };
    session: PreparedSession;
    resolvedRetrievalSense: boolean;
  }): Promise<ConversationTurnInterpretationResult & { source?: "planned" }> {
    const planned = await this.plannedInterpretation(
      input.session,
      input.resolvedRetrievalSense,
    );
    const interpreted = planned ?? (this.options.turnInterpreter
      ? await this.options.turnInterpreter.interpretChatTurn({
        query: input.request.query,
        history: input.session.history,
        responseIdentity: input.session.retrieval.responseIdentity,
        customInstruction: input.session.agent.customInstruction,
        workspaceId: input.request.workspaceId,
        accountId: input.request.accountId,
        conversationId: input.session.conversation.id,
        messageId: input.session.userMessage.id,
        agentSkillSettings: input.session.agent.skillSettings,
        usageAttribution: input.session.usageAttribution,
        conversationSummary: input.session.conversationSummary,
      })
      : await this.routeTurn(input.request, input.session));
    return input.resolvedRetrievalSense
      ? { ...interpreted, route: CHAT_TURN_ROUTE.RETRIEVAL }
      : interpreted;
  }

  private async plannedInterpretation(
    session: PreparedSession,
    resolvedRetrievalSense: boolean,
  ): Promise<(ConversationTurnInterpretationResult & { source: "planned" }) | null> {
    const outcome = session.turnPlan ? await session.turnPlan.resolve(null) : undefined;
    if (!outcome || outcome.status !== "planned") {
      return null;
    }
    const route = resolvedRetrievalSense ? CHAT_TURN_ROUTE.RETRIEVAL : outcome.plan.route;
    return {
      source: "planned",
      route,
      framing: outcome.plan.framing,
      ...(route === CHAT_TURN_ROUTE.RETRIEVAL && outcome.plan.rewriteProposal
        ? { rewriteProposal: outcome.plan.rewriteProposal }
        : {}),
    };
  }

  retrievalInputWithRewriteProposal(
    input: PrepareRetrievalInput,
    proposal?: StructuredRewriteResult,
  ): PrepareRetrievalInput {
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

  async maybeClarifyRetrievalSense(input: {
    session: PreparedSession;
    accountId?: string;
    clarification: ChatTurnAssemblyClarification;
    activeRoutineAtTurnStart: boolean;
  }): Promise<RetrievalSenseClarificationTurn | null> {
    if (
      !input.clarification.store ||
      !input.clarification.clarifier ||
      input.clarification.resolution?.suppressNewClarification
    ) {
      return null;
    }
    const effect = await evaluateRetrievalSenseClarification({
      detector: this.options.retrievalSenseDetector,
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
        ...input.session.usageAttribution,
      },
      policy: this.options.retrievalSenseClarificationPolicy,
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
    if (effect.kind !== "ask") {
      const engineTrace = effect.stage
        ? this.conversationTraceWithStage(input.session.turnTrace, effect.stage)
        : input.session.turnTrace;
      if (effect.stage) {
        this.recordTraceClarificationDecisions(engineTrace);
      }
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
    const clarifier = input.clarification.clarifier;
    const phrased = await phraseRetrievalSenseAsk({
      candidates: effect.candidates,
      askStage: effect.stage,
      phraseQuestion: (candidates) =>
        clarifier.phraseQuestion({ candidates, turn: buildChatTurnContext(input.session) }),
    });
    const engineTrace = this.conversationTraceWithStage(input.session.turnTrace, phrased.stage);
    this.recordTraceClarificationDecisions(engineTrace);
    if (phrased.kind === "fallback") {
      return {
        kind: "continue",
        stage: phrased.stage,
        ...(phrased.documentScope ? { documentScope: phrased.documentScope } : {}),
      };
    }
    await input.clarification.store.save({ ...effect.pending, candidates: phrased.presented });
    return {
      kind: "ask",
      presentation: this.options.chatAnswerPresenter.presentNonRetrievalAnswer(phrased.answer),
      engineTrace,
    };
  }

  private recordTraceClarificationDecisions(trace?: ConversationTrace): void {
    if (!trace || !this.options.recordClarificationDecision) {
      return;
    }
    for (const stage of trace.stages) {
      if (stage.kind !== "clarification") {
        continue;
      }
      const outputs = stage.outputs ?? {};
      const surface = typeof outputs.surface === "string" ? outputs.surface : "unknown";
      const decision = typeof outputs.decision === "string" ? outputs.decision : "";
      const stageReason = typeof outputs.reason === "string" ? outputs.reason : undefined;
      const recorded = clarificationDecisionMetric(decision, stageReason);
      if (recorded) {
        this.options.recordClarificationDecision({ surface, ...recorded });
      }
    }
  }

  private async routineCatalogPinIds(
    session: PreparedSession,
    activeRoutine: RoutineState | null,
  ): Promise<string[]> {
    const pinned = new Set<string>();
    if (activeRoutine?.status === "active") {
      pinned.add(activeRoutine.routineId);
    }
    if (!activeRoutine && this.options.routineStore?.loadCompleted) {
      const completed = await this.options.routineStore.loadCompleted({
        sessionId: session.conversation.id,
      });
      for (const state of completed) {
        pinned.add(state.routineId);
      }
    }
    return [...pinned];
  }

  conversationTraceWithStage(
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

  private withResponseLanguage(
    session: PreparedSession,
    responseLanguage: string | undefined,
  ): PreparedSession {
    return {
      ...session,
      responseLanguage,
    };
  }

  private async routeTurn(
    input: {
      workspaceId: string;
      accountId?: string;
      query: string;
    },
    session: PreparedSession,
  ): Promise<TurnRouting> {
    const routing = await this.options.turnRouter.classify({
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
        ...session.usageAttribution,
      },
    });
    return {
      route: routing.route,
      framing: routing.framing,
    };
  }
}
