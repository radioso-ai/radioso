import { createHash, randomUUID } from "node:crypto";

import type { ConversationTrace, RoutineActionRequest } from "@radioso/conversation-contract";
import type { AuditEventInput, AuditService } from "../../audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import {
  ActivitySummaryPresenter,
  ActivityTracePresenter,
  type ActivityTrace,
  type RewriteContinuityState,
} from "../../retrieval/public.js";
import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import {
  ASSISTANT_TURN_OUTCOME,
  type AssistantTurnOutcome,
  type SkillTurnOutcome,
  legacyAnswerOutcomeForSkillTurnOutcome,
} from "./assistantTurnOutcomeTypes.js";
import type { ChatIntakeResult } from "./chatIntakeProvider.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import { buildRewriteContinuityState } from "./rewriteContinuityState.js";
import { CHAT_TURN_ROUTE } from "./chatTurnIntentService.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";
import type { ChatResponse, ChatRoute, ChatSuggestion } from "../types/chatResponses.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { appendDirectiveSteeringStage } from "./directiveTracePresenter.js";
import {
  attachCapabilitySubTrace,
  buildTurnTraceEnvelope,
  synthesizeDispatchSpine,
  type TurnTraceEnvelope,
} from "./turnTraceEnvelope.js";
import {
  RETRIEVAL_TRACE_LEAF,
  SKILL_INTAKE_TRACE_LEAF,
  capabilitySubTrace,
} from "./chatTraceLeaves.js";
import type { CapturedRoutineTransition } from "./routines/deferredRoutineStore.js";

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

