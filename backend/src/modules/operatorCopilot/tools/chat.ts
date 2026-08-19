import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";
import { boundConversationPayload, boundTurnTracePayload } from "./chatPayloadBounds.js";
import { entity, requiredPageConversation } from "./shared.js";

const idSchema = z.string().uuid();
const unknownRecord = z.record(z.unknown());
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));
const truncationSchema = z.object({
  truncated: z.literal(true),
  entries: z.array(z.object({
    path: z.string(),
    reason: z.enum(["string_length", "array_length", "budget_omitted"]),
    originalLength: z.number().int().nonnegative().optional(),
    retainedLength: z.number().int().nonnegative().optional(),
  })),
});
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
  turnFailure: turnFailureSchema,
});
const conversationTranscriptOutputSchema = z.object({
  transcript: z.object({
    conversationId: z.string().uuid(),
    agentId: z.string().uuid().nullable(),
    agentName: z.string().nullable(),
    sourceChannel: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    messageCount: z.number().int().nonnegative(),
    ownership: ownershipSchema,
    messages: z.array(transcriptMessageSchema),
  }).and(z.object({ truncation: truncationSchema.optional() })),
});
const traceStageSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  inputs: z.record(jsonValueSchema).optional(),
  outputs: z.record(jsonValueSchema).optional(),
  subTrace: jsonValueSchema.optional(),
}).passthrough();
const turnTraceEnvelopeSchema = z.object({
  version: z.number().int().nonnegative(),
  spine: z.object({
    traceId: z.string(),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    stages: z.array(traceStageSchema),
  }).passthrough(),
  openTelemetry: z.object({ traceId: z.string(), spanId: z.string(), sampled: z.boolean() }).optional(),
  summary: z.record(jsonValueSchema).optional(),
}).nullable();
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
        turnTrace: turnTraceEnvelopeSchema,
        errorMessage: z.string().nullable(),
      }).nullable(),
    }),
  }).and(z.object({ truncation: truncationSchema.optional() })),
});


/**
 * Narrow ports over other modules' public services. The copilot owns these
 * consumer-shaped contracts so it never imports another module's internals.
 */
export interface CopilotConversationHistoryPort {
  getConversation(workspaceId: string, conversationId: string, options: { limit: number }, debug: CopilotConversationOptions): Promise<CopilotConversationDetail>;
  getConversationTurn(workspaceId: string, messageId: string, options: CopilotConversationOptions): Promise<CopilotConversationTurnDetail>;
  listConversations(workspaceId: string, options: { limit: number }): Promise<{ conversations: ReadonlyArray<unknown> }>;
}

interface CopilotConversationOptions {
  includeAnswerFeedback: boolean;
  includeOwnership: boolean;
  includeTurnFailureDebug: boolean;
  includeLatency: boolean;
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
  operatorDisplayName?: string;
  turnFailure?: CopilotTurnFailure;
  debug?: CopilotDebug;
}

interface CopilotConversationDetail {
  conversationId: string;
  agentId: string | null;
  agentName: string | null;
  sourceChannel: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  ownership?: CopilotOwnership;
  messages: ReadonlyArray<CopilotConversationMessage>;
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
    turnFailure: projectTurnFailure(message.turnFailure),
  })),
});

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
            activityTrace: debug.activityTrace ?? null,
            turnTrace: debug.turnTrace ?? null,
            errorMessage: debug.errorMessage ?? null,
          }
        : null,
    },
  };
};


export interface ChatCopilotToolDependencies {
  readonly chatHistoryService: CopilotConversationHistoryPort;
}

export const createChatCopilotTools = (deps: ChatCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "conversation_transcript", shape: "read", uiLabel: "Reading conversation transcript", contributingModule: "chat", dashboardSubject: { type: "conversation" }, requiredPermission: "workspace.history.read",
    description: "Read a bounded customer transcript with shallow per-turn outcomes, routing, feedback, and ownership. Use turn_trace for one turn's full diagnostic spine.",
    inputSchema: z.object({ conversationId: idSchema.optional() }), outputSchema: conversationTranscriptOutputSchema,
    createTool: (context) => ({
      name: "conversation_transcript",
      description: "Read a bounded customer transcript with shallow per-turn outcomes, routing, feedback, and ownership. Use turn_trace for one turn's full diagnostic spine.",
      inputSchema: z.object({ conversationId: idSchema.optional() }),
      outputSchema: conversationTranscriptOutputSchema,
      invoke: async ({ conversationId }) => ({
        transcript: boundConversationPayload(projectTranscript(await deps.chatHistoryService.getConversation(
          context.workspaceId,
          conversationId ?? requiredPageConversation(context.pageContext.conversationId),
          { limit: 100 },
          { includeAnswerFeedback: true, includeOwnership: true, includeTurnFailureDebug: true, includeLatency: true },
        ))),
      }),
    }),
    describeEntity: ({ conversationId }, context) => entity("conversation", conversationId ?? context?.pageContext.conversationId),
  },
  {
    name: "turn_trace", shape: "read", uiLabel: "Reading turn trace", contributingModule: "chat", dashboardSubject: { type: "conversation" }, requiredPermission: "workspace.history.read",
    description: "Inspect one message's full turn diagnostic spine. Accepts user messages, including unanswered turns with their failure or cancellation reason.",
    inputSchema: z.object({ messageId: idSchema }), outputSchema: turnTraceOutputSchema,
    createTool: (context) => ({
      name: "turn_trace",
      description: "Inspect one message's full turn diagnostic spine. Accepts user messages, including unanswered turns with their failure or cancellation reason.",
      inputSchema: z.object({ messageId: idSchema }),
      outputSchema: turnTraceOutputSchema,
      invoke: async ({ messageId }) => ({
        trace: boundTurnTracePayload(projectTurnTrace(await deps.chatHistoryService.getConversationTurn(
          context.workspaceId,
          messageId,
          { includeAnswerFeedback: true, includeOwnership: true, includeTurnFailureDebug: true, includeLatency: true },
        ))),
      }),
    }),
  },
  {
    name: "conversation_history_search", shape: "read", uiLabel: "Searching conversations", contributingModule: "chat", dashboardSubject: { type: "conversation" }, requiredPermission: "workspace.history.read",
    description: "List recent customer conversations in this workspace for investigation.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ conversations: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "conversation_history_search", description: "List recent customer conversations in this workspace for investigation.", inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ conversations: z.array(unknownRecord) }), invoke: async ({ limit }) => ({ conversations: boundPayload({ conversations: (await deps.chatHistoryService.listConversations(context.workspaceId, { limit: limit ?? 20 })).conversations as Record<string, unknown>[] }).conversations as Record<string, unknown>[] }) }),
  },

];
