import { createHash, randomUUID } from "node:crypto";

import type { ConversationTrace, ReplyDraft, RoutineActionRequest } from "@radioso/conversation-contract";
import {
  createNoopWorkspaceInvalidationPublisher,
  createPostCommitInvalidationReceipt,
  flushPostCommitInvalidationReceipt,
  type PostCommitInvalidationReceipt,
  type WorkspaceInvalidationKind,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";
import type { AuditEventInput, AuditService } from "../../audit/contracts/index.js";
import { DefaultAllowCapabilityPolicy, type CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../../shared/domain/actionCapabilities.js";
import { isReportableFault } from "../../../shared/domain/errors.js";
import type { ErrorReporter } from "../../../shared/errors/errorReporter.js";
import type { LlmProviderFailureClassification } from "../../../shared/infra/llm/llmProviderFailureClassification.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageCreateInput, MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { PendingDecisionCreateInput } from "../../../db/repositories/pendingDecisionRepository.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { groundingDiagnosticFromSummary } from "./groundingDiagnostic.js";
import type { ChatTurnSupersededError } from "./conversationTurnRegistry.js";
import type { DeliveredReplyPart, DeliveredReplyReader } from "../contracts/interruption.js";
import { cutReplyContent, cutReplyMessage } from "./cutReplyMessage.js";
import type {
  ConversationOwnershipReason,
  ConversationOwnershipRequestHandoffInput,
  ConversationOwnershipRequestHandoffResult,
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
import type { ChatResponse, ChatRoute, ChatSuggestion, ChatTurnHandoff, ChatTurnHandoffReason } from "../types/chatResponses.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { appendDirectiveSteeringStage } from "./directiveTracePresenter.js";
import { presentedSkillTurnOutcome } from "./presentedSkillTurn.js";
import { appendConversationSummaryStage } from "./conversationSummaryTracePresenter.js";
import {
  attachCapabilitySubTrace,
  attachContextVariablesToGather,
  attachPreparationTimingsToGather,
  buildPageReadTraceDiagnostic,
  buildTurnTraceEnvelope,
  type TurnTraceEnvelope,
} from "./turnTraceEnvelope.js";
import {
  RETRIEVAL_TRACE_LEAF,
  capabilitySubTrace,
} from "./chatTraceLeaves.js";
import type { CapturedRoutineTransition } from "./routines/deferredRoutineStore.js";
import type { ChatRoutineTurnReporter, ChatRoutineTurnState } from "../contracts/routineTurnState.js";
import type { ChatAnswerCoverageAssessment } from "../contracts/answerCoverage.js";
import type { CapturedClarificationTransition } from "./clarification/deferredClarificationStore.js";
import { conversationSummaryRefreshRequest } from "./summary/conversationSummaryRefreshJob.js";
import type { BackgroundJobQueue, BackgroundJobRequest } from "../../../shared/background-jobs/index.js";
import type { ModelCallTraceCollector } from "../../../shared/observability/tracing/modelCallTraceContext.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import {
  turnExecutionCapabilities,
  type AnswerTurnExecutionMode,
  type TurnExecutionMode,
} from "../../../shared/domain/turnExecutionMode.js";
import type { SuppressedSkillEffect } from "../../../shared/domain/suppressedSkillEffect.js";
import { sensitiveSlotKeysOf, sensitiveTurnMetadata } from "../../../shared/domain/sensitiveTranscript.js";
import {
  directiveAdherenceMetadataOf,
  UNMET_DIRECTIVES_METADATA_KEY,
  unmetDirectiveNames,
} from "../../../shared/domain/directiveAdherence.js";
import type { ReviewTurnFactsSource } from "../types/chatReview.js";
import { CONTACT_SEND_ACTION_TYPE } from "./routines/contactRoutine.js";
import {
  reviewedTurnDraft,
  reviewTurnFacts,
  type ReviewTurnCorrelation,
} from "./reviewDraft.js";
import { reviewedTurnAuditEvent, reviewTurnFailureAuditEvent } from "./reviewTurnAudit.js";
import type {
  PageReadCandidateSource,
  PageReadDecision,
  PageReadGateOutcome,
} from "./pageRead/pageReadDecision.js";
import { freezePageReadOutcome } from "./pageRead/pageReadSessionOutcome.js";

const DISPATCH_STAGE_ID_PREFIX = "dispatch:";

/**
 * Hang the retrieval activity trace on the spine's last dispatch stage: the skill whose outcome
 * was rendered, which is the fallback when a bound skill did not answer. Found by kind, so it
 * is robust to the presentation skill name being reclassified (grounded-miss).
 */
const attachRetrievalActivityTrace = (
  spine: ConversationTrace,
  activityTrace: ActivityTrace,
): ConversationTrace => {
  const dispatchStage = spine.stages.filter((stage) => stage.kind === "skill_dispatch").at(-1);
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

const getChatTurnRoute = (session: PreparedSession, engineTrace?: ConversationTrace): ChatRoute => {
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

/** A turn whose reply was persisted. `live` and `safe_test` turns always complete this way. */
interface PersistedAssistantTurn {
  kind: "persisted";
  response: ChatResponse;
  assistantMessageId: string;
  postCommitReceipt: PostCommitInvalidationReceipt;
  /**
   * Present when the turn wrote background jobs inside a caller's transaction: the caller calls it
   * once that transaction has committed, as it flushes `postCommitReceipt`. A turn that owns its
   * transaction has already woken the worker.
   */
  postCommitWake?: () => void;
}

/**
 * A `review` turn: its reply is returned as a draft and no message row is written, so
 * it correlates on the customer message it answered and the turn, never on an
 * assistant message id.
 */
interface DraftAssistantTurn {
  kind: "draft";
  draft: ReplyDraft;
  facts: ReviewTurnFactsSource;
  correlation: ReviewTurnCorrelation;
  postCommitReceipt: PostCommitInvalidationReceipt;
}

/** How a turn ended once completed; its execution mode's `completion` capability picks the arm. */
export type CompletedAssistantTurn = PersistedAssistantTurn | DraftAssistantTurn;

/**
 * A turn that returns its reply as a draft answers a customer's message with a reply nobody has
 * approved, so its audit records neither: only the review audit's fields (FR-045).
 */
const auditsWithoutContent = (executionMode: TurnExecutionMode | undefined): boolean =>
  turnExecutionCapabilities(executionMode).completion === "return_draft";

/** Labels a non-live turn's audit records with its execution mode and the surface that ran it. */
const executionModeAuditMetadata = (
  executionMode: TurnExecutionMode | undefined,
  surface: string | null | undefined,
): Record<string, unknown> | null =>
  executionMode === undefined || executionMode === "live"
    ? null
    : { executionMode, ...(surface ? { surface } : {}) };

export interface AssistantTurnCommittedFacts {
  insertedActionTypes: readonly string[];
  decisionCreated: boolean;
  ownershipChanged: boolean;
}

export interface AssistantTurnPersistenceReceipt {
  message: MessageRecord;
  committedFacts: AssistantTurnCommittedFacts;
  /** Wakes a worker for the background jobs the turn wrote; call it once the turn's transaction has committed. */
  wakeBackgroundJobs?: () => void;
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
    skillName?: string | null;
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
    /** Exact request whose provisional coverage assessment this reply commits. */
    answerCoverageRequestMessageId?: string;
    /**
     * The visitor message of a turn whose routine holds a sensitive slot value (#1543): marked with
     * those slots' keys in the turn's transaction, and any facet already extracted from it removed.
     */
    sensitiveVisitorMessage?: { id: string; sensitiveSlotKeys: readonly string[] };
    assistantMessage: MessageCreateInput;
    auditEvent: AuditEventInput;
    ownershipHandoff?: OwnershipHandoffInput | null;
    ownershipAuditEvent?: AuditEventInput | null;
    additionalAuditEvent?: AuditEventInput | null;
    /** Background jobs the turn hands to the worker, written in the turn's own transaction. */
    backgroundJobs?: readonly BackgroundJobRequest[];
    transaction?: Db;
    /** Runs as the transaction's last step; a throw rolls the whole turn back. */
    commitFence?: () => void;
  }): Promise<AssistantTurnPersistenceReceipt>;
  /**
   * Deletes the user message of a turn a newer input replaced and records `auditEvent`, its
   * cancelled `chat.answer` event, in one transaction. Resolves false, recording nothing, when the
   * conversation holds no such user message.
   */
  discardReplacedUserMessage?(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    auditEvent: AuditEventInput;
  }): Promise<boolean>;
}

/** The heard part of a reply a newer input cut off mid-stream, and the records of the cut. */
export interface CutReplyStoreInput {
  workspaceId: string;
  conversationId: string;
  /** Already marked cut short. */
  assistantMessage: MessageCreateInput & { id: string };
  /** The turn's cancelled `chat.answer` event naming the message, then the channel's own record of the cut. */
  auditEvents: readonly AuditEventInput[];
}

/**
 * Where the heard part of a cut-off reply is kept: the message, the conversation's touch and the
 * audit events in one transaction, so the part is never stored without its records.
 */
export interface CutReplyStore {
  storeCutReply(input: CutReplyStoreInput): Promise<void>;
}

interface PendingDecisionWriterPort {
  create(input: PendingDecisionCreateInput): Promise<unknown>;
}

interface ConversationOwnershipWriterPort {
  requestHandoff(input: ConversationOwnershipRequestHandoffInput): Promise<ConversationOwnershipRequestHandoffResult>;
}

export interface OwnershipHandoffInput {
  reason: ConversationOwnershipReason;
  routineId?: string;
  stepId?: string;
}

/** The hand-off a turn applies, by one of the reasons a turn can raise. */
export interface TurnHandoffInput extends OwnershipHandoffInput {
  reason: ChatTurnHandoffReason;
  /** How many of the ending routine's declared slots held a value; the reply reports it, nothing stores it. */
  collectedSlotCount?: number;
}

/** The hand-off as it is stored: the reply-only slot count does not cross the persistence port. */
const storedHandoff = (handoff: TurnHandoffInput | null | undefined): OwnershipHandoffInput | null | undefined =>
  handoff ? { reason: handoff.reason, routineId: handoff.routineId, stepId: handoff.stepId } : handoff;

/** What the reply tells its delivering channel about the hand-off the turn applied. */
const turnHandoffReport = (handoff: TurnHandoffInput): ChatTurnHandoff => ({
  reason: handoff.reason,
  collectedSlotCount: handoff.collectedSlotCount ?? 0,
});

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

interface BuildTurnTraceForPresentationInput {
  workspaceId: string;
  accountId?: string;
  session: PreparedSession;
  presentation: ChatPresentedAnswer;
  requestReceivedAt: number;
  answerStartedAt: number;
  stream: boolean;
  engineTrace?: ConversationTrace;
  modelCallTrace?: ModelCallTraceCollector;
}

interface TurnTracePresentation {
  route: ChatRoute;
  skillTurnOutcome: SkillTurnOutcome;
  activityTrace: ActivityTrace;
  turnTrace?: TurnTraceEnvelope;
  resolvedActivitySummary: NonNullable<ActivityTrace["summary"]>;
  assistantMessage: MessageCreateInput;
  successInput: AssistantTurnSuccessInput;
}

interface PersistedPageReadDecision {
  decision: PageReadDecision;
  winnerSource: PageReadCandidateSource | null;
  gateOutcome: PageReadGateOutcome["kind"];
}

const frozenPageReadDecisionFor = (
  session: PreparedSession,
): PersistedPageReadDecision | undefined => {
  if (session.pageReadCapability == null) {
    return undefined;
  }
  // A turn path that never consulted the gate must not lose the answered turn at
  // persistence time; the documented failure default is "not required".
  const outcome = session.pageReadOutcome ?? freezePageReadOutcome(session, {
    planner: null,
    routineCandidates: [],
    directiveCandidates: [],
    fallbackRequest: session.effectiveQuery,
  });
  return {
    decision: outcome.merged.decision,
    winnerSource: outcome.merged.contributors[0]?.source ?? null,
    gateOutcome: outcome.gate.kind,
  };
};

export const buildTurnTraceForPresentation = (
  input: BuildTurnTraceForPresentationInput,
): TurnTracePresentation => {
  const activitySummaryPresenter = new ActivitySummaryPresenter();
  const activityTracePresenter = new ActivityTracePresenter();
  const route = getChatTurnRoute(input.session, input.engineTrace);
  const skillTurnOutcome = presentedSkillTurnOutcome(input.presentation);
  const retrieval = input.presentation.effectiveRetrieval ?? input.session.retrieval;
  const execution = {
    surface: "assistant" as const,
    path: route.type === "direct" ? "assistant_direct" as const : "assistant_retrieval" as const,
    retrievalInvoked: route.type === "retrieval",
  };
  // One visitor-perceived duration, used for both the persisted
  // `messages.total_latency_ms` column and the trace's answer stage, so the quality
  // dashboard and debug trace cannot report different durations for a turn.
  const totalLatencyMs = Date.now() - input.requestReceivedAt;
  const generationLatencyMs = Date.now() - input.answerStartedAt;
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
          durationMs: totalLatencyMs,
          generationDurationMs: generationLatencyMs,
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
  const pageReadDecision = frozenPageReadDecisionFor(input.session);
  const pageReadDiagnostic = input.session.pageReadCapability != null && input.session.pageReadOutcome
    ? buildPageReadTraceDiagnostic({
        capability: input.session.pageReadCapability,
        outcome: input.session.pageReadOutcome,
        resolved: Object.hasOwn(contextVariablesSnapshot, "page_context"),
      })
    : undefined;
  const directiveFirings = input.session.directiveStateStore?.capturedFiringNames() ?? [];
  // The answer's own "this directive applied and I broke it" grades, by directive name:
  // Quality's unmet-directives signal reads this key (#1575).
  const unmetDirectives = unmetDirectiveNames(
    directiveAdherenceMetadataOf(input.presentation.metadata).directiveAdherence ?? [],
  );
  // The conversation spine is the root span; retrieval rides as a typed leaf on
  // its dispatch stage, while redacted host variables and the content-free page
  // diagnostic ride on gather. Engine always runs the assistant turn, so
  // engineTrace is present — but stay defensive: no spine means no envelope.
  const turnTrace = input.engineTrace
    ? buildTurnTraceEnvelope({
      spine: attachPreparationTimingsToGather(
        attachContextVariablesToGather(
          attachRetrievalActivityTrace(input.engineTrace, activityTrace),
          contextVariablesSnapshot,
          pageReadDiagnostic,
        ),
        input.session.preparationTimings,
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
    totalLatencyMs,
    grounding: groundingDiagnosticFromSummary(input.presentation.groundingSummary),
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
      ...(pageReadDecision ? { pageRead: pageReadDecision } : {}),
      groundingVerdict: input.presentation.grounding,
      groundingProtocolVersion: input.presentation.groundingSummary?.protocolVersion,
      groundingDiagnostics: input.presentation.groundingDiagnostics,
      ...(directiveFirings.length > 0 ? { directiveFirings } : {}),
      ...(unmetDirectives.length > 0 ? { [UNMET_DIRECTIVES_METADATA_KEY]: unmetDirectives } : {}),
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

/**
 * The heard part of a reply a newer input cut off after it started reaching the listener, as the
 * stored content and its spoken length; null when the turn is not that, keeps no reply (a draft),
 * or the channel reports nothing heard. The channel is asked at most once.
 */
const deliveredReplyPartOf = (
  input: { executionMode?: TurnExecutionMode; deliveredReply?: DeliveredReplyReader },
  supersededBy: ChatTurnSupersededError,
): (DeliveredReplyPart & { content: string }) | null => {
  if (!supersededBy.afterEmission || !input.deliveredReply || turnExecutionCapabilities(input.executionMode).completion !== "persist_reply") {
    return null;
  }
  const part = input.deliveredReply();
  const content = part ? cutReplyContent(part.text) : "";
  return part && content ? { ...part, content } : null;
};

/** No assessment ran for this request; the ids still anchor the verdict slot to the turn. */
const notRecordedAnswerCoverage = (requestMessageId: string): ChatAnswerCoverageAssessment => ({
  availability: "not_recorded",
  originatingTurnId: requestMessageId,
  originatingRequestId: requestMessageId,
});

/**
 * The routine this turn left, for the reply: the state it saved when it ran one;
 * otherwise the routine the turn named but could not advance — the completed one
 * a direct invocation was declined for, or the suspended one that kept the turn.
 */
const describeRoutineTurn = (input: {
  session: Pick<PreparedSession, "declinedRoutine" | "suspendedRoutine">;
  routineStateTransition?: CapturedRoutineTransition | null;
  routineReporter?: ChatRoutineTurnReporter;
  suspended?: boolean;
}): ChatRoutineTurnState | null =>
  input.routineReporter && input.routineStateTransition?.kind === "save"
    ? input.routineReporter.describe({
        state: input.routineStateTransition.state,
        awaitingDecision: input.suspended === true,
      })
    : input.session.declinedRoutine ?? input.session.suspendedRoutine ?? null;

/**
 * The sensitive slots (#1543) the routine this turn saved holds a value for, and those the step
 * the turn started on asks for (the visitor's message answers it, stored or not). Both messages
 * of such a turn are marked, so every copy of the transcript that leaves reads them as withheld.
 */
const sensitiveSlotKeysForTurn = (input: {
  routineStateTransition?: CapturedRoutineTransition | null;
  routineReporter?: ChatRoutineTurnReporter;
}): string[] => {
  const { routineReporter: reporter, routineStateTransition: transition } = input;
  if (!reporter || !transition) return [];
  const held = transition.kind === "save" ? reporter.sensitiveSlotKeysHeld(transition.state) : [];
  const awaited = transition.startedFrom ? reporter.sensitiveSlotKeysAwaited(transition.startedFrom) : [];
  return [...new Set([...held, ...awaited])];
};

const withSensitiveTurnMarker = (
  presentation: TurnTracePresentation,
  sensitiveSlotKeys: readonly string[],
): TurnTracePresentation =>
  sensitiveSlotKeys.length === 0
    ? presentation
    : {
        ...presentation,
        assistantMessage: {
          ...presentation.assistantMessage,
          metadata: { ...presentation.assistantMessage.metadata, ...sensitiveTurnMetadata(sensitiveSlotKeys) },
        },
      };

interface CompleteAssistantTurnInput {
  workspaceId: string;
  accountId?: string;
  session: PreparedSession;
  presentation: ChatPresentedAnswer;
  /** Time the turn entered ChatService, before any queueing or preparation work. */
  requestReceivedAt: number;
  /** Time answer generation began, after session preparation. */
  answerStartedAt: number;
  stream: boolean;
  /** Suppresses customer-facing effects while retaining the synthetic messages and trace. */
  executionMode?: TurnExecutionMode;
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
  /** Names and describes the routine state above for the reply envelope; absent when no routine ran. */
  routineReporter?: ChatRoutineTurnReporter;
  pendingDecisionTransition?: PendingDecisionCreateInput | null;
  ownershipHandoff?: TurnHandoffInput | null;
  suspended?: boolean;
  additionalAuditEvent?: AuditEventInput | null;
  transaction?: Db;
  commitClarificationState?: () => Promise<void>;
  clarificationTransition?: CapturedClarificationTransition | null;
  /** The skill effects the turn's execution mode suppressed; a draft reports them. */
  suppressedEffects?: readonly SuppressedSkillEffect[];
  /**
   * Decides, at the last moment the turn can still store nothing, whether it may commit; throwing
   * stores none of the reply or its effects. It runs as the persistence transaction's last step,
   * and on the fallback path before the first write.
   */
  commitFence?: () => void;
  /**
   * Told the reply's message id the moment the reply is stored, before any step after the store
   * that could still throw, so a caller handling that throw knows the turn has its reply.
   */
  onReplyStored?: (assistantMessageId: string) => void;
}

const ROUTINE_INVOCATIONS_TOTAL = "routine_invocations_total";

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
    // Optional: when wired, a turn that records bookkeeping hands the worker a
    // conversation summary refresh job (#866), written in the turn's own commit.
    private readonly backgroundJobs?: Pick<BackgroundJobQueue, "enqueue">,
    private readonly metrics?: Pick<MetricsRegistry, "incrementCounter"> | null,
    private readonly workspaceInvalidationPublisher: WorkspaceInvalidationPublisher =
      createNoopWorkspaceInvalidationPublisher(),
    // Optional: when wired, a reply a newer input cut off mid-stream keeps the part its listener
    // heard. Absent, such a turn stores no reply.
    private readonly cutReplyStore?: CutReplyStore,
    // Optional: when wired, a turn failure `isReportableFault` finds is reported once
    // through this narrow port. Absent leaves `recordFailure`'s audit/analytics behavior
    // unchanged — no error tracking, as before this existed.
    private readonly errorReporter?: Pick<ErrorReporter, "report">,
  ) {
    this.capabilityPolicy = capabilityPolicy ?? new DefaultAllowCapabilityPolicy();
  }

  /**
   * The fallback path's job write: it has no transaction to join, so each job is written once the
   * reply exists. Best-effort, because the reply already stands; the next turn writes a new job.
   */
  private async enqueueBackgroundJobs(jobs: readonly BackgroundJobRequest[], conversationId: string): Promise<void> {
    for (const job of jobs) {
      try {
        await this.backgroundJobs?.enqueue(job);
      } catch (error) {
        this.logger?.warn(
          {
            event: "background_job_enqueue_failed",
            conversationId,
            kind: job.kind,
            errorType: error instanceof Error ? error.name : typeof error,
          },
          "Failed to enqueue a background job for the turn",
        );
      }
    }
  }

  /** Enqueue routine-emitted fire-and-forget actions to the outbox (idempotent). */
  private async enqueueTurnActions(input: {
    actions: RoutineActionRequest[] | undefined;
    workspaceId: string;
    accountId?: string;
    conversationId: string;
  }): Promise<readonly string[]> {
    if (!this.actionOutbox || !input.actions?.length) {
      return [];
    }
    const insertedActionTypes: string[] = [];
    for (const action of input.actions) {
      const outcome = await this.actionOutbox.enqueue({
        type: action.type,
        payload: action.payload,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        idempotencyKey: actionIdempotencyKey(input.conversationId, action.type, action.payload),
        skillName: action.skillName ?? null,
      });
      if (!outcome.duplicate) {
        insertedActionTypes.push(action.type);
      }
    }
    return insertedActionTypes;
  }

  private createPostCommitReceipt(
    workspaceId: string,
    committedFacts: AssistantTurnCommittedFacts,
  ): PostCommitInvalidationReceipt {
    const changeKinds: WorkspaceInvalidationKind[] = ["conversation.turn_committed"];
    if (committedFacts.insertedActionTypes.includes(CONTACT_SEND_ACTION_TYPE)) {
      changeKinds.push("conversation.contact_delivery_changed");
    }
    if (committedFacts.decisionCreated) {
      changeKinds.push("hitl.decision_created");
    }
    if (committedFacts.ownershipChanged) {
      changeKinds.push("conversation.ownership_changed");
    }
    return createPostCommitInvalidationReceipt(workspaceId, changeKinds);
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

  /** A turn in a mode that persists its reply (`live`, `safe_test`, or no mode) always completes persisted. */
  async completeAssistantTurn(
    input: CompleteAssistantTurnInput & { executionMode?: AnswerTurnExecutionMode },
  ): Promise<PersistedAssistantTurn>;
  async completeAssistantTurn(input: CompleteAssistantTurnInput): Promise<CompletedAssistantTurn>;
  async completeAssistantTurn(input: CompleteAssistantTurnInput): Promise<CompletedAssistantTurn> {
    const capabilities = turnExecutionCapabilities(input.executionMode);
    // Safe-test turns retain conversation-local state (routine, decision and
    // clarification transitions) so follow-up turns remain representative; the
    // capabilities below drop only customer- and operator-facing effects.
    const actions = capabilities.turnActions === "enqueue" ? input.actions : undefined;
    const ownershipHandoff = capabilities.ownershipHandoff === "apply" ? input.ownershipHandoff : undefined;
    const recordsBookkeeping = capabilities.turnBookkeeping === "record";
    const additionalAuditEvent = recordsBookkeeping ? input.additionalAuditEvent : undefined;
    // The rolling conversation summary (#866) is regenerated in the worker, never on this turn's
    // path: the turn only writes the job, and the reply never waits on a model call for it.
    const backgroundJobs: readonly BackgroundJobRequest[] = this.backgroundJobs && recordsBookkeeping
      ? [conversationSummaryRefreshRequest({
          workspaceId: input.workspaceId,
          conversationId: input.session.conversation.id,
          accountId: input.accountId,
        })]
      : [];
    const routineTurnState = describeRoutineTurn(input);
    const invocationReport = input.session.routineInvocationReport ?? null;
    if (invocationReport) {
      // Every turn-time outcome is counted here, where the reply reports it, so a
      // call another routine kept from starting is counted like one that started.
      this.metrics?.incrementCounter(ROUTINE_INVOCATIONS_TOTAL, {
        help: "Routine tool invocations by outcome.",
        labels: { outcome: invocationReport.outcome },
      });
    }
    const sensitiveSlotKeys = sensitiveSlotKeysForTurn(input);
    const presentation = withSensitiveTurnMarker(buildTurnTraceForPresentation({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      session: input.session,
      presentation: input.presentation,
      requestReceivedAt: input.requestReceivedAt,
      answerStartedAt: input.answerStartedAt,
      stream: input.stream,
      engineTrace: input.engineTrace,
      modelCallTrace: input.modelCallTrace,
    }), sensitiveSlotKeys);
    let assistantMessage: MessageRecord;
    let postCommitReceipt: PostCommitInvalidationReceipt;
    let postCommitWake: (() => void) | undefined;
    const suspended = input.suspended === true;
    const baseAuditEvent = suspended
      ? this.buildAssistantTurnSuspendedAuditEvent(presentation.successInput)
      : this.buildAssistantTurnSuccessAuditEvent(presentation.successInput);
    const modeAuditMetadata = executionModeAuditMetadata(
      input.executionMode,
      input.session.conversation.sourceChannel,
    );
    const auditEvent = modeAuditMetadata
      ? { ...baseAuditEvent, metadata: { ...baseAuditEvent.metadata, ...modeAuditMetadata } }
      : baseAuditEvent;
    const ownershipAuditEvent = ownershipHandoff
      ? this.buildOwnershipHandoffAuditEvent({
          ...ownershipHandoff,
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
    if (capabilities.completion === "return_draft") {
      return this.returnDraft({
        workspaceId: input.workspaceId,
        session: input.session,
        answerOutcome: input.presentation.answerOutcome,
        turn: presentation,
        auditEvent,
        // Reported, never applied: whoever publishes the draft decides on the hand-off.
        ownershipHandoff: capabilities.ownershipHandoff === "report" ? input.ownershipHandoff : null,
        suppressedEffects: input.suppressedEffects,
      });
    }
    if (this.assistantTurnPersistence) {
      const persisted = await this.assistantTurnPersistence.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.session.conversation.id,
        actions,
        routineStateTransition: input.routineStateTransition,
        pendingDecisionTransition: input.pendingDecisionTransition,
        clarificationTransition: input.clarificationTransition,
        answerCoverageRequestMessageId: input.session.userMessage.id,
        ...(sensitiveSlotKeys.length > 0
          ? { sensitiveVisitorMessage: { id: input.session.userMessage.id, sensitiveSlotKeys } }
          : {}),
        assistantMessage: presentation.assistantMessage,
        auditEvent,
        ownershipHandoff: storedHandoff(ownershipHandoff),
        ownershipAuditEvent,
        additionalAuditEvent,
        backgroundJobs,
        transaction: input.transaction,
        commitFence: input.commitFence,
      });
      assistantMessage = persisted.message;
      input.onReplyStored?.(assistantMessage.id);
      postCommitReceipt = this.createPostCommitReceipt(input.workspaceId, persisted.committedFacts);
      if (!input.transaction) {
        flushPostCommitInvalidationReceipt(this.workspaceInvalidationPublisher, postCommitReceipt);
        persisted.wakeBackgroundJobs?.();
      } else {
        // The jobs are invisible until the caller's transaction commits; a wake now would find nothing.
        postCommitWake = persisted.wakeBackgroundJobs;
      }
      this.auditService.logRecorded?.(auditEvent);
      if (!suspended && recordsBookkeeping) {
        await this.trackAssistantTurnCompleted(presentation.successInput);
      }
    } else {
      // Fallback for tests and non-DB hosts. Production wires a transaction port so
      // outbox enqueue, routine state, assistant message, touch, and audit commit together.
      // With no transaction to roll back, the fence runs before the first write.
      input.commitFence?.();
      const insertedActionTypes = await this.enqueueTurnActions({
        actions,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.session.conversation.id,
      });
      assistantMessage = await this.messageRepository.create(presentation.assistantMessage);
      input.onReplyStored?.(assistantMessage.id);
      // The fallback has no cross-store transaction. Advance a routine only after
      // its assistant reply exists; otherwise a message-write failure could skip a
      // recoverable routine step. The durable production path writes this state in
      // AssistantTurnPersistencePort's transaction.
      await input.commitRoutineState?.();
      let pendingDecisionCreated = false;
      if (input.pendingDecisionTransition && this.pendingDecisionRepository) {
        await this.pendingDecisionRepository.create(input.pendingDecisionTransition);
        pendingDecisionCreated = true;
      }
      // Records no `handoff_requested` activity: that event commits in the handoff's own transaction
      // (PostgresAssistantTurnPersistence), and this path holds none. Production composition always
      // wires that persistence — the runtime-startup test pins it — so a live handoff never lands here.
      const ownershipResult = ownershipHandoff && this.conversationOwnershipRepository
        ? await this.conversationOwnershipRepository.requestHandoff({
          conversationId: input.session.conversation.id,
          workspaceId: input.workspaceId,
          reason: ownershipHandoff.reason,
        })
        : null;
      await input.commitClarificationState?.();
      await this.conversationRepository.touch(presentation.successInput.conversationId, input.workspaceId);
      await this.enqueueBackgroundJobs(backgroundJobs, input.session.conversation.id);
      postCommitReceipt = this.createPostCommitReceipt(input.workspaceId, {
        insertedActionTypes,
        decisionCreated: pendingDecisionCreated,
        ownershipChanged: ownershipResult?.changed ?? false,
      });
      if (!input.transaction) {
        flushPostCommitInvalidationReceipt(this.workspaceInvalidationPublisher, postCommitReceipt);
      }
      await this.auditService.record(auditEvent);
      if (recordsBookkeeping && !suspended) {
        await this.trackAssistantTurnCompleted(presentation.successInput);
      }
      if (ownershipAuditEvent) {
        await this.auditService.record(ownershipAuditEvent);
      }
      if (additionalAuditEvent) {
        await this.auditService.record(additionalAuditEvent);
      }
    }

    this.recordPageReadGateOutcome(input.session);

    // Advance the conversation's directive firing memory (#865) once the reply is
    // durably persisted. Best-effort, off the answer path: a failure here only risks
    // a once/cooldown directive re-firing next turn, so it must never fail the turn.
    try {
      await input.session.directiveStateStore?.commit();
    } catch (error) {
      // The app logger's serializer keeps the error's class and code, never its message or
      // any other property (a provider response body among them).
      this.logger?.warn(
        {
          event: "directive_state_commit_failed",
          conversationId: input.session.conversation.id,
          err: error,
        },
        "Failed to persist directive firing state",
      );
    }

    return {
      kind: "persisted",
      assistantMessageId: assistantMessage.id,
      postCommitReceipt,
      ...(postCommitWake ? { postCommitWake } : {}),
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
        answerCoverage: input.session.answerCoverageDebug ?? notRecordedAnswerCoverage(input.session.userMessage.id),
        ...(input.session.answerCoverageInteractionTrace
          ? { interactionTrace: input.session.answerCoverageInteractionTrace }
          : {}),
        // A handoff this turn leaves the conversation human-owned; the reply itself
        // was still generated, so it is not suppressed. Safe-test turns never hand off.
        ...(ownershipHandoff
          ? { ownership: { state: "human_owned", suppressed: false }, handoff: turnHandoffReport(ownershipHandoff) }
          : {}),
        ...(routineTurnState ? { routine: routineTurnState } : {}),
        ...(invocationReport ? { invocation: invocationReport } : {}),
      },
    };
  }

  /**
   * Completes a `review` turn. The draft commits only the turn's audit event, keyed on the
   * request it answered; the coverage assessment the turn made is already saved against
   * that request, and there is no reply row to link it to. No conversation state the
   * published reply would depend on (routine, decision, clarification, directive firing
   * memory) advances, because nobody has published the reply. The directive firing memory
   * advance rides with the draft instead, for its unchanged publication to apply.
   */
  private async returnDraft(input: {
    workspaceId: string;
    session: PreparedSession;
    answerOutcome: AssistantTurnOutcome | undefined;
    turn: TurnTracePresentation;
    auditEvent: AuditEventInput;
    ownershipHandoff: OwnershipHandoffInput | null | undefined;
    suppressedEffects: readonly SuppressedSkillEffect[] | undefined;
  }): Promise<DraftAssistantTurn> {
    const correlation: ReviewTurnCorrelation = {
      requestMessageId: input.session.userMessage.id,
      // The id the reply row would have carried. A draft writes no row, so it names the turn.
      turnId: input.turn.successInput.assistantMessageId,
    };
    await this.auditService.record(reviewedTurnAuditEvent(input.auditEvent, correlation));
    this.recordPageReadGateOutcome(input.session);
    return {
      kind: "draft",
      draft: reviewedTurnDraft(
        input.turn.assistantMessage,
        input.session.directiveStateStore?.deferredTransition() ?? null,
      ),
      facts: reviewTurnFacts({
        answerOutcome: input.answerOutcome ?? legacyAnswerOutcomeForSkillTurnOutcome(input.turn.skillTurnOutcome),
        answerCoverage: input.session.answerCoverageDebug,
        skillOutcome: input.turn.skillTurnOutcome.outcome,
        ownershipHandoff: input.ownershipHandoff,
        suppressedEffects: input.suppressedEffects,
        citationCount: input.turn.successInput.citations.length,
      }),
      correlation,
      // Nothing an operator surface shows has changed; whoever holds the draft publishes its own change.
      postCommitReceipt: createPostCommitInvalidationReceipt(input.workspaceId, []),
    };
  }

  private recordPageReadGateOutcome(session: PreparedSession): void {
    if (session.pageReadCapability != null && session.pageReadOutcome) {
      this.metrics?.incrementCounter("chat_page_read_gate_outcomes_total", {
        help: "Page-read gate outcomes by result and selected operation.",
        labels: {
          outcome: session.pageReadOutcome.gate.kind,
          operation: session.pageReadOutcome.merged.decision.operation ?? "none",
        },
      });
    }
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
      executionMode?: TurnExecutionMode;
    },
    session: PreparedSession | null,
    existingAssistantMessageId: string | undefined,
    error: unknown,
    workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn"),
    // The caller's classification of `error` against the LLM provider call it came from
    // (shared/infra/llm, computed before any AppError normalization). `null` when the
    // caller has none, or the failure never reached a provider call at all.
    providerFailure: LlmProviderFailureClassification | null = null,
  ) {
    if (session && existingAssistantMessageId) {
      await this.conversationRepository.touch(session.conversation.id, input.workspaceId);
    }

    const failureEvent: AuditEventInput = {
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
        ...executionModeAuditMetadata(input.executionMode, session?.conversation.sourceChannel),
      },
    };
    const failureAuditEvent = auditsWithoutContent(input.executionMode)
      ? reviewTurnFailureAuditEvent(failureEvent, error)
      : failureEvent;
    const failedConversationId = session?.conversation.id ?? input.conversationId;
    if (failedConversationId) {
      // Keyed to the conversation so a turn failing while its conversation is mid-erasure
      // never leaves a row the erasure's own audit cleanup already ran past.
      await this.auditService.recordForLiveConversation(failureAuditEvent, {
        workspaceId: input.workspaceId,
        conversationId: failedConversationId,
      });
    } else {
      // No conversation to key the liveness check on (the turn failed before one existed), so
      // there is nothing an erasure could have raced.
      await this.auditService.record(failureAuditEvent);
    }
    if (turnExecutionCapabilities(input.executionMode).turnBookkeeping === "skip") {
      // A safe_test/review turn is a preview, not a production incident: neither error
      // tracking nor analytics hears about it, same gate as below for the live case.
      return;
    }
    const providerFailureProperties = providerFailure
      ? { failureKind: providerFailure.kind, providerStatus: providerFailure.status, providerCode: providerFailure.code }
      : {};
    // Bounded and provider-agnostic, in place of the error's own message, when it is
    // classified: a provider's error text can echo the customer's rejected prompt back
    // (see shared/infra/llm/providerErrors.ts), so a classified failure's message never
    // leaves this process. An unclassified failure keeps its own message (the existing
    // behavior) — most such errors are this codebase's own, not provider echoes.
    const boundedErrorMessage = providerFailure ? `LLM provider call failed: ${providerFailure.kind}` : undefined;
    // `isReportableFault` draws the line, not a bare `AppError` check: a quota/validation
    // limit or a superseded turn (`ChatTurnSupersededError`, `< 500`) is an expected,
    // client-facing outcome, never a fault — but a `>= 500` AppError (a platform
    // misconfiguration, a rejected platform credential) still is one, unless its own
    // `isExpectedOutcome` marker says it is a lost client instead
    // (`ChatTurnDisconnectAbortError`). Anything reaching here as a fault gets reported
    // exactly once.
    if (isReportableFault(error)) {
      // Fire-and-forget, like every other error-reporter caller: a sink (PostHog, say)
      // has no fetch timeout, and awaiting it here would hold the turn's rethrow, its
      // SSE response end, and the next turn's `waitForPredecessor` lease hostage to a
      // stalled network call. The dedup this enables for the HTTP error handler's
      // `wasReported` check still holds without awaiting: `ErrorReportingService.report`
      // marks the WeakSet synchronously, before its own first await, so the mark has
      // already happened by the time this line finishes — not after the call settles.
      void this.errorReporter?.report({
        errorType: "chat.turn_failed",
        error,
        ...(boundedErrorMessage ? { message: boundedErrorMessage } : {}),
        metadata: {
          workspaceId: input.workspaceId,
          conversationId: failedConversationId,
          stage: "chat.answer",
          executionMode: input.executionMode ?? "live",
          ...providerFailureProperties,
        },
      }).catch(() => {
        // Error reporting is observational; it must not change failure behavior.
      });
    }
    try {
      await this.productAnalyticsService.track({
        eventName: "chat.failed",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        subjectType: "conversation",
        subjectId: failedConversationId,
        properties: {
          stream: input.stream,
          errorMessage: boundedErrorMessage ?? (error instanceof Error ? error.message : "Unknown error"),
          ...providerFailureProperties,
        },
        source: "backend",
      });
    } catch {
      // Analytics fan-out must not change failure behavior.
    }
  }

  /**
   * Records a turn a newer message superseded before it could answer. This is a normal
   * user interruption (the visitor kept typing), not an error, so it is recorded with
   * `eventStatus: "cancelled"` rather than `"failure"` — reusing "failure" here would let
   * Activity/health surfaces that read `eventStatus` count routine interruptions as
   * assistant errors. The user's message otherwise leaves no trace: no assistant message
   * is ever created for a turn superseded this early, so this event is the only record
   * that the turn happened at all, keyed to `userMessageId` for the read side to find.
   *
   * Kept deliberately lean next to `recordFailure`: a superseded turn never finished
   * enough of the pipeline to have a meaningful retrieval/activity trace to attach.
   *
   * A turn a newer input replaced before it emitted (both `latest_input_wins`) has its
   * user message deleted; this event still names it and adds `userMessageDiscarded`.
   * A turn a newer input cut off after its reply started reaching the listener keeps,
   * as its reply, the part the channel's `deliveredReply` says the listener got: this
   * event then names that message and adds `partialReplyStored`, and resolves its id.
   */
  async recordSupersession(
    input: {
      workspaceId: string;
      accountId?: string;
      conversationId?: string;
      stream: boolean;
      executionMode?: TurnExecutionMode;
      /** What reached the listener of a reply cut off mid-stream; absent: such a turn stores no reply. */
      deliveredReply?: DeliveredReplyReader;
    },
    session: PreparedSession | null,
    existingAssistantMessageId: string | undefined,
    supersededBy: ChatTurnSupersededError,
    workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn"),
  ): Promise<string | undefined> {
    if (session && existingAssistantMessageId) {
      await this.conversationRepository.touch(session.conversation.id, input.workspaceId);
    }
    const cancelledEvent = (outcome: { userMessageDiscarded?: boolean; cutReplyId?: string } = {}): AuditEventInput => ({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "chat.answer",
      eventStatus: "cancelled",
      metadata: {
        stage: "chat.answer",
        workflow: workflowPolicy.workflow,
        executionClass: workflowPolicy.executionClass,
        conversationId: session?.conversation.id ?? input.conversationId,
        userMessageId: session?.userMessage.id,
        ...(outcome.userMessageDiscarded ? { userMessageDiscarded: true } : {}),
        assistantMessageId: outcome.cutReplyId ?? existingAssistantMessageId,
        ...(outcome.cutReplyId ? { partialReplyStored: true } : {}),
        stream: input.stream,
        supersededStage: supersededBy.stage,
        ...executionModeAuditMetadata(input.executionMode, session?.conversation.sourceChannel),
      },
    });
    const heardPart = session && !existingAssistantMessageId && this.cutReplyStore ? deliveredReplyPartOf(input, supersededBy) : null;
    if (session && heardPart && this.cutReplyStore) {
      const cutReplyId = await this.storeCutReply(this.cutReplyStore, input, session, heardPart, (id) => cancelledEvent({ cutReplyId: id }));
      if (!cutReplyId) {
        await this.auditService.record(cancelledEvent());
      }
      return cutReplyId;
    }
    const replaced = supersededBy.replacedByNewerInput && !supersededBy.afterEmission && !existingAssistantMessageId;
    const discard = replaced && session
      ? await this.discardReplacedUserMessage(input, session, cancelledEvent({ userMessageDiscarded: true }))
      : { userMessageDiscarded: false, recorded: false };
    if (!discard.recorded) {
      await this.auditService.record(cancelledEvent({ userMessageDiscarded: discard.userMessageDiscarded }));
    }
    return undefined;
  }

  /**
   * Stores the heard part of a cut-off reply with its cancelled event and the channel's record of
   * the cut, in one transaction. A part that cannot be stored is logged and resolves undefined,
   * leaving the cancelled event to the caller, so the turn is still recorded. Once stored, the
   * workspace's live views learn of the new reply.
   */
  private async storeCutReply(
    store: CutReplyStore,
    input: { accountId?: string; workspaceId: string },
    session: PreparedSession,
    heardPart: DeliveredReplyPart & { content: string },
    cancelledEventFor: (cutReplyId: string) => AuditEventInput,
  ): Promise<string | undefined> {
    const conversationId = session.conversation.id;
    // The heard part can restate what the visitor's message held, so it carries that message's marker.
    const assistantMessage = cutReplyMessage({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      conversationId,
      ...heardPart,
      metadata: sensitiveTurnMetadata(sensitiveSlotKeysOf(session.userMessage.metadata)),
    });
    const auditEvents: AuditEventInput[] = [
      cancelledEventFor(assistantMessage.id),
      ...(heardPart.auditEvent
        ? [{
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            eventType: heardPart.auditEvent.eventType,
            eventStatus: "success" as const,
            metadata: { ...heardPart.auditEvent.metadata, conversationId, assistantMessageId: assistantMessage.id },
          }]
        : []),
    ];
    try {
      await store.storeCutReply({ workspaceId: input.workspaceId, conversationId, assistantMessage, auditEvents });
    } catch (error) {
      this.logger?.warn({
        workspaceId: input.workspaceId,
        conversationId,
        errorType: error instanceof Error ? error.name : typeof error,
      }, "The part of a cut-off reply could not be stored");
      return undefined;
    }
    for (const auditEvent of auditEvents) {
      this.auditService.logRecorded?.(auditEvent);
    }
    flushPostCommitInvalidationReceipt(
      this.workspaceInvalidationPublisher,
      createPostCommitInvalidationReceipt(input.workspaceId, ["conversation.turn_committed"]),
    );
    return assistantMessage.id;
  }

  /**
   * Deletes the user message of a turn a newer input replaced before it emitted anything; a
   * turn any other newer turn cancelled keeps it. Usage events the turn recorded keep its spend
   * with the message link cleared. Through the transactional persistence port the deletion and
   * `auditEvent` commit together, so the message never goes without the record that says so; the
   * fallback path (tests, non-DB hosts) deletes first and leaves the event to the caller. A failed
   * discard keeps the message.
   */
  private async discardReplacedUserMessage(
    input: { workspaceId: string },
    session: PreparedSession,
    auditEvent: AuditEventInput,
  ): Promise<{ userMessageDiscarded: boolean; recorded: boolean }> {
    const target = {
      workspaceId: input.workspaceId,
      conversationId: session.conversation.id,
      messageId: session.userMessage.id,
    };
    try {
      if (this.assistantTurnPersistence?.discardReplacedUserMessage) {
        const discarded = await this.assistantTurnPersistence.discardReplacedUserMessage({ ...target, auditEvent });
        if (discarded) {
          this.auditService.logRecorded?.(auditEvent);
        }
        return { userMessageDiscarded: discarded, recorded: discarded };
      }
      return { userMessageDiscarded: await this.messageRepository.deleteUserMessage(target), recorded: false };
    } catch (error) {
      this.logger?.warn({
        workspaceId: input.workspaceId,
        conversationId: session.conversation.id,
        errorType: error instanceof Error ? error.name : typeof error,
      }, "Superseded user message could not be discarded");
      return { userMessageDiscarded: false, recorded: false };
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
