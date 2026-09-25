import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import type { CopilotTestChatPort, CopilotTestChatTurn } from "../contracts/testChat.js";
import { serializedLength, truncationRecordSchema } from "../payloadCompaction.js";
import { boundTurnTracePayload, CONVERSATION_PAYLOAD_CHAR_BUDGET, turnTraceEnvelopeSchema } from "./chatPayloadBounds.js";
import { describeNamedAgent, requiredPageAgent, type CopilotAgentLookupPort } from "./shared.js";

export type { CopilotTestChatPort } from "../contracts/testChat.js";

const DEFAULT_SESSIONS = 10;
const MAX_SESSIONS = 20;
const FIRST_MESSAGE_CHARS = 200;
const MAX_TURNS = 20;
const USER_MESSAGE_CHARS = 1_000;
const TRANSCRIPT_ANSWER_CHARS = 2_000;
const SEND_ANSWER_CHARS = 4_000;
const TRANSCRIPT_STAGES = 30;
const SEND_STAGES = 60;

const idSchema = z.string().uuid();
const agentInput = {
  agentId: idSchema.optional(),
  agentName: z.string().trim().min(1).max(160).optional(),
};

const sessionsInputSchema = z.object({
  ...agentInput,
  limit: z.number().int().min(1).max(MAX_SESSIONS).optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict();
const transcriptInputSchema = z.object({ ...agentInput, testExecutionId: idSchema }).strict();
const turnTraceInputSchema = z.object({ ...agentInput, testExecutionId: idSchema, turnId: idSchema, sideId: idSchema.optional() }).strict();
const sendInputSchema = z.object({
  ...agentInput,
  message: z.string().trim().min(1).max(8_000),
  testExecutionId: idSchema.optional(),
  revisionId: idSchema.optional(),
}).strict();

const revisionSchema = z.object({
  id: idSchema,
  kind: z.enum(["candidate", "published"]),
  versionNumber: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
}).strict();
const sideSchema = z.object({
  sideId: idSchema,
  revision: revisionSchema,
  state: z.enum(["ready", "running", "failed", "completed"]),
}).strict();
const sessionHeader = {
  testExecutionId: idSchema,
  mode: z.enum(["single", "compare"]),
  state: z.enum(["running", "partial", "failed", "completed"]),
  skillEffects: z.enum(["suppressed", "allowed"]),
  createdAt: z.string(),
};
const turnStateSchema = z.enum(["completed", "running", "failed", "unanswered"]);
/** Where a turn went, without what it read or produced there; test_chat_turn_trace has that. */
const coarseStageSchema = z.object({
  id: z.string().max(120),
  kind: z.string().max(120),
  status: z.string().max(40),
}).strict();

const omissionsSchema = <TField extends [string, ...string[]]>(fields: TField) => z.array(z.object({
  field: z.enum(fields),
  reason: z.enum(["array_length", "string_length", "budget_omitted"]),
  omittedCount: z.number().int().nonnegative().optional(),
}).strict()).max(8);

const sessionsOutputSchema = z.object({
  sessions: z.array(z.object({
    ...sessionHeader,
    sides: z.array(sideSchema).max(2),
    turnCount: z.number().int().nonnegative(),
    firstMessage: z.string().max(FIRST_MESSAGE_CHARS + 1).nullable(),
  }).strict()).max(MAX_SESSIONS),
  nextCursor: z.string().nullable(),
  omissions: omissionsSchema(["sessions.firstMessage"]),
}).strict();

const transcriptOutputSchema = z.object({
  session: z.object({
    ...sessionHeader,
    sides: z.array(sideSchema.extend({
      turnCount: z.number().int().nonnegative(),
      turns: z.array(z.object({
        turnId: idSchema,
        userMessage: z.string().max(USER_MESSAGE_CHARS + 1).nullable(),
        answer: z.string().max(TRANSCRIPT_ANSWER_CHARS + 1).nullable(),
        messageId: z.string().max(200).nullable(),
        state: turnStateSchema,
        failureCode: z.string().max(120).nullable(),
        createdAt: z.string(),
        stages: z.array(coarseStageSchema).max(TRANSCRIPT_STAGES),
      }).strict()).max(MAX_TURNS),
    }).strict()).max(2),
  }).strict(),
  omissions: omissionsSchema(["turns", "turns.userMessage", "turns.answer", "turns.stages"]),
}).strict();

const turnTraceOutputSchema = z.object({
  trace: z.object({
    testExecutionId: idSchema,
    sideId: idSchema,
    revision: revisionSchema,
    turnId: idSchema,
    state: turnStateSchema,
    failureCode: z.string().nullable(),
    createdAt: z.string(),
    userMessage: z.string().nullable(),
    answer: z.object({ messageId: z.string().nullable(), content: z.string() }).nullable(),
    /** Null for a turn with no trace: a greeting, or one that failed, is running, or was never answered. */
    turnTrace: turnTraceEnvelopeSchema.nullable(),
  }).and(z.object({ truncation: truncationRecordSchema })),
});

const sendOutputSchema = z.object({
  turn: z.object({
    testExecutionId: idSchema,
    started: z.boolean(),
    sideId: idSchema,
    revision: revisionSchema,
    turnId: idSchema,
    outcome: z.enum(["completed", "failed"]),
    failureCode: z.string().max(120).nullable(),
    answer: z.string().max(SEND_ANSWER_CHARS + 1).nullable(),
    messageId: z.string().max(200).nullable(),
    stages: z.array(coarseStageSchema).max(SEND_STAGES),
  }).strict(),
  omissions: omissionsSchema(["answer", "stages"]),
}).strict();

type SessionsInput = z.infer<typeof sessionsInputSchema>;
type TranscriptInput = z.infer<typeof transcriptInputSchema>;
type TurnTraceInput = z.infer<typeof turnTraceInputSchema>;
type SendInput = z.infer<typeof sendInputSchema>;
type Omission<TField extends string> = { field: TField; reason: "array_length" | "string_length" | "budget_omitted"; omittedCount?: number };

const addOmission = <TField extends string>(omissions: Omission<TField>[], field: TField, reason: Omission<TField>["reason"], count = 1): void => {
  const existing = omissions.find((candidate) => candidate.field === field && candidate.reason === reason);
  if (existing) existing.omittedCount = (existing.omittedCount ?? 0) + count;
  else omissions.push({ field, reason, omittedCount: count });
};

const clipped = <TField extends string>(value: string, max: number, field: TField, omissions: Omission<TField>[]): string => {
  if (value.length <= max) return value;
  addOmission(omissions, field, "string_length");
  const cut = value.slice(0, max);
  // Never end on half of a surrogate pair.
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trace that is not an envelope reads as having no stages, the same as an untraced greeting. */
const coarseStages = <TField extends string>(turnTrace: unknown, max: number, field: TField, omissions: Omission<TField>[]) => {
  const stages = isRecord(turnTrace) && isRecord(turnTrace.spine) && Array.isArray(turnTrace.spine.stages) ? turnTrace.spine.stages : [];
  const readable = stages.flatMap((stage) => isRecord(stage) && typeof stage.id === "string" && typeof stage.kind === "string" && typeof stage.status === "string"
    ? [{ id: stage.id.slice(0, 120), kind: stage.kind.slice(0, 120), status: stage.status.slice(0, 40) }]
    : []);
  if (readable.length > max) addOmission(omissions, field, "array_length", readable.length - max);
  return readable.slice(0, max);
};

/** A stored trace this reader cannot render as an envelope reads as absent rather than failing the read. */
const readableEnvelope = (turnTrace: unknown): unknown => (turnTraceEnvelopeSchema.safeParse(turnTrace).success ? turnTrace : null);

type TranscriptOmission = Omission<"turns" | "turns.userMessage" | "turns.answer" | "turns.stages">;

const projectTranscriptTurn = (turn: CopilotTestChatTurn, omissions: TranscriptOmission[]) => ({
  turnId: turn.turnId,
  userMessage: turn.userMessage === null ? null : clipped(turn.userMessage, USER_MESSAGE_CHARS, "turns.userMessage", omissions),
  answer: turn.answer ? clipped(turn.answer.content, TRANSCRIPT_ANSWER_CHARS, "turns.answer", omissions) : null,
  messageId: turn.answer?.messageId ?? null,
  state: turn.state,
  failureCode: turn.failureCode?.slice(0, 120) ?? null,
  createdAt: turn.createdAt,
  stages: coarseStages(turn.turnTrace, TRANSCRIPT_STAGES, "turns.stages", omissions),
});

/**
 * A transcript is context for a question, so it takes the conversation readers' share of the turn.
 * The most recent turns are the ones a "why didn't it fire" question is about, so the oldest go first.
 */
const fitTranscript = <T extends { session: { sides: Array<{ turns: unknown[] }> }; omissions: TranscriptOmission[] }>(output: T): T => {
  while (serializedLength(output) > CONVERSATION_PAYLOAD_CHAR_BUDGET) {
    const side = output.session.sides.reduce<{ turns: unknown[] } | null>((longest, candidate) =>
      candidate.turns.length > (longest?.turns.length ?? 0) ? candidate : longest, null);
    if (!side) break;
    side.turns.shift();
    addOmission(output.omissions, "turns", "budget_omitted");
  }
  return output;
};

export interface TestChatCopilotToolDependencies {
  readonly testChat: CopilotTestChatPort;
  readonly agentLookup: CopilotAgentLookupPort;
}

const SESSIONS_DESCRIPTION = "List an agent's recent Test Chat sessions, newest first: the revision each side ran (a draft candidate or a published version), the session's state and skill-effects policy, how many messages were sent, and the first one. Test Chat sessions are private test runs and never appear in conversation_history_search. Read one with test_chat_transcript.";
const TRANSCRIPT_DESCRIPTION = "Read one Test Chat session: per side, the revision it ran and each turn's message, answer, state or failure code, and the stages the turn went through. Use test_chat_turn_trace for one turn's full diagnostic spine.";
const TURN_TRACE_DESCRIPTION = "Inspect one Test Chat turn's full diagnostic spine, in the same trace shape turn_trace returns for a customer conversation, with the revision the turn ran on and its failure code when it did not answer.";
const SEND_DESCRIPTION = "Send one message through Test Chat, the private, revision-pinned test surface of the dashboard, and return the answer, outcome, and the stages the turn went through. Without testExecutionId it starts a session on revisionId, or on a fresh candidate of the saved draft (the published revision when the draft has no changes); with testExecutionId it continues that single-revision session. Skills never act outward here. The session stays in the agent's Test Chat history, where the operator can open it; read the turn with test_chat_turn_trace.";

export const createTestChatCopilotTools = (
  deps: TestChatCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const sessions: CopilotToolDescriptor<SessionsInput, z.infer<typeof sessionsOutputSchema>> = {
    name: "test_chat_sessions",
    shape: "read",
    verificationCost: () => 0,
    uiLabel: "Listing Test Chat sessions",
    contributingModule: "testExecution",
    dashboardSubject: { type: "agent" },
    requiredPermissions: ["workspace.agents.manage"],
    description: SESSIONS_DESCRIPTION,
    inputSchema: sessionsInputSchema,
    outputSchema: sessionsOutputSchema,
    createTool: (context) => ({
      name: "test_chat_sessions",
      description: SESSIONS_DESCRIPTION,
      inputSchema: sessionsInputSchema,
      outputSchema: sessionsOutputSchema,
      invoke: async (input) => {
        const page = await deps.testChat.listSessions({
          workspaceId: context.workspaceId,
          agentId: input.agentId ?? requiredPageAgent(context.pageContext.agentId),
          limit: input.limit ?? DEFAULT_SESSIONS,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        });
        const omissions: Omission<"sessions.firstMessage">[] = [];
        return sessionsOutputSchema.parse({
          sessions: page.sessions.slice(0, MAX_SESSIONS).map((session) => ({
            ...session,
            sides: session.sides.slice(0, 2),
            firstMessage: session.firstMessage === null ? null : clipped(session.firstMessage, FIRST_MESSAGE_CHARS, "sessions.firstMessage", omissions),
          })),
          nextCursor: page.nextCursor,
          omissions,
        });
      },
    }),
    describeEntity: (input, context) => describeNamedAgent(input, context, deps.agentLookup),
  };

  const transcript: CopilotToolDescriptor<TranscriptInput, z.infer<typeof transcriptOutputSchema>> = {
    name: "test_chat_transcript",
    shape: "read",
    verificationCost: () => 0,
    uiLabel: "Reading Test Chat session",
    contributingModule: "testExecution",
    dashboardSubject: { type: "agent" },
    requiredPermissions: ["workspace.agents.manage"],
    description: TRANSCRIPT_DESCRIPTION,
    inputSchema: transcriptInputSchema,
    outputSchema: transcriptOutputSchema,
    createTool: (context) => ({
      name: "test_chat_transcript",
      description: TRANSCRIPT_DESCRIPTION,
      inputSchema: transcriptInputSchema,
      outputSchema: transcriptOutputSchema,
      invoke: async (input) => {
        const session = await deps.testChat.readSession({
          workspaceId: context.workspaceId,
          agentId: input.agentId ?? requiredPageAgent(context.pageContext.agentId),
          testExecutionId: input.testExecutionId,
        });
        const omissions: TranscriptOmission[] = [];
        const sides = session.sides.slice(0, 2).map((side) => {
          const dropped = Math.max(0, side.turns.length - MAX_TURNS);
          if (dropped > 0) addOmission(omissions, "turns", "array_length", dropped);
          return {
            sideId: side.sideId,
            revision: side.revision,
            state: side.state,
            turnCount: side.turns.filter((turn) => turn.userMessage !== null).length,
            turns: side.turns.slice(dropped).map((turn) => projectTranscriptTurn(turn, omissions)),
          };
        });
        const { sides: _sides, ...header } = session;
        return transcriptOutputSchema.parse(fitTranscript({ session: { ...header, sides }, omissions }));
      },
    }),
    describeEntity: (input, context) => describeNamedAgent(input, context, deps.agentLookup),
  };

  const turnTrace: CopilotToolDescriptor<TurnTraceInput, z.infer<typeof turnTraceOutputSchema>> = {
    name: "test_chat_turn_trace",
    shape: "read",
    verificationCost: () => 0,
    uiLabel: "Reading Test Chat turn trace",
    contributingModule: "testExecution",
    dashboardSubject: { type: "agent" },
    requiredPermissions: ["workspace.agents.manage"],
    description: TURN_TRACE_DESCRIPTION,
    inputSchema: turnTraceInputSchema,
    outputSchema: turnTraceOutputSchema,
    createTool: (context) => ({
      name: "test_chat_turn_trace",
      description: TURN_TRACE_DESCRIPTION,
      inputSchema: turnTraceInputSchema,
      outputSchema: turnTraceOutputSchema,
      invoke: async (input) => {
        const detail = await deps.testChat.readTurn({
          workspaceId: context.workspaceId,
          agentId: input.agentId ?? requiredPageAgent(context.pageContext.agentId),
          testExecutionId: input.testExecutionId,
          turnId: input.turnId,
          ...(input.sideId ? { sideId: input.sideId } : {}),
        });
        const { turn } = detail;
        // Bounded by the same profile and budget as turn_trace, so one turn's spine reads the same
        // whichever surface ran it. The identifiers join after bounding, so compaction never clips
        // the ids a caller needs to follow up.
        const bounded = boundTurnTracePayload({
          state: turn.state,
          failureCode: turn.failureCode,
          createdAt: turn.createdAt,
          userMessage: turn.userMessage,
          answer: turn.answer,
          turnTrace: readableEnvelope(turn.turnTrace),
        });
        return turnTraceOutputSchema.parse({
          trace: { ...bounded, testExecutionId: detail.testExecutionId, sideId: detail.sideId, revision: detail.revision, turnId: turn.turnId },
        });
      },
    }),
    describeEntity: (input, context) => describeNamedAgent(input, context, deps.agentLookup),
  };

  const send: CopilotToolDescriptor<SendInput, z.infer<typeof sendOutputSchema>> = {
    name: "send_test_chat_message",
    shape: "probe",
    // One real agent turn per call.
    verificationCost: () => 1,
    uiLabel: "Sending a Test Chat message",
    contributingModule: "testExecution",
    dashboardSubject: { type: "agent" },
    requiredPermissions: ["workspace.agents.manage"],
    description: SEND_DESCRIPTION,
    inputSchema: sendInputSchema,
    outputSchema: sendOutputSchema,
    createTool: (context) => ({
      name: "send_test_chat_message",
      description: SEND_DESCRIPTION,
      inputSchema: sendInputSchema,
      outputSchema: sendOutputSchema,
      invoke: async (input) => {
        const result = await deps.testChat.sendMessage({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
          operatorUserId: context.operatorUserId,
          agentId: input.agentId ?? requiredPageAgent(context.pageContext.agentId),
          message: input.message,
          ...(input.testExecutionId ? { testExecutionId: input.testExecutionId } : {}),
          ...(input.revisionId ? { revisionId: input.revisionId } : {}),
        });
        const omissions: Omission<"answer" | "stages">[] = [];
        const { turnTrace: trace, ...turn } = result;
        return sendOutputSchema.parse({
          turn: {
            ...turn,
            failureCode: turn.failureCode?.slice(0, 120) ?? null,
            answer: turn.answer === null ? null : clipped(turn.answer, SEND_ANSWER_CHARS, "answer", omissions),
            stages: coarseStages(trace, SEND_STAGES, "stages", omissions),
          },
          omissions,
        });
      },
    }),
    describeEntity: (input, context) => describeNamedAgent(input, context, deps.agentLookup),
  };

  return [sessions, transcript, turnTrace, send];
};