export const getChatTurnRoute = (session: PreparedSession): ChatRoute => {
  if (session.turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL) {
    return {
      type: "direct",
      reason: session.retrieval.diagnostics.responseIntent === "assistant_identity"
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

const toIntakeSkillTurnOutcome = (intakeResult: ChatIntakeResult): SkillTurnOutcome => ({
  skillName: intakeResult.skillName,
  outcome: intakeResult.skillOutcome ?? "unknown",
  status: intakeResult.status,
});

type MessageCreateInput = Parameters<MessageRepositoryPort["create"]>[0];

export interface AssistantTurnPersistencePort {
  completeAssistantTurn(input: {
    workspaceId: string;
    accountId?: string | null;
    conversationId: string;
    actions?: RoutineActionRequest[];
    routineStateTransition?: CapturedRoutineTransition | null;
    assistantMessage: MessageCreateInput;
    auditEvent: AuditEventInput;
  }): Promise<MessageRecord>;
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
  skillIntake?: {
    skillName: string;
    status: ChatIntakeResult["status"];
    skillOutcome?: string;
    stateId?: string;
  };
}

export class ChatTurnLifecycle {
  private readonly activitySummaryPresenter = new ActivitySummaryPresenter();
  private readonly activityTracePresenter = new ActivityTracePresenter();

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly auditService: AuditService,
    private readonly productAnalyticsService: ProductAnalyticsPort = new NoopProductAnalyticsService(),
    // Optional: when wired, fire-and-forget routine actions emitted this turn are
    // enqueued to the outbox at turn completion. Absent leaves turns unchanged.
    private readonly actionOutbox?: ChatActionOutboxPort,
    private readonly assistantTurnPersistence?: AssistantTurnPersistencePort,
  ) {}

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
  }): Promise<CompletedAssistantTurn> {
    const route = getChatTurnRoute(input.session);
    const skillTurnOutcome = toPresentationSkillTurnOutcome(input.presentation);
    const activitySummary = this.activitySummaryPresenter.present(input.session.retrieval.diagnostics, {
      execution: {
        surface: "assistant",
        path: route.type === "direct" ? "assistant_direct" : "assistant_retrieval",
        retrievalInvoked: route.type === "retrieval",
      },
    });
    const activityTrace = appendDirectiveSteeringStage(
      this.activityTracePresenter.appendAnswerOutcome({
        trace: input.session.retrieval.trace,
        summary: activitySummary,
        outcome: {
          answer: input.presentation.answer,
          stream: input.stream,
          hadContexts: input.session.retrieval.contexts.length > 0,
          retrievalSkipped: input.session.retrieval.diagnostics.retrievalSkipped,
          durationMs: Date.now() - input.answerStartedAt,
          answerOutcome: input.presentation.answerOutcome,
          skillName: skillTurnOutcome.skillName,
          skillOutcome: skillTurnOutcome.outcome,
          skillStatus: skillTurnOutcome.status,
        },
      }),
      input.session.directiveSteering,
    );
    const resolvedActivitySummary = activityTrace.summary ?? activitySummary;
    // The conversation spine is the root span; retrieval rides as a typed leaf on
    // its dispatch stage. Engine always runs the assistant turn, so engineTrace is
    // present — but stay defensive: no spine means no envelope this turn.
    const turnTrace = input.engineTrace
      ? buildTurnTraceEnvelope({
          spine: attachRetrievalActivityTrace(input.engineTrace, activityTrace),
        })
      : undefined;

    const assistantMessageId = randomUUID();
    const assistantMessageInput: MessageCreateInput = {
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
        retrievedChunks: input.session.retrieval.contexts.map((ctx, index) => ({
          chunkId: ctx.chunkId,
          documentId: ctx.documentId,
          title: ctx.title,
          rank: typeof ctx.promptPosition === "number" ? ctx.promptPosition : index,
          similarity: typeof ctx.similarity === "number" ? ctx.similarity : undefined,
        })),
        composedInstructions: input.session.retrieval.systemPrompt,
        // Best-effort: agent-level chat model override is what we know at
        // this layer. The workspace default chat model (when no override) is
        // not threaded through, so future snapshots from those turns will
        // have a null modelId — acceptable; the eval run record captures the
        // actual model resolved at run time.
        modelProvider: input.session.agent.chatModelOverride?.provider,
        modelId: input.session.agent.chatModelOverride?.model,
        citations: input.presentation.citations ?? [],
        answerSegments: input.presentation.answerSegments,
        // Raw model grounding verdict, retained for observability even when the
        // grounded-miss path reclassifies the skill outcome.
        groundingVerdict: input.presentation.grounding,
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
      diagnostics: input.session.retrieval.diagnostics,
      activityTrace,
      turnTrace,
      route,
      stream: input.stream,
    };

    let assistantMessage: MessageRecord;
    const successAuditEvent = this.buildAssistantTurnSuccessAuditEvent(successInput);
    if (this.assistantTurnPersistence) {
      assistantMessage = await this.assistantTurnPersistence.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.session.conversation.id,
        actions: input.actions,
        routineStateTransition: input.routineStateTransition,
        assistantMessage: assistantMessageInput,
        auditEvent: successAuditEvent,
      });
      this.auditService.logRecorded?.(successAuditEvent);
      await this.trackAssistantTurnCompleted(successInput);
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
      assistantMessage = await this.messageRepository.create(assistantMessageInput);
      await this.finalizeAssistantTurn(successInput);
    }

    return {
      assistantMessageId: assistantMessage.id,
      response: {
        conversationId: input.session.conversation.id,
        agentId: input.session.agent.id,
        agentName: input.session.agent.name,
        assistantMessageId: assistantMessage.id,
        route,
        answer: input.presentation.answer,
        citations: input.presentation.citations,
        answerSegments: input.presentation.answerSegments,
        suggestions: input.presentation.suggestions,
        activitySummary: resolvedActivitySummary,
        activityTrace,
        turnTrace,
      },
    };
  }

  async completeSkillIntakeTurn(input: {
    workspaceId: string;
    accountId?: string;
    session: PreparedSession;
    intakeResult: ChatIntakeResult;
    stream: boolean;
  }): Promise<ChatResponse> {
    const route: ChatRoute = {
      type: "direct",
      reason: "social_only",
    };
    const skillTurnOutcome = toIntakeSkillTurnOutcome(input.intakeResult);
    // Intake is a pre-engine short-circuit with no spine, so synthesize a minimal
    // one carrying its activity trace as a leaf — the renderer treats it like an
    // engine turn. (When intake later routes through the engine it produces a real
    // spine and this synthesis falls away; the envelope shape is unchanged.)
    const turnTrace = buildTurnTraceEnvelope({
      spine: synthesizeDispatchSpine({
        skillName: input.intakeResult.skillName,
        status: input.intakeResult.status === "failed" ? "failed" : "applied",
        startedAt: input.intakeResult.activityTrace.startedAt,
        completedAt: input.intakeResult.activityTrace.completedAt,
        subTrace: capabilitySubTrace(SKILL_INTAKE_TRACE_LEAF, input.intakeResult.activityTrace),
      }),
    });
    const assistantMessage = await this.messageRepository.create({
      conversationId: input.session.conversation.id,
      workspaceId: input.workspaceId,
      role: "assistant",
      content: input.intakeResult.answer,
      skillName: skillTurnOutcome.skillName,
      skillOutcome: skillTurnOutcome.outcome,
      skillStatus: skillTurnOutcome.status,
      metadata: {
        skillTurn: skillTurnOutcome,
        skillIntake: {
          skillName: input.intakeResult.skillName,
          status: input.intakeResult.status,
          skillOutcome: input.intakeResult.skillOutcome,
          stateId: input.intakeResult.stateId,
        },
        activityTrace: input.intakeResult.activityTrace,
      },
    });
    await this.finalizeAssistantTurn({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationId: input.session.conversation.id,
      userMessageId: input.session.userMessage.id,
      assistantMessageId: assistantMessage.id,
      skillTurnOutcome,
      answerOutcome: ASSISTANT_TURN_OUTCOME.NON_RETRIEVAL_RESPONSE,
      citations: [],
      answerSegments: undefined,
      suggestions: undefined,
      priorRewriteContinuityState: input.session.priorRewriteContinuityState,
      diagnostics: input.session.retrieval.diagnostics,
      activityTrace: input.intakeResult.activityTrace,
      turnTrace,
      route,
      stream: input.stream,
      skillIntake: {
        skillName: input.intakeResult.skillName,
        status: input.intakeResult.status,
        skillOutcome: input.intakeResult.skillOutcome,
        stateId: input.intakeResult.stateId,
      },
    });

    return {
      conversationId: input.session.conversation.id,
      agentId: input.session.agent.id,
      agentName: input.session.agent.name,
      assistantMessageId: assistantMessage.id,
      route,
      answer: input.intakeResult.answer,
      citations: [],
      answerSegments: undefined,
      suggestions: undefined,
      activitySummary: input.intakeResult.activitySummary,
      activityTrace: input.intakeResult.activityTrace,
      turnTrace,
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
        skillIntake: input.skillIntake,
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

  private async finalizeAssistantTurn(input: AssistantTurnSuccessInput): Promise<void> {
    await this.conversationRepository.touch(input.conversationId, input.workspaceId);
    await this.auditService.record(this.buildAssistantTurnSuccessAuditEvent(input));
    await this.trackAssistantTurnCompleted(input);
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
