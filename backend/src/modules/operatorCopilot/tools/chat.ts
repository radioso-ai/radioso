import { z } from "zod";

import type { CallerKind } from "../../../shared/domain/conversationSource.js";
import {
  CONVERSATION_ACTIVITY_KINDS,
  FEEDBACK_ACTIVITY_PERMISSION,
  type ConversationActivityEntry,
  type ConversationActivityReadScope,
} from "../../conversationActivity/contracts/index.js";
import { hasCurrentCopilotPermissions } from "../authorization.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload, truncationRecordSchema } from "../payloadCompaction.js";
import { boundConversationPayload, boundTurnTracePayload, jsonValueSchema, turnTraceEnvelopeSchema } from "./chatPayloadBounds.js";
import { asRecord, entity, requiredPageConversation } from "./shared.js";

const idSchema = z.string().uuid();
const unknownRecord = z.record(z.unknown());
const shallowRouteSchema = z.object({
  generator: z.string(),
  routeType: z.enum(["direct", "retrieval"]),
  routeReason: z.string(),
  retrievalInvoked: z.boolean(),
}).nullable();
const turnFailureSchema = z.object({
  eventStatus: z.enum(["failure", "cancelled"]),
  recordedAt: z.string(),
  stream: z.boolean(),
  stage: z.string().optional(),
  errorMessage: z.string().nullable().optional(),
}).nullable();
const ownershipSchema = z.object({
  conversationId: z.string().uuid(),
  state: z.literal("human_owned"),
  ownerDisplayName: z.string().nullable(),
  reason: z.string().nullable(),
  takenOverAt: z.string().nullable(),
}).nullable();
const transcriptMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  source: z.string(),
  content: z.string(),
  createdAt: z.string(),
  answerOutcome: z.string().nullable(),
  route: shallowRouteSchema,
  skill: z.object({ name: z.string(), outcome: z.string(), status: z.string() }).nullable(),
  citationCount: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative().nullable(),
  answerFeedback: z.array(jsonValueSchema),
  operatorDisplayName: z.string().nullable(),
  operatorLabel: z.string().nullable(),
  turnFailure: turnFailureSchema,
});
const activityPersonSchema = z.object({ userId: z.string().uuid(), label: z.string().nullable() }).nullable();
const transcriptActivitySchema = z.object({
  kind: z.enum(CONVERSATION_ACTIVITY_KINDS),
  createdAt: z.string(),
  /** Null when the agent acted, or a caller that is no teammate. */
  actor: activityPersonSchema,
  subject: activityPersonSchema,
  from: activityPersonSchema,
  handoffReason: z.string().nullable(),
  decision: z.object({ optionId: z.string(), label: z.string() }).nullable(),
  resolution: z.string().nullable(),
  assistantMessageId: z.string().uuid().nullable(),
});
const conversationTranscriptOutputSchema = z.object({
  transcript: z.object({
    conversationId: z.string().uuid(),
    agentId: z.string().uuid().nullable(),
    agentName: z.string().nullable(),
    sourceChannel: z.string().nullable(),
    callerKind: z.enum(["human", "agent"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    messageCount: z.number().int().nonnegative(),
    ownership: ownershipSchema,
    messages: z.array(transcriptMessageSchema),
    activity: z.array(transcriptActivitySchema),
  }).and(z.object({ truncation: truncationRecordSchema })),
});
const turnTraceOutputSchema = z.object({
  trace: z.object({
    conversationId: z.string().uuid(),
    ownership: ownershipSchema,
    message: z.object({
      id: z.string().uuid(),
      role: z.enum(["user", "assistant", "system"]),
      source: z.string(),
      content: z.string(),
      createdAt: z.string(),
      citations: z.array(jsonValueSchema),
      answerFeedback: z.array(jsonValueSchema),
      operatorDisplayName: z.string().nullable(),
      operatorLabel: z.string().nullable(),
      turnFailure: turnFailureSchema,
      debug: z.object({
        eventStatus: z.enum(["success", "failure", "cancelled"]),
        recordedAt: z.string(),
        stream: z.boolean(),
        citationCount: z.number().int().nonnegative(),
        answerOutcome: z.string().nullable(),
        skill: z.object({ name: z.string(), outcome: z.string(), status: z.string() }).nullable(),
        route: shallowRouteSchema,
        activitySummary: jsonValueSchema.nullable(),
        activityTrace: jsonValueSchema.nullable(),
        turnTrace: turnTraceEnvelopeSchema.nullable(),
        errorMessage: z.string().nullable(),
      }).nullable(),
    }),
  }).and(z.object({ truncation: truncationRecordSchema })),
});


/**
 * Narrow ports over other modules' public services. The copilot owns these
 * consumer-shaped contracts so it never imports another module's internals.
 */
export interface CopilotConversationHistoryPort {
  getConversation(workspaceId: string, conversationId: string, options: { limit: number }, debug: CopilotConversationOptions): Promise<CopilotConversationDetail>;
  getConversationTurn(workspaceId: string, messageId: string, options: CopilotConversationOptions): Promise<CopilotConversationTurnDetail>;
  listConversations(workspaceId: string, options: CopilotConversationListOptions): Promise<{ conversations: ReadonlyArray<CopilotConversationSummary>; total: number }>;
}

export interface CopilotConversationListOptions {
  limit: number;
  /** Narrows to conversations a person currently owns — the workspace's waiting handoffs. */
  ownership?: "human_owned";
}

/** Ownership is present only while a person owns the conversation; absent reads as AI-owned. */
export interface CopilotConversationOwnershipSummary {
  readonly state: string;
  /** The teammate holding the conversation; a human-owned conversation is claimed exactly when this is set. */
  readonly ownerUserId: string | null;
  readonly ownerDisplayName: string | null;
  readonly reason: string | null;
  /** Set once an operator takes the conversation over; null while it waits unassigned. */
  readonly takenOverAt: string | null;
  /** When ownership last changed — the clock a waiting handoff is measured against. */
  readonly updatedAt: string;
}

export interface CopilotConversationSummary {
  readonly id: string;
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly preview: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ownership?: CopilotConversationOwnershipSummary;
}

interface CopilotConversationOptions {
  includeAnswerFeedback: boolean;
  includeOwnership: boolean;
  includeTurnFailureDebug: boolean;
  includeLatency: boolean;
  /** Names the teammate behind each human reply, by teammate label (can be an email). */
  includeOperatorLabel: boolean;
  /**
   * The conversation's activity — handoffs, claims, reassignments, hand-backs, decisions, feedback
   * closed — with the kinds the operator may see. Absent reads none.
   */
  activity?: ConversationActivityReadScope;
}

interface CopilotOwnership {
  conversationId: string;
  state: "human_owned" | "ai_owned";
  ownerDisplayName: string | null;
  reason: string | null;
  takenOverAt: string | null;
}

interface CopilotTurnFailure {
  eventStatus: "failure" | "cancelled";
  recordedAt: string;
  stream: boolean;
  stage?: string;
  errorMessage?: string | null;
}

interface CopilotDebug {
  eventStatus: "success" | "failure" | "cancelled";
  recordedAt: string;
  stream: boolean;
  citationCount: number;
  answerOutcome?: string;
  skillName?: string;
  skillOutcome?: string;
  skillStatus?: string;
  activitySummary?: unknown;
  activityTrace?: unknown;
  turnTrace?: unknown;
  errorMessage?: string | null;
  route?: { generator: string; routeType: "direct" | "retrieval"; routeReason: string; retrievalInvoked: boolean };
}

interface CopilotConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  source: string;
  content: string;
  createdAt: string;
  citations?: ReadonlyArray<unknown>;
  answerFeedbackEntries?: ReadonlyArray<unknown>;
  latencyMs?: number;
  /** The signature the visitor saw on a human reply. */
  operatorDisplayName?: string;
  /** The teammate who wrote a human reply, as teammates name each other. */
  operatorLabel?: string;
  turnFailure?: CopilotTurnFailure;
  debug?: CopilotDebug;
}

interface CopilotConversationDetail {
  conversationId: string;
  agentId: string | null;
  agentName: string | null;
  sourceChannel: string | null;
  callerKind: CallerKind;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  ownership?: CopilotOwnership;
  messages: ReadonlyArray<CopilotConversationMessage>;
  activity?: ReadonlyArray<ConversationActivityEntry>;
}

interface CopilotConversationTurnDetail {
  conversationId: string;
  ownership?: CopilotOwnership;
  message: CopilotConversationMessage;
}

const projectOwnership = (ownership: CopilotOwnership | undefined) => ownership
  && ownership.state === "human_owned"
  ? {
      conversationId: ownership.conversationId,
      state: ownership.state,
      ownerDisplayName: ownership.ownerDisplayName,
      reason: ownership.reason,
      takenOverAt: ownership.takenOverAt,
    }
  : null;

const projectTurnFailure = (turnFailure: CopilotTurnFailure | undefined) => turnFailure
  ? {
      eventStatus: turnFailure.eventStatus,
      recordedAt: turnFailure.recordedAt,
      stream: turnFailure.stream,
      ...(turnFailure.stage ? { stage: turnFailure.stage } : {}),
      ...(turnFailure.errorMessage !== undefined ? { errorMessage: turnFailure.errorMessage } : {}),
    }
  : null;

const projectSkill = (debug: CopilotDebug | undefined) =>
  debug?.skillName && debug.skillOutcome && debug.skillStatus
    ? { name: debug.skillName, outcome: debug.skillOutcome, status: debug.skillStatus }
    : null;

const projectTranscript = (conversation: CopilotConversationDetail): Record<string, unknown> => ({
  conversationId: conversation.conversationId,
  agentId: conversation.agentId,
  agentName: conversation.agentName,
  sourceChannel: conversation.sourceChannel,
  callerKind: conversation.callerKind,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  messageCount: conversation.messageCount,
  ownership: projectOwnership(conversation.ownership),
  messages: conversation.messages.map((message) => ({
    id: message.id,
    role: message.role,
    source: message.source,
    content: message.content,
    createdAt: message.createdAt,
    answerOutcome: message.debug?.answerOutcome ?? null,
    route: message.debug?.route ?? null,
    skill: projectSkill(message.debug),
    citationCount: message.debug?.citationCount ?? message.citations?.length ?? 0,
    latencyMs: message.latencyMs ?? null,
    answerFeedback: [...(message.answerFeedbackEntries ?? [])],
    operatorDisplayName: message.operatorDisplayName ?? null,
    operatorLabel: message.operatorLabel ?? null,
    turnFailure: projectTurnFailure(message.turnFailure),
  })),
  activity: (conversation.activity ?? []).map((entry) => ({
    kind: entry.kind,
    createdAt: entry.createdAt,
    actor: entry.actor,
    subject: entry.subject,
    from: entry.from,
    handoffReason: entry.handoffReason,
    decision: entry.decision,
    resolution: entry.resolution,
    assistantMessageId: entry.assistantMessageId,
  })),
});

/**
 * Whether the spine already carries this turn's `activityTrace` as one of its capability leaves.
 *
 * `activityTrace` is the pre-spine field for a capability's own trace, and the spine hangs that
 * same trace off the stage that dispatched it — including for legacy turns, whose envelope is
 * synthesized by wrapping `activityTrace` as the sub-trace of a synthetic dispatch stage. Sending
 * both charges a diagnostic read twice for one trace.
 *
 * Matched on `traceId` rather than by comparing the two payloads, because a trace is large and the
 * identifier is what makes it the same run. An unrecognisable shape simply does not match, so the
 * field is kept.
 */
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const subTraceTraceId = (stage: unknown): unknown =>
  record(record(record(stage)?.subTrace)?.payload)?.traceId;

const spineCarriesActivityTrace = (turnTrace: unknown, activityTrace: unknown): boolean => {
  const traceId = record(activityTrace)?.traceId;
  if (typeof traceId !== "string") return false;
  const stages = record(record(turnTrace)?.spine)?.stages;
  return Array.isArray(stages) && stages.some((stage) => subTraceTraceId(stage) === traceId);
};

const projectTurnTrace = (detail: CopilotConversationTurnDetail): Record<string, unknown> => {
  const { message } = detail;
  const debug = message.debug;
  return {
    conversationId: detail.conversationId,
    ownership: projectOwnership(detail.ownership),
    message: {
      id: message.id,
      role: message.role,
      source: message.source,
      content: message.content,
      createdAt: message.createdAt,
      citations: [...(message.citations ?? [])],
      answerFeedback: [...(message.answerFeedbackEntries ?? [])],
      operatorDisplayName: message.operatorDisplayName ?? null,
      operatorLabel: message.operatorLabel ?? null,
      turnFailure: projectTurnFailure(message.turnFailure),
      debug: debug
        ? {
            eventStatus: debug.eventStatus,
            recordedAt: debug.recordedAt,
            stream: debug.stream,
            citationCount: debug.citationCount,
            answerOutcome: debug.answerOutcome ?? null,
            skill: projectSkill(debug),
            route: debug.route ?? null,
            activitySummary: debug.activitySummary ?? null,
            activityTrace: spineCarriesActivityTrace(debug.turnTrace, debug.activityTrace)
              ? null
              : debug.activityTrace ?? null,
            turnTrace: debug.turnTrace ?? null,
            errorMessage: debug.errorMessage ?? null,
          }
        : null,
    },
  };
};


// Test Chat sessions are private test executions rather than conversations, so these two readers
// never see them; naming the Test Chat readers keeps a "why didn't it fire in Test Chat" question
// from searching customer history.
const CONVERSATION_TRANSCRIPT_DESCRIPTION = "Read a bounded transcript of a customer or dashboard chat conversation with shallow per-turn outcomes, routing, feedback, and ownership, plus its latest activity: who handed it off, took it, reassigned it, and handed it back, which approval option a teammate chose, and — for an operator with Quality access — who resolved or dismissed its feedback. Use turn_trace for one turn's full diagnostic spine. Test Chat sessions are read with test_chat_transcript.";
const CONVERSATION_HISTORY_SEARCH_DESCRIPTION = "List recent customer and dashboard chat conversations in this workspace for investigation. Test Chat sessions are listed with test_chat_sessions.";
const TURN_TRACE_DESCRIPTION = "Inspect one message's full turn diagnostic spine. Accepts user messages, including unanswered turns with their failure or cancellation reason. A routine's sub-trace reports which slots were filled by key only (filledSlotKeys, capturedSlotKeys) — never their values — and, per step the selector judged, its selection: outcome and the slot keys the model returned (returnedSlotKeys). Use test_chat_turn_trace to see values, on a private Test Chat run only.";

export interface ChatCopilotToolDependencies {
  readonly chatHistoryService: CopilotConversationHistoryPort;
}

export const createChatCopilotTools = (deps: ChatCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "conversation_transcript", shape: "read", verificationCost: () => 0, uiLabel: "Reading conversation transcript", contributingModule: "chat", dashboardSubject: { type: "conversation" }, requiredPermissions: ["workspace.history.read"],
    description: CONVERSATION_TRANSCRIPT_DESCRIPTION,
    inputSchema: z.object({ conversationId: idSchema.optional() }), outputSchema: conversationTranscriptOutputSchema,
    createTool: (context) => ({
      name: "conversation_transcript",
      description: CONVERSATION_TRANSCRIPT_DESCRIPTION,
      inputSchema: z.object({ conversationId: idSchema.optional() }),
      outputSchema: conversationTranscriptOutputSchema,
      invoke: async ({ conversationId }) => ({
        transcript: boundConversationPayload(projectTranscript(await deps.chatHistoryService.getConversation(
          context.workspaceId,
          conversationId ?? requiredPageConversation(context.pageContext.conversationId),
          { limit: 100 },
          {
            includeAnswerFeedback: true,
            includeOwnership: true,
            includeTurnFailureDebug: true,
            includeLatency: true,
            includeOperatorLabel: true,
            // Feedback triage outcomes are Quality data: Ray reads them only for an operator who may.
            activity: {
              includeFeedback: await hasCurrentCopilotPermissions(context, [FEEDBACK_ACTIVITY_PERMISSION]),
            },
          },
        ))),
      }),
    }),
    describeEntity: ({ conversationId }, context) => entity("conversation", conversationId ?? context?.pageContext.conversationId),
  },
  {
    name: "turn_trace", shape: "read", verificationCost: () => 0, uiLabel: "Reading turn trace", contributingModule: "chat", dashboardSubject: { type: "conversation" }, requiredPermissions: ["workspace.history.read"],
    description: TURN_TRACE_DESCRIPTION,
    inputSchema: z.object({ messageId: idSchema }), outputSchema: turnTraceOutputSchema,
    createTool: (context) => ({
      name: "turn_trace",
      description: TURN_TRACE_DESCRIPTION,
      inputSchema: z.object({ messageId: idSchema }),
      outputSchema: turnTraceOutputSchema,
      invoke: async ({ messageId }) => ({
        trace: boundTurnTracePayload(projectTurnTrace(await deps.chatHistoryService.getConversationTurn(
          context.workspaceId,
          messageId,
          {
            includeAnswerFeedback: true,
            includeOwnership: true,
            includeTurnFailureDebug: true,
            includeLatency: true,
            includeOperatorLabel: true,
          },
        ))),
      }),
    }),
  },
  {
    name: "conversation_history_search", shape: "read", verificationCost: () => 0, uiLabel: "Searching conversations", contributingModule: "chat", dashboardSubject: { type: "conversation" }, requiredPermissions: ["workspace.history.read"],
    description: CONVERSATION_HISTORY_SEARCH_DESCRIPTION,
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ conversations: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "conversation_history_search", description: CONVERSATION_HISTORY_SEARCH_DESCRIPTION, inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ conversations: z.array(unknownRecord) }), invoke: async ({ limit }) => ({ conversations: boundPayload({ conversations: (await deps.chatHistoryService.listConversations(context.workspaceId, { limit: limit ?? 20 })).conversations.map(asRecord) }).conversations }) }),
  },

];
