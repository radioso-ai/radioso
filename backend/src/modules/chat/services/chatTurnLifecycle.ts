import { createHash, randomUUID } from "node:crypto";

import type { ConversationTrace, RoutineActionRequest } from "@radioso/conversation-contract";
import type { AuditEventInput, AuditService } from "../../audit/contracts/index.js";
import { DefaultAllowCapabilityPolicy, type CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../../shared/domain/actionCapabilities.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { PendingDecisionCreateInput } from "../../../db/repositories/pendingDecisionRepository.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type {
  ConversationOwnershipReason,
  ConversationOwnershipRequestHandoffInput,
} from "../../../db/repositories/conversationOwnershipRepository.js";
import {
  ActivitySummaryPresenter,
  ActivityTracePresenter,
  type ActivityTrace,
  type RewriteContinuityState,
} from "../../retrieval/public.js";
import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import {
  type AssistantTurnOutcome,
  type SkillTurnOutcome,
  legacyAnswerOutcomeForSkillTurnOutcome,
} from "./assistantTurnOutcomeTypes.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import { buildRewriteContinuityState } from "./rewriteContinuityState.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";
import type { ChatResponse, ChatRoute, ChatSuggestion } from "../types/chatResponses.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { appendDirectiveSteeringStage } from "./directiveTracePresenter.js";
import { appendConversationSummaryStage } from "./conversationSummaryTracePresenter.js";
import {
  attachCapabilitySubTrace,
  attachContextVariablesToGather,
  buildTurnTraceEnvelope,
  type TurnTraceEnvelope,
} from "./turnTraceEnvelope.js";
import {
  RETRIEVAL_TRACE_LEAF,
  capabilitySubTrace,
} from "./chatTraceLeaves.js";
import type { CapturedRoutineTransition } from "./routines/deferredRoutineStore.js";
import type { CapturedClarificationTransition } from "./clarification/deferredClarificationStore.js";
import type { ConversationSummaryUpdater } from "./summary/conversationSummaryService.js";
import type { ModelCallTraceCollector } from "../../../shared/observability/tracing/modelCallTraceContext.js";

const DISPATCH_STAGE_ID_PREFIX = "dispatch:";

/**
 * Hang the retrieval activity trace on the engine spine's terminal dispatch stage.
 * The stage is found by kind (an assistant turn dispatches one terminal skill), so
 * this is robust to the presentation skill name being reclassified (grounded-miss).
 */
