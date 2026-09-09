import type {
  ConversationClarifier,
  ConversationCoverageRoutineActivator,
  ConversationCoverageReactionRecorder,
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
  AnswerCoverageAssessment,
  ClarificationCandidate,
  ClarificationPolicy,
  PendingClarification,
  RoutineActionRequest,
  Routine,
  RoutineAwaitingDecision,
  RoutineState,
  ProcessTurnResult,
  TurnContext,
  TurnOutcome,
} from "@radioso/conversation-contract";
import type { RoutineGroundedAnswerRenderer } from "@radioso/conversation-contract";

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
import { DeferredCoverageReactionRecorder } from "./answerCoverage/deferredCoverageReactionRecorder.js";
import {
  DeferredClarificationStore,
  type CapturedClarificationTransition,
} from "./clarification/deferredClarificationStore.js";
import type { PendingClarificationResolution } from "./clarification/pendingClarificationResolver.js";
import {
  evaluateRetrievalSenseClarification,
  phraseRetrievalSenseAsk,
  presentableSenseCandidates,
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
import type { TurnExecutionMode } from "../../../shared/domain/turnExecutionMode.js";
import type { ChatAnswerCoverageAssessorFactory } from "./chatAnswerCoverageAssessor.js";
import type { AnswerCoverageRecord } from "../../answerCoverage/public.js";
import { pageReadRoutineCandidates } from "./pageRead/pageReadRoutineCandidates.js";
import { freezePageReadOutcome } from "./pageRead/pageReadSessionOutcome.js";

const CLARIFICATION_TURN_SKILL = "clarification.answer";

/**
 * An admitted current-page excerpt makes a retrieval-sense question unnecessary.
 * The evaluator still scopes workspace retrieval; only its visitor-facing question
 * is suppressed.
 */
export const shouldSuppressRetrievalSenseClarification = (
  session: Pick<PreparedSession, "pageReadOutcome">,
): boolean => session.pageReadOutcome?.gate.kind === "capture";

type PrepareRetrievalInput = Parameters<ChatSessionPreparer["prepareRetrieval"]>[0];

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

export const applyCoverageAssessment = (
  session: Pick<PreparedSession, "answerCoverage" | "answerCoverageDebug" | "answerCoverageInteractionTrace" | "effectiveQuery" | "userMessage">,
  input: { assessment: AnswerCoverageAssessment; record?: AnswerCoverageRecord },
): void => {
  session.answerCoverage = input.assessment;
  const record = input.record;
  session.answerCoverageDebug = {
    availability: input.assessment.availability,
    contextualizedRequest: record?.contextualizedRequest ?? session.effectiveQuery ?? session.userMessage.content,
    originatingTurnId: record?.originatingTurnId ?? session.userMessage.id,
    originatingRequestId: record?.requestMessageId ?? session.userMessage.id,
    ...(record
      ? { schemaVersion: record.schemaVersion, assessedAt: record.assessedAt.toISOString() }
      : input.assessment.availability === "assessed" ? { schemaVersion: input.assessment.schemaVersion } : {}),
    ...(input.assessment.availability === "assessed" ? {
      coverage: input.assessment.coverage,
      reason: input.assessment.reason,
      ...(input.assessment.unresolvedRequest ? { unresolvedRequest: input.assessment.unresolvedRequest } : {}),
    } : {}),
  };
  // Persisted assessments whose reaction pass has not yet completed project as
  // `not_evaluated` in history. Set the same live state before the recorder runs;
  // only its success callback below is allowed to replace it with `evaluated`.
  session.answerCoverageInteractionTrace = input.assessment.availability === "assessed" && record?.availability === "assessed"
    ? { state: "not_evaluated", decisions: [] }
    : undefined;
};

export const applyCoverageInteractionTrace = (
  session: Pick<PreparedSession, "answerCoverageInteractionTrace" | "userMessage">,
  reaction: Parameters<ConversationCoverageReactionRecorder["record"]>[0],
): void => {
  session.answerCoverageInteractionTrace = {
    state: reaction.evaluationState === "evaluated" ? "evaluated" : "not_evaluated",
    ...(reaction.assessment.availability === "assessed" ? {
      consumedAssessment: {
        coverage: reaction.assessment.coverage,
        reason: reaction.assessment.reason,
      },
    } : {}),
    decisions: reaction.reactions.flatMap((entry) => {
      const target = entry.directiveId
        ? { target: "directive" as const, targetId: entry.directiveId }
        : entry.routineId ? { target: "routine" as const, targetId: entry.routineId } : null;
      return target ? [{
        assessmentRequestId: session.userMessage.id,
        ...target,
        decision: entry.decision,
        reasonCode: entry.reasonCode,
        ...(entry.routineExecutionId ? { routineExecutionId: entry.routineExecutionId } : {}),
        targetMessageId: session.userMessage.id,
      }] : [];
    }),
  };
};

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
    executionMode?: TurnExecutionMode;
    responseLanguage?: string | Promise<string | undefined>;
    groundedAnswerRenderer?: RoutineGroundedAnswerRenderer;
    throwIfCancelled?: () => void;
    turnPlan?: ChatTurnPlanHandle;
  }): Promise<{
    routines?: readonly Routine[];
    activator: ConversationRoutineActivator;
    coverageActivator?: ConversationCoverageRoutineActivator;
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

/**
 * Aligns an "offer" clarification's persisted candidates with what the visitor was
 * actually offered, mirroring the "ask" path's use of `phrased.presented` (below).
 *
 * The "offer" effect carries `[topPick, ...alternatives]` (`retrievalSenseClarification.ts`),
 * but only the alternatives are ever shown: the answer prompt renders `{{alternatives}}`,
 * and the top pick is the interpretation already answered rather than a choice on
 * offer. Persisting the top pick at position 0 made a positional reply ("the first
 * one") resolve to the already-answered document, because the reply mapper numbers
 * the stored list and its prompt states that numbering is the offered order. Storing
 * only the presentable alternatives, in the order offered, makes that claim true.
 *
 * Pure and exported so it is unit-testable without constructing the full
 * {@link ChatTurnAssembly}.
 */
export const alignOfferPendingCandidates = (
  pending: Omit<PendingClarification, "askedEventId">,
  offeredAlternatives: ClarificationCandidate[],
): Omit<PendingClarification, "askedEventId"> => ({
  ...pending,
  candidates: presentableSenseCandidates(offeredAlternatives),
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
  commitCoverageReactions?: () => Promise<void>;
}

interface CoverageRoutineEffects {
  actions?: RoutineActionRequest[];
  handoff?: { routineId: string; stepId: string };
  routineStateTransition?: CapturedRoutineTransition | null;
  pendingDecisionTransition?: ReturnType<typeof buildPendingDecisionTransition> | null;
  suspended?: boolean;
  commitRoutineState?: () => Promise<void>;
  clarificationTransition?: CapturedClarificationTransition | null;
  commitClarificationState?: () => Promise<void>;
  commitCoverageReactions?: () => Promise<void>;
}

type PreparedChatStreamTurnEvent =
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
    } & CoverageRoutineEffects;

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
  /** Host-owned post-evidence semantic assessment; absent preserves every legacy turn. */
  coverageAssessorFactory?: ChatAnswerCoverageAssessorFactory;
}