const attachRetrievalActivityTrace = (
  spine: ConversationTrace,
  activityTrace: ActivityTrace,
): ConversationTrace => {
  const dispatchStage = spine.stages.find((stage) => stage.kind === "skill_dispatch");
  if (!dispatchStage) {
    return spine;
  }
  const skillName = typeof dispatchStage.outputs?.skillName === "string"
    ? dispatchStage.outputs.skillName
    : dispatchStage.id.startsWith(DISPATCH_STAGE_ID_PREFIX)
      ? dispatchStage.id.slice(DISPATCH_STAGE_ID_PREFIX.length)
      : dispatchStage.id;
  return attachCapabilitySubTrace(spine, {
    skillName,
    subTrace: capabilitySubTrace(RETRIEVAL_TRACE_LEAF, activityTrace),
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRetrievalSkillName = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith("retrieval.");

const traceIncludesRetrievalSkillDispatch = (trace?: ConversationTrace): boolean =>
  trace?.stages.some((stage) => {
    if (isRetrievalSkillName(stage.outputs?.skillName)) {
      return true;
    }

    if (stage.subTrace?.namespace !== "routine" || !isRecord(stage.subTrace.payload)) {
      return false;
    }

    const steps = stage.subTrace.payload.steps;
    return Array.isArray(steps) && steps.some((step) =>
      isRecord(step)
      && step.event === "skill_dispatched"
      && isRetrievalSkillName(step.skillName),
    );
  }) ?? false;

export const getChatTurnRoute = (session: PreparedSession, engineTrace?: ConversationTrace): ChatRoute => {
  if (traceIncludesRetrievalSkillDispatch(engineTrace)) {
    return {
      type: "retrieval",
      reason: "evidence_required",
    };
  }

  if (session.turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL) {
    return {
      type: "direct",
      reason: session.turnFraming?.isIdentityQuestion
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

/** The narrow slice of the action outbox the turn lifecycle needs (idempotent enqueue). */
export interface ChatActionOutboxPort {
  enqueue(input: {
    type: string;
    payload: Record<string, unknown>;
    workspaceId?: string | null;
    accountId?: string | null;
    conversationId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ id: string; duplicate: boolean }>;
}

// Content-addressed idempotency key so a retried turn that re-emits the same request
// (same conversation + action type + payload) enqueues it once.
export const actionIdempotencyKey = (
  conversationId: string,
  type: string,
  payload: Record<string, unknown>,
): string =>
  `routine-action:${conversationId}:${type}:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;

const toPresentationSkillTurnOutcome = (presentation: ChatPresentedAnswer): SkillTurnOutcome => ({
  skillName: presentation.skillName,
  outcome: presentation.skillOutcome,
  status: presentation.skillStatus,
});

type MessageCreateInput = Parameters<MessageRepositoryPort["create"]>[0];

class RoutineActionAuthorizationError extends Error {
  constructor(
    readonly actionType: string,
    readonly reason: string,
    readonly capability?: string,
  ) {
    super("routine_action_authorization_denied");
    this.name = "RoutineActionAuthorizationError";
  }
}

export interface AssistantTurnPersistencePort {
  completeAssistantTurn(input: {
    workspaceId: string;
    accountId?: string | null;
    conversationId: string;
    actions?: RoutineActionRequest[];
    routineStateTransition?: CapturedRoutineTransition | null;
    pendingDecisionTransition?: PendingDecisionCreateInput | null;
    clarificationTransition?: CapturedClarificationTransition | null;
    assistantMessage: MessageCreateInput;
    auditEvent: AuditEventInput;
    ownershipHandoff?: OwnershipHandoffInput | null;
    ownershipAuditEvent?: AuditEventInput | null;
    additionalAuditEvent?: AuditEventInput | null;
    transaction?: Db;
  }): Promise<MessageRecord>;
}

export interface PendingDecisionWriterPort {
  create(input: PendingDecisionCreateInput): Promise<unknown>;
}

export interface ConversationOwnershipWriterPort {
  requestHandoff(input: ConversationOwnershipRequestHandoffInput): Promise<unknown>;
}

export interface OwnershipHandoffInput {
  reason: ConversationOwnershipReason;
  routineId?: string;
  stepId?: string;
}

interface AssistantTurnSuccessInput {
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
  turnTrace?: TurnTraceEnvelope;
  route: ChatRoute;
  stream: boolean;
  groundingVerdict?: ChatPresentedAnswer["grounding"];
  groundingProtocolVersion?: 1 | 2 | null;
  groundingDiagnostics?: ChatPresentedAnswer["groundingDiagnostics"];
}

export interface BuildTurnTraceForPresentationInput {
  workspaceId: string;
  accountId?: string;
  session: PreparedSession;
  presentation: ChatPresentedAnswer;
  answerStartedAt: number;
  stream: boolean;
  engineTrace?: ConversationTrace;
  modelCallTrace?: ModelCallTraceCollector;
}

export interface TurnTracePresentation {
  route: ChatRoute;
  skillTurnOutcome: SkillTurnOutcome;
  activityTrace: ActivityTrace;
  turnTrace?: TurnTraceEnvelope;
  resolvedActivitySummary: NonNullable<ActivityTrace["summary"]>;
  assistantMessage: MessageCreateInput;
  successInput: AssistantTurnSuccessInput;
}

export const buildTurnTraceForPresentation = (
  input: BuildTurnTraceForPresentationInput,
): TurnTracePresentation => {
  const activitySummaryPresenter = new ActivitySummaryPresenter();
  const activityTracePresenter = new ActivityTracePresenter();
  const route = getChatTurnRoute(input.session, input.engineTrace);
  const skillTurnOutcome = toPresentationSkillTurnOutcome(input.presentation);
  const retrieval = input.presentation.effectiveRetrieval ?? input.session.retrieval;
  const execution = {
    surface: "assistant" as const,
    path: route.type === "direct" ? "assistant_direct" as const : "assistant_retrieval" as const,
    retrievalInvoked: route.type === "retrieval",
  };
  const activitySummary = {
    ...activitySummaryPresenter.present(retrieval.diagnostics, {
      execution,
    }),
    assistant: {
      route: route.type,
      routeReason: route.reason,
      isIdentityQuestion: input.session.turnFraming?.isIdentityQuestion ?? false,
    },
  };
  const activityTrace = appendConversationSummaryStage(
    appendDirectiveSteeringStage(
      activityTracePresenter.appendAnswerOutcome({
        trace: retrieval.trace,
        summary: activitySummary,
        outcome: {
          answer: input.presentation.answer,
          stream: input.stream,
          hadContexts: retrieval.contexts.length > 0,
          retrievalSkipped: retrieval.diagnostics.retrievalSkipped,
          durationMs: Date.now() - input.answerStartedAt,
          answerOutcome: input.presentation.answerOutcome,
          skillName: skillTurnOutcome.skillName,
          skillOutcome: skillTurnOutcome.outcome,
          skillStatus: skillTurnOutcome.status,
        },
      }),
      input.session.directiveSteering,
    ),
    input.session.conversationSummary,
  );
  const resolvedActivitySummary = activityTrace.summary ?? activitySummary;
  const contextVariablesSnapshot = input.session.resolvedContext.snapshot;
  const hasContextVariablesSnapshot = Object.keys(contextVariablesSnapshot).length > 0;
  const directiveFirings = input.session.directiveStateStore?.capturedFiringNames() ?? [];
  // The conversation spine is the root span; retrieval rides as a typed leaf on
  // its dispatch stage, and the resolved (redacted) visitor context rides on the
  // gather stage. Engine always runs the assistant turn, so engineTrace is
  // present — but stay defensive: no spine means no envelope this turn.
  const turnTrace = input.engineTrace
    ? buildTurnTraceEnvelope({
      spine: attachContextVariablesToGather(
        attachRetrievalActivityTrace(input.engineTrace, activityTrace),
        contextVariablesSnapshot,
      ),
      modelCallTrace: input.modelCallTrace,
    })
    : undefined;

  const assistantMessageId = randomUUID();
  const assistantMessage: MessageCreateInput = {
    id: assistantMessageId,
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
      retrievedChunks: retrieval.contexts.map((ctx, index) => ({
        chunkId: ctx.chunkId,
        documentId: ctx.documentId,
        title: ctx.title,
        rank: typeof ctx.promptPosition === "number" ? ctx.promptPosition : index,
        similarity: typeof ctx.similarity === "number" ? ctx.similarity : undefined,
        fusedScore: typeof ctx.fusedScore === "number" ? ctx.fusedScore : undefined,
        semanticScore: typeof ctx.semanticScore === "number" ? ctx.semanticScore : undefined,
        lexicalScore: typeof ctx.lexicalScore === "number" ? ctx.lexicalScore : undefined,
        lexicalRankScore: typeof ctx.lexicalRankScore === "number" ? ctx.lexicalRankScore : undefined,
        metadata: ctx.metadata,
      })),
      composedInstructions: retrieval.systemPrompt,
      // Pre-answer rolling summary (#866) the turn's prompts actually saw. Persisted
      // per-turn so an eval snapshot of this answered turn can freeze THIS text rather
      // than the post-turn regenerated row — that row is refreshed fire-and-forget
      // after the answer persists, so it can distill the very answer an eval re-generates.
      // Semantics: `null` = ran under summary-aware code and saw no summary; a MISSING
      // key = legacy pre-feature message (snapshot capture then falls back to a
      // provably-pre-answer current row).
      conversationSummary: input.session.conversationSummary ?? null,
      // Best-effort: agent-level chat model override is what we know at
      // this layer. The workspace default chat model (when no override) is
      // not threaded through, so future snapshots from those turns will
      // have a null modelId — acceptable; the eval run record captures the
      // actual model resolved at run time.
      modelProvider: input.session.agent.chatModelOverride?.provider,
      modelId: input.session.agent.chatModelOverride?.model,
      citations: input.presentation.citations ?? [],
      answerSegments: input.presentation.answerSegments,
      ...(hasContextVariablesSnapshot
        ? { contextVariables: contextVariablesSnapshot }
        : {}),
      groundingVerdict: input.presentation.grounding,
      groundingProtocolVersion: input.presentation.groundingSummary?.protocolVersion,
      groundingDiagnostics: input.presentation.groundingDiagnostics,
      ...(directiveFirings.length > 0 ? { directiveFirings } : {}),
    },
  };
  const successInput: AssistantTurnSuccessInput = {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    conversationId: input.session.conversation.id,
    userMessageId: input.session.userMessage.id,
    assistantMessageId,
    skillTurnOutcome,
    answerOutcome: input.presentation.answerOutcome,
    citations: input.presentation.citations ?? [],
    answerSegments: input.presentation.answerSegments,
    suggestions: input.presentation.suggestions,
    priorRewriteContinuityState: input.session.priorRewriteContinuityState,
    diagnostics: {
      ...retrieval.diagnostics,
      execution,
    },
    activityTrace,
    turnTrace,
    route,
    stream: input.stream,
    groundingVerdict: input.presentation.grounding,
    groundingProtocolVersion: input.presentation.groundingSummary?.protocolVersion,
    groundingDiagnostics: input.presentation.groundingDiagnostics,
  };

  return {
    route,
    skillTurnOutcome,
    activityTrace,
    turnTrace,
    resolvedActivitySummary,
    assistantMessage,
    successInput,
  };
};

export class ChatTurnLifecycle {
  private readonly activitySummaryPresenter = new ActivitySummaryPresenter();
  private readonly activityTracePresenter = new ActivityTracePresenter();
  private readonly capabilityPolicy: CapabilityPolicy;

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly auditService: AuditService,
    private readonly productAnalyticsService: ProductAnalyticsPort = new NoopProductAnalyticsService(),
    // Optional: when wired, fire-and-forget routine actions emitted this turn are
    // enqueued to the outbox at turn completion. Absent leaves turns unchanged.
    private readonly actionOutbox?: ChatActionOutboxPort,
    private readonly assistantTurnPersistence?: AssistantTurnPersistencePort,
    private readonly actionCapabilities?: ActionCapabilityMap,
    capabilityPolicy?: CapabilityPolicy,
    private readonly logger?: Pick<AppLogger, "warn">,
    private readonly pendingDecisionRepository?: PendingDecisionWriterPort,
    private readonly conversationOwnershipRepository?: ConversationOwnershipWriterPort,
    // Optional: when wired, the per-conversation rolling summary (#866) is
    // regenerated fire-and-forget after the turn is durably persisted.
    private readonly conversationSummaryUpdater?: ConversationSummaryUpdater,
  ) {
    this.capabilityPolicy = capabilityPolicy ?? new DefaultAllowCapabilityPolicy();
  }

  /** Enqueue routine-emitted fire-and-forget actions to the outbox (idempotent). */
  private async enqueueTurnActions(input: {
    actions: RoutineActionRequest[] | undefined;
    workspaceId: string;
    accountId?: string;
    conversationId: string;
  }): Promise<void> {
    if (!this.actionOutbox || !input.actions?.length) {
      return;
    }
    for (const action of input.actions) {
      await this.actionOutbox.enqueue({
        type: action.type,
        payload: action.payload,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        idempotencyKey: actionIdempotencyKey(input.conversationId, action.type, action.payload),
      });
    }
  }

  private async assertActionsAuthorized(input: {
    actions: RoutineActionRequest[] | undefined;
    workspaceId: string;
    conversationId: string;
  }): Promise<void> {
    if (!this.actionCapabilities || !input.actions?.length) {
      return;
    }

    for (const action of input.actions) {
      const denial = await this.firstDeniedActionCapability(action.type, input.workspaceId);
      if (denial) {
        this.logger?.warn(
          {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            actionType: action.type,
            reason: denial.reason,
            capability: denial.capability,
          },
          "Routine action blocked by capability policy",
        );
        throw new RoutineActionAuthorizationError(action.type, denial.reason, denial.capability);
      }
    }
  }

  private async firstDeniedActionCapability(
    actionType: string,
    workspaceId: string,
  ): Promise<{ reason: string; capability?: string } | null> {
    if (!this.actionCapabilities) {
      return null;
    }
    if (!this.actionCapabilities.has(actionType)) {
      return { reason: "unregistered_action_type" };
    }
    for (const capability of this.actionCapabilities.requiredCapabilitiesFor(actionType)) {
      const decision = await this.capabilityPolicy.can({ capability, workspaceId });
      if (!decision.allowed) {
        return { reason: decision.reason ?? "capability_denied", capability };
      }
    }
    return null;
  }

  async completeAssistantTurn(input: {
    workspaceId: string;
    accountId?: string;
    session: PreparedSession;
    presentation: ChatPresentedAnswer;
    answerStartedAt: number;
    stream: boolean;
    /**
     * The conversation engine's turn trace, present only when the engine ran the
     * turn (flag on). Recorded as audit-only observability alongside the
     * retrieval-derived activity trace; it does not change the user-facing reply.
     */
    engineTrace?: ConversationTrace;
    /** Turn-scoped model calls captured at the shared inference seam. */
    modelCallTrace?: ModelCallTraceCollector;
    /** Fire-and-forget actions a routine emitted this turn; enqueued at completion. */
    actions?: RoutineActionRequest[];
    /**
     * Flushes the routine-state transition this turn made. Invoked only after the
     * actions are enqueued, so the routine stays recoverable (un-advanced) if the
     * enqueue fails — the turn message, routine advance, and enqueue are then ordered
     * so the user is never told a request was sent without a durable outbox row.
     */
    commitRoutineState?: () => Promise<void>;
    routineStateTransition?: CapturedRoutineTransition | null;
    pendingDecisionTransition?: PendingDecisionCreateInput | null;
    ownershipHandoff?: OwnershipHandoffInput | null;
    suspended?: boolean;
    additionalAuditEvent?: AuditEventInput | null;
    transaction?: Db;
    commitClarificationState?: () => Promise<void>;
    clarificationTransition?: CapturedClarificationTransition | null;
  }): Promise<CompletedAssistantTurn> {
    const presentation = buildTurnTraceForPresentation({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      session: input.session,
      presentation: input.presentation,
      answerStartedAt: input.answerStartedAt,
      stream: input.stream,
      engineTrace: input.engineTrace,
      modelCallTrace: input.modelCallTrace,
    });

    let assistantMessage: MessageRecord;
    const suspended = input.suspended === true;
    const auditEvent = suspended
      ? this.buildAssistantTurnSuspendedAuditEvent(presentation.successInput)
      : this.buildAssistantTurnSuccessAuditEvent(presentation.successInput);
    const ownershipAuditEvent = input.ownershipHandoff
      ? this.buildOwnershipHandoffAuditEvent({
          ...input.ownershipHandoff,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          conversationId: input.session.conversation.id,
          agentId: input.session.agent.id,
        })
      : null;
    await this.assertActionsAuthorized({
      actions: input.actions,
      workspaceId: input.workspaceId,
      conversationId: input.session.conversation.id,
    });
    if (this.assistantTurnPersistence) {
      assistantMessage = await this.assistantTurnPersistence.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.session.conversation.id,
        actions: input.actions,
        routineStateTransition: input.routineStateTransition,
        pendingDecisionTransition: input.pendingDecisionTransition,
        clarificationTransition: input.clarificationTransition,
        assistantMessage: presentation.assistantMessage,
        auditEvent,
        ownershipHandoff: input.ownershipHandoff,
        ownershipAuditEvent,
        additionalAuditEvent: input.additionalAuditEvent,
        transaction: input.transaction,
      });
      this.auditService.logRecorded?.(auditEvent);
      if (!suspended) {
        await this.trackAssistantTurnCompleted(presentation.successInput);
      }
    } else {
      // Fallback for tests and non-DB hosts. Production wires a transaction port so
      // outbox enqueue, routine state, assistant message, touch, and audit commit together.
      await this.enqueueTurnActions({
        actions: input.actions,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.session.conversation.id,
      });
      await input.commitRoutineState?.();
      assistantMessage = await this.messageRepository.create(presentation.assistantMessage);
      if (input.pendingDecisionTransition && this.pendingDecisionRepository) {
        await this.pendingDecisionRepository.create(input.pendingDecisionTransition);
      }
      if (input.ownershipHandoff && this.conversationOwnershipRepository) {
        await this.conversationOwnershipRepository.requestHandoff({
          conversationId: input.session.conversation.id,
          workspaceId: input.workspaceId,
          reason: input.ownershipHandoff.reason,
        });
      }
      await input.commitClarificationState?.();
      if (suspended) {
        await this.finalizeSuspendedAssistantTurn(presentation.successInput);
      } else {
        await this.finalizeAssistantTurn(presentation.successInput);
      }
      if (ownershipAuditEvent) {
        await this.auditService.record(ownershipAuditEvent);
      }
      if (input.additionalAuditEvent) {
        await this.auditService.record(input.additionalAuditEvent);
      }
    }

    // Advance the conversation's directive firing memory (#865) once the reply is
    // durably persisted. Best-effort, off the answer path: a failure here only risks
    // a once/cooldown directive re-firing next turn, so it must never fail the turn.
    try {
      await input.session.directiveStateStore?.commit();
    } catch (error) {
      // Name/message only: raw error objects can carry provider response bodies.
      this.logger?.warn(
        {
          event: "directive_state_commit_failed",
          conversationId: input.session.conversation.id,
          errorType: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : undefined,
        },
        "Failed to persist directive firing state",
      );
    }

    // Regenerate the rolling conversation summary (#866) off the critical path.
    // Unawaited and error-swallowed: an LLM call is too slow to await, and a lost
    // update self-heals on the next turn (each regeneration derives from current
    // state). The updater swallows its own failures; this .catch is a backstop.
    if (this.conversationSummaryUpdater) {
      void this.conversationSummaryUpdater
        .refresh({
          workspaceId: input.workspaceId,
          conversationId: input.session.conversation.id,
          accountId: input.accountId,
        })
        .catch((error) => {
          // Name/message only: raw error objects can carry provider response bodies.
          this.logger?.warn(
            {
              event: "conversation_summary_generation_failed",
              conversationId: input.session.conversation.id,
              errorType: error instanceof Error ? error.name : typeof error,
              errorMessage: error instanceof Error ? error.message : undefined,
            },
            "Failed to regenerate conversation summary",
          );
        });
    }

    return {
      assistantMessageId: assistantMessage.id,
      response: {
        conversationId: input.session.conversation.id,
        agentId: input.session.agent.id,
        agentName: input.session.agent.name,
        assistantMessageId: assistantMessage.id,
        route: presentation.route,
        answer: input.presentation.answer,
        skillOutcome: presentation.skillTurnOutcome.outcome,
        answerOutcome: input.presentation.answerOutcome ?? legacyAnswerOutcomeForSkillTurnOutcome(presentation.skillTurnOutcome),
        citations: input.presentation.citations,
        answerSegments: input.presentation.answerSegments,
        suggestions: input.presentation.suggestions,
        activitySummary: presentation.resolvedActivitySummary,
        activityTrace: presentation.activityTrace,
        turnTrace: presentation.turnTrace,
      },
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

  private buildAssistantTurnSuccessAuditEvent(input: AssistantTurnSuccessInput): AuditEventInput {
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");
    return {
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
        groundingVerdict: input.groundingVerdict,
        groundingProtocolVersion: input.groundingProtocolVersion,
        groundingDiagnostics: input.groundingDiagnostics,
        rewriteContinuityState: buildRewriteContinuityState({
          previousState: input.priorRewriteContinuityState,
          diagnostics: input.diagnostics,
          citations: input.citations,
        }),
        retrieval: input.diagnostics,
        // Legacy flat trace, still read by the history path and the live frontend's
        // textual diagnostics. Retained until those consume the envelope's leaf.
        activityTrace: input.activityTrace,
        // Turn-trace envelope: conversation spine (root span) with capability traces
        // as typed leaves. The spine supersedes the old `conversationEngine.trace`
        // audit key (which nothing read), so that key is no longer written.
        ...(input.turnTrace ? { turnTrace: input.turnTrace } : {}),
      },
    };
  }

  private buildAssistantTurnSuspendedAuditEvent(input: AssistantTurnSuccessInput): AuditEventInput {
    return {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "chat.suspended",
      eventStatus: "success",
      metadata: {
        workflow: "chat.turn",
        executionClass: "durable_async",
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
        groundingVerdict: input.groundingVerdict,
        groundingProtocolVersion: input.groundingProtocolVersion,
        groundingDiagnostics: input.groundingDiagnostics,
        rewriteContinuityState: buildRewriteContinuityState({
          previousState: input.priorRewriteContinuityState,
          diagnostics: input.diagnostics,
          citations: input.citations,
        }),
        retrieval: input.diagnostics,
        activityTrace: input.activityTrace,
        ...(input.turnTrace ? { turnTrace: input.turnTrace } : {}),
      },
    };
  }

  private buildOwnershipHandoffAuditEvent(input: OwnershipHandoffInput & {
    workspaceId: string;
    accountId?: string;
    conversationId: string;
    agentId: string;
  }): AuditEventInput {
    return {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "hitl.ownership",
      eventStatus: "success",
      metadata: {
        actor: {
          type: "system",
          source: "routine",
        },
        action: "handoff_requested",
        reason: input.reason,
        conversationId: input.conversationId,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        routineId: input.routineId,
        stepId: input.stepId,
      },
    };
  }

  private async finalizeAssistantTurn(input: AssistantTurnSuccessInput): Promise<void> {
    await this.conversationRepository.touch(input.conversationId, input.workspaceId);
    await this.auditService.record(this.buildAssistantTurnSuccessAuditEvent(input));
    await this.trackAssistantTurnCompleted(input);
  }

  private async finalizeSuspendedAssistantTurn(input: AssistantTurnSuccessInput): Promise<void> {
    await this.conversationRepository.touch(input.conversationId, input.workspaceId);
    await this.auditService.record(this.buildAssistantTurnSuspendedAuditEvent(input));
  }

  private async trackAssistantTurnCompleted(input: AssistantTurnSuccessInput): Promise<void> {
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