type ChatTurnAssemblySharedOptions = Omit<
  ChatTurnAssemblyOptions,
  "chatSessionPreparer" | "directiveStateStore" | "routineStore"
>;

interface ChatTurnAssemblyEffectPorts {
  chatSessionPreparer: ChatSessionPreparer;
  directiveStateStore: DirectiveStateStore;
  routineStore?: ConversationRoutineStore;
  coverageAssessorFactory?: ChatAnswerCoverageAssessorFactory;
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

  private logCoverageRoutineFailure(trace: ConversationTrace | undefined, session: PreparedSession): void {
    const stage = trace?.stages.find((entry) => entry.id === "answer_coverage_routine_activation");
    if (stage?.status !== "fallback" || stage.outputs?.availability !== "failed") {
      return;
    }
    const failureKind = stage.outputs.failureKind;
    const causeType = stage.outputs.causeType;
    this.options.logger?.warn({
      event: "routine_activation_failed",
      workspaceId: session.conversation.workspaceId,
      conversationId: session.conversation.id,
      ...(typeof failureKind === "string" ? { failureKind } : {}),
      ...(typeof causeType === "string" ? { causeType } : {}),
    }, "Coverage routine activation failed");
  }

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
      executionMode: session.executionMode,
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
    const pageReadAwareRunner: ConversationRoutineRunner = {
      resume: async (resumeInput) => {
        const planned = session.turnPlan
          ? await session.turnPlan.resolve(null)
          : undefined;
        const routine = routineTurnPorts.routines?.find(
          (candidate) => candidate.id === resumeInput.state.routineId,
        );
        // Tentative: the routine may yield the turn off-topic, so the decision is
        // frozen on a detached carrier and the routine binds against a scoped
        // staged view. Only a non-yielded result commits capture to the session.
        const candidate = freezePageReadOutcome(
          { pageReadCapability: session.pageReadCapability },
          {
            planner: planned?.status === "planned"
              ? planned.plan.pageRead ?? null
              : null,
            routineCandidates: routine ? pageReadRoutineCandidates(routine) : [],
            directiveCandidates: [],
            fallbackRequest: session.effectiveQuery,
          },
        );
        const result = await routineTurnPorts.runner.resume({
          ...resumeInput,
          turn: {
            ...resumeInput.turn,
            stagedContext: this.options.chatSessionPreparer.stagedPageContextFor(session, candidate),
          },
        });
        if (!result.yielded) {
          session.pageReadOutcome ??= candidate;
          this.options.chatSessionPreparer.applyFrozenPageReadOutcome(session);
        }
        return result;
      },
    };
    const outcome = await attemptRoutineTurnWithConversationEngine({
      engine: this.options.conversationEngine,
      session,
      accountId: input.accountId,
      directiveRuntime: this.options.directiveRuntime,
      directiveStateStore: this.options.directiveStateStore,
      routineStore: deferredStore,
      routineRunner: pageReadAwareRunner,
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

  /**
   * Builds the separate, coverage-only activation port for the engine's
   * post-evidence pass. The routine provider excludes these registrations from
   * the normal activator, so creating this port cannot make a coverage routine
   * claim a pre-retrieval turn.
   */
  private async coverageTurnRuntime(
    session: PreparedSession,
    input: {
      accountId?: string;
      responseLanguage: Promise<string | undefined>;
      coordination?: ChatTurnAssemblyCoordinationHook;
      getSession?: () => PreparedSession;
      clarification?: ChatTurnAssemblyClarification;
    },
  ): Promise<{
    coverageRoutineActivator?: ConversationCoverageRoutineActivator;
    routineStore?: ConversationRoutineStore;
    routineRunner?: ConversationRoutineRunner;
    clarifier?: ConversationClarifier;
    clarificationStore?: DeferredClarificationStore;
    coverageReactionRecorder?: ConversationCoverageReactionRecorder;
    effects?: (result: ProcessTurnResult) => CoverageRoutineEffects;
  }> {
    if (!this.options.coverageAssessorFactory) {
      return {};
    }
    const getSession = input.getSession ?? (() => session);
    const reactionRecorder = this.options.coverageAssessorFactory.createReactionRecorder({
      getSession,
      onRecorded: (reaction) => { applyCoverageInteractionTrace(getSession(), reaction); },
    });
    const deferredReactionRecorder = reactionRecorder
      ? new DeferredCoverageReactionRecorder(reactionRecorder)
      : undefined;
    const reactionEffects = (result: ProcessTurnResult): CoverageRoutineEffects => ({
      actions: result.actions,
      commitCoverageReactions: deferredReactionRecorder
        ? () => deferredReactionRecorder.commit()
        : undefined,
    });
    if (!this.options.routineStore || !this.options.routineProvider) {
      return {
        coverageReactionRecorder: deferredReactionRecorder,
        effects: reactionEffects,
      };
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
      pinnedRoutineIds: await this.routineCatalogPinIds(session, null),
      previewRoutineIds: session.previewRoutineIds,
      executionMode: session.executionMode,
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
    if (!routineTurnPorts?.coverageActivator) {
      return {
        coverageReactionRecorder: deferredReactionRecorder,
        effects: reactionEffects,
      };
    }
    const deferredStore = new DeferredRoutineStore(this.options.routineStore);
    const deferredClarificationStore = input.clarification?.store;
    return {
      coverageRoutineActivator: routineTurnPorts.coverageActivator,
      routineStore: deferredStore,
      routineRunner: routineTurnPorts.runner,
      clarifier: input.clarification?.clarifier ?? this.options.clarifier,
      clarificationStore: deferredClarificationStore,
      coverageReactionRecorder: deferredReactionRecorder,
      effects: (result) => {
        const routineStateTransition = deferredStore.getTransition();
        const pendingDecisionTransition = buildRoutinePendingDecisionTransition({
          session: getSession(),
          awaitingDecision: result.awaitingDecision,
          routineStateTransition,
        });
        return {
          actions: pendingDecisionTransition
            ? [
                ...(result.actions ?? []),
                buildApprovalRequestAction({
                  handle: pendingDecisionTransition.handle,
                  conversationId: pendingDecisionTransition.conversationId,
                  workspaceId: pendingDecisionTransition.workspaceId,
                  agentId: pendingDecisionTransition.agentId,
                  routineId: pendingDecisionTransition.routineId,
                  stepId: pendingDecisionTransition.stepId,
                }),
              ]
            : result.actions,
          handoff: result.handoff,
          routineStateTransition,
          pendingDecisionTransition,
          suspended: Boolean(result.awaitingDecision),
          commitRoutineState: () => deferredStore.commit(),
          clarificationTransition: deferredClarificationStore?.getTransition(),
          commitClarificationState: deferredClarificationStore
            ? () => deferredClarificationStore.commit()
            : undefined,
          commitCoverageReactions: deferredReactionRecorder
            ? () => deferredReactionRecorder.commit()
            : undefined,
        };
      },
    };
  }

  async renderTurn(
    session: PreparedSession,
    input: {
      query: string;
      userExpectedLocale?: string | null;
      accountId?: string;
      responseLanguage?: Promise<string | undefined>;
      clarification?: ChatTurnAssemblyClarification;
      coordination?: ChatTurnAssemblyCoordinationHook;
    },
  ): Promise<{
    presentation: ChatPresentedAnswer;
    engineTrace?: ConversationTrace;
    actions?: RoutineActionRequest[];
  } & CoverageRoutineEffects> {
    const coverageTurnRuntime = await this.coverageTurnRuntime(session, {
      accountId: input.accountId,
      responseLanguage: input.responseLanguage ?? Promise.resolve(undefined),
      coordination: input.coordination,
      getSession: () => session,
      clarification: input.clarification,
    });
    const { turnSkills, turnSkillSelector } = await this.turnSelectionRuntime(session, {
      coordination: input.coordination,
    });
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: this.options.conversationEngine,
      session,
      chatAnswerPresenter: this.options.chatAnswerPresenter,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.options.directiveRuntime,
      directiveStateStore: this.options.directiveStateStore,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId,
      coverageAssessor: this.options.coverageAssessorFactory?.create({
        getSession: () => session,
        accountId: input.accountId,
        signal: input.coordination?.signal,
        onAssessment: (assessment) => { applyCoverageAssessment(session, assessment); },
      }),
      ...coverageTurnRuntime,
    });
    this.logCoverageRoutineFailure(result.trace, session);
    return {
      presentation,
      engineTrace: result.trace,
      ...(coverageTurnRuntime.effects?.(result) ?? { actions: result.actions }),
    };
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
  } & CoverageRoutineEffects> {
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
      agenticRetrievalToolFactories: agentSkillRuntime
        ? (currentSession) => agentSkillRuntime.agenticRetrievalToolFactories(currentSession)
        : undefined,
      coordination: input.coordination,
    });
    const coverageTurnRuntime = await this.coverageTurnRuntime(sessionRef.current, {
      accountId: input.request.accountId,
      responseLanguage: input.responseLanguagePromise,
      coordination: input.coordination,
      getSession: () => sessionRef.current,
      clarification: input.clarification,
    });
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: this.options.conversationEngine,
      session: sessionRef.current,
      chatAnswerPresenter: this.options.chatAnswerPresenter,
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
      coverageAssessor: this.options.coverageAssessorFactory?.create({
        getSession: () => sessionRef.current,
        accountId: input.request.accountId,
        signal: input.coordination?.signal,
        onAssessment: (assessment) => { applyCoverageAssessment(sessionRef.current, assessment); },
      }),
      ...coverageTurnRuntime,
    });
    const stage = clarificationTraceStage(clarificationState.current);
    const engineTrace = stage
      ? this.conversationTraceWithStage(result.trace, stage)
      : result.trace;
    this.logCoverageRoutineFailure(engineTrace, sessionRef.current);
    return {
      session: sessionRef.current,
      presentation,
      engineTrace,
      ...(coverageTurnRuntime.effects?.(result) ?? { actions: result.actions }),
    };
  }

  async *streamTurn(
    session: PreparedSession,
    input: {
      query: string;
      userExpectedLocale?: string | null;
      accountId?: string;
      responseLanguage?: Promise<string | undefined>;
      clarification?: ChatTurnAssemblyClarification;
      coordination?: ChatTurnAssemblyCoordinationHook;
    },
  ): AsyncIterable<PreparedChatStreamTurnEvent> {
    const coverageTurnRuntime = await this.coverageTurnRuntime(session, {
      accountId: input.accountId,
      responseLanguage: input.responseLanguage ?? Promise.resolve(undefined),
      coordination: input.coordination,
      getSession: () => session,
      clarification: input.clarification,
    });
    const { turnSkills, turnSkillSelector } = await this.turnSelectionRuntime(session, {
      coordination: input.coordination,
    });
    for await (const event of runPreparedChatTurnStreamWithConversationEngine({
      engine: this.options.conversationEngine,
      session,
      chatAnswerPresenter: this.options.chatAnswerPresenter,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.options.directiveRuntime,
      directiveStateStore: this.options.directiveStateStore,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId,
      signal: input.coordination?.signal,
      coverageAssessor: this.options.coverageAssessorFactory?.create({
        getSession: () => session,
        accountId: input.accountId,
        signal: input.coordination?.signal,
        onAssessment: (assessment) => { applyCoverageAssessment(session, assessment); },
      }),
      ...coverageTurnRuntime,
    })) {
      if (event.type === "status" || event.type === "chunk") {
        yield event;
        continue;
      }
      this.logCoverageRoutineFailure(event.engineTrace, session);
      yield {
        type: "final",
        finalPresentation: event.presentation,
        suggestions: event.suggestions,
        engineTrace: event.engineTrace,
        ...(coverageTurnRuntime.effects?.(event.result) ?? { actions: event.result.actions }),
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
  ): AsyncIterable<PreparedChatStreamTurnEvent & { session?: PreparedSession } & CoverageRoutineEffects> {
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
      agenticRetrievalToolFactories: agentSkillRuntime
        ? (currentSession) => agentSkillRuntime.agenticRetrievalToolFactories(currentSession)
        : undefined,
      coordination: input.coordination,
    });
    const coverageTurnRuntime = await this.coverageTurnRuntime(sessionRef.current, {
      accountId: input.request.accountId,
      responseLanguage: input.responseLanguagePromise,
      coordination: input.coordination,
      getSession: () => sessionRef.current,
      clarification: input.clarification,
    });
    for await (const event of runPreparedChatTurnStreamWithConversationEngine({
      engine: this.options.conversationEngine,
      session: sessionRef.current,
      chatAnswerPresenter: this.options.chatAnswerPresenter,
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
      coverageAssessor: this.options.coverageAssessorFactory?.create({
        getSession: () => sessionRef.current,
        accountId: input.request.accountId,
        signal: input.coordination?.signal,
        onAssessment: (assessment) => { applyCoverageAssessment(sessionRef.current, assessment); },
      }),
      ...coverageTurnRuntime,
    })) {
      if (event.type === "status" || event.type === "chunk") {
        yield event;
        continue;
      }
      this.logCoverageRoutineFailure(event.engineTrace, sessionRef.current);
      const stage = clarificationTraceStage(clarificationState.current);
      yield {
        type: "final",
        finalPresentation: event.presentation,
        suggestions: event.suggestions,
        engineTrace: stage
          ? this.conversationTraceWithStage(event.engineTrace, stage)
          : event.engineTrace,
        ...(coverageTurnRuntime.effects?.(event.result) ?? { actions: event.result.actions }),
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
        pageReadCapability: input.session.pageReadCapability,
      })
      : await this.routeTurn(input.request, input.session));
    const resolved = input.resolvedRetrievalSense
      ? { ...interpreted, route: CHAT_TURN_ROUTE.RETRIEVAL }
      : interpreted;
    freezePageReadOutcome(input.session, {
      // routeTurn's TurnRouting fallback carries no pageRead classification.
      planner: ("pageRead" in resolved
        ? (resolved as ConversationTurnInterpretationResult).pageRead
        : undefined) ?? null,
      routineCandidates: [],
      directiveCandidates: [],
      fallbackRequest: input.session.effectiveQuery,
    });
    return resolved;
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
      ...(outcome.plan.pageRead ? { pageRead: outcome.plan.pageRead } : {}),
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
    const suppressAskForPageCapture = shouldSuppressRetrievalSenseClarification(input.session);
    const effect = await evaluateRetrievalSenseClarification({
      detector: this.options.retrievalSenseDetector,
      workspaceId: input.session.conversation.workspaceId,
      rankedCandidates: input.session.retrieval.contexts,
      conversationId: input.session.conversation.id,
      messageId: input.session.userMessage.id,
      originalQuery: input.session.userMessage.content,
      retrievalSubqueries: input.session.retrieval.diagnostics.retrievalSubqueries,
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
      suppressAsk: input.activeRoutineAtTurnStart || suppressAskForPageCapture,
      ...(suppressAskForPageCapture
        ? { suppressAskReason: "page_capture" as const }
        : {}),
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
        await input.clarification.store.save(
          alignOfferPendingCandidates(effect.pending, effect.alternatives),
        );
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
