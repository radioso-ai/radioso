import { z } from "zod";
import { Buffer } from "node:buffer";

import type { CopilotToolDescriptor } from "../contracts.js";
import type {
  CopilotAgentTurnProbePort,
  CopilotAgentTurnProbeResult,
} from "../contracts/agentTurnProbe.js";
export type { CopilotAgentTurnProbePort } from "../contracts/agentTurnProbe.js";
import { describeNamedAgent, requiredCopilotConversation, requiredPageAgent, type CopilotAgentLookupPort } from "./shared.js";

const idSchema = z.string().uuid();
const boundedIdSchema = z.string().min(1).max(160);
const omissionFieldSchema = z.enum([
  "answer",
  "citations",
  "citations.sourceUrl",
  "diagnostics",
  "trace",
  "trace.spine.stages",
]);
const omissionReasonSchema = z.enum([
  "array_length",
  "budget_omitted",
  "invalid_field",
  "not_allowlisted",
  "string_length",
]);

const userInputMetadataSchema = z.object({
  method: z.enum(["typed", "suggestion_click", "intent_click"]),
  suggestionSourceMessageId: idSchema.optional(),
  intent: z.object({
    skillName: z.string().trim().min(1).max(120),
    intentName: z.string().trim().min(1).max(120).optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.method === "suggestion_click" && !value.suggestionSourceMessageId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "suggestionSourceMessageId is required for suggestion_click", path: ["suggestionSourceMessageId"] });
  }
  if (value.method === "intent_click" && !value.intent) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "intent is required for intent_click", path: ["intent"] });
  }
});

const assistantPageContextSchema = z.object({
  pageUrl: z.string().trim().max(2_048).nullable().optional(),
  pageTitle: z.string().trim().max(180).nullable().optional(),
  pageLocale: z.string().trim().max(35).nullable().optional(),
  browserLocale: z.string().trim().max(35).nullable().optional(),
  content: z.string().trim().max(6_000).nullable().optional(),
}).strict();

const clientContextCapabilitiesSchema = z.object({
  "page.read": z.object({
    available: z.boolean(),
    mode: z.enum(["metadata", "content"]).nullable(),
    supportedOperations: z.array(z.enum(["metadata", "lookup", "summarize"])).max(3),
  }).strict().optional(),
}).strict();

export const agentTurnProbeInputSchema = z.object({
  agentId: idSchema.optional(),
  agentName: z.string().trim().min(1).max(160).optional(),
  conversationId: idSchema.optional(),
  message: z.string().trim().min(1).max(8_000),
  previewRoutineIds: z.array(idSchema).max(20).optional(),
  userExpectedLocale: z.string().trim().max(35).optional(),
  inputMetadata: userInputMetadataSchema.optional(),
  pageContext: assistantPageContextSchema.optional(),
  clientContextCapabilities: clientContextCapabilitiesSchema.optional(),
}).strict();

const citationSchema = z.object({
  documentId: boundedIdSchema,
  chunkId: boundedIdSchema,
  title: z.string().max(240),
}).strict();

const stageSchema = z.object({
  id: z.string().max(160),
  kind: z.string().max(120),
  status: z.string().max(80),
  startedAt: z.string().max(64).optional(),
  completedAt: z.string().max(64).optional(),
}).strict();

const traceSchema = z.object({
  version: z.number().int().nonnegative(),
  spine: z.object({
    traceId: z.string().max(160),
    startedAt: z.string().max(64),
    completedAt: z.string().max(64).optional(),
    stages: z.array(stageSchema).max(80),
  }).strict(),
  openTelemetry: z.object({
    traceId: z.string().max(160),
    spanId: z.string().max(80),
    sampled: z.boolean(),
  }).strict().optional(),
}).strict();

export const agentTurnProbeOutputSchema = z.object({
  probe: z.object({
    conversationId: idSchema,
    userMessageId: idSchema,
    assistantMessageId: idSchema,
    agentId: idSchema,
    answer: z.string().max(8_001),
    citations: z.array(citationSchema).max(12),
    outcome: z.object({
      status: z.literal("completed"),
      skillOutcome: z.string().max(160).nullable(),
      answerOutcome: z.string().max(160).nullable(),
    }).strict(),
    trace: traceSchema.nullable(),
  }).strict(),
  omissions: z.array(z.object({
    field: omissionFieldSchema,
    reason: omissionReasonSchema,
    omittedCount: z.number().int().positive().optional(),
  }).strict()).max(12),
}).strict();

export const agentTurnProbeEnrichedOutputSchema = agentTurnProbeOutputSchema.extend({
  dashboardUrl: z.string().startsWith("/"),
}).strict();

type AgentTurnProbeInput = z.infer<typeof agentTurnProbeInputSchema>;
type AgentTurnProbeOutput = z.infer<typeof agentTurnProbeOutputSchema>;
type AgentTurnProbeEnrichedOutput = z.infer<typeof agentTurnProbeEnrichedOutputSchema>;
type ProbeOmission = AgentTurnProbeOutput["omissions"][number];

export interface AgentTurnProbeCopilotToolDependencies {
  readonly agentLookup: CopilotAgentLookupPort;
  readonly agentTurnProbe: CopilotAgentTurnProbePort;
}

export const AGENT_TURN_PROBE_PAYLOAD_BYTE_BUDGET = 32_000;

export const createAgentTurnProbeCopilotTools = (
  deps: AgentTurnProbeCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor<AgentTurnProbeInput, AgentTurnProbeOutput>> => [{
  name: "test_agent_turn",
  shape: "probe",
  uiLabel: "Testing an agent turn",
  contributingModule: "chat",
  dashboardSubject: { type: "conversation" },
  requiredPermissions: [
    "workspace.agents.read",
    "workspace.chat.use",
    "workspace.history.read",
    "workspace.agents.manage",
  ],
  description: "Run one bounded, non-streaming operator test turn against an agent, optionally previewing unpublished routine drafts.",
  inputSchema: agentTurnProbeInputSchema,
  outputSchema: agentTurnProbeOutputSchema,
  createTool: (context) => ({
    name: "test_agent_turn",
    description: "Run one bounded, non-streaming operator test turn against an agent, optionally previewing unpublished routine drafts.",
    inputSchema: agentTurnProbeInputSchema,
    outputSchema: agentTurnProbeOutputSchema,
    invoke: async (input) => {
      const agentId = input.agentId ?? requiredPageAgent(context.pageContext.agentId);
      const result = await deps.agentTurnProbe.testTurn({
        workspaceId: context.workspaceId,
        accountId: context.accountId,
        operatorUserId: context.operatorUserId,
        copilotConversationId: requiredCopilotConversation(context),
        agentId,
        message: input.message,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.previewRoutineIds ? { previewRoutineIds: input.previewRoutineIds } : {}),
        ...(input.userExpectedLocale ? { userExpectedLocale: input.userExpectedLocale } : {}),
        ...(input.inputMetadata ? { inputMetadata: input.inputMetadata } : {}),
        ...(input.pageContext ? { pageContext: input.pageContext } : {}),
        ...(input.clientContextCapabilities ? { clientContextCapabilities: input.clientContextCapabilities } : {}),
      });
      return agentTurnProbeOutputSchema.parse(enforcePayloadByteBudget(projectProbeResult(result, agentId)));
    },
  }),
  describeEntity: (input, context) => describeNamedAgent(input, context, deps.agentLookup),
  describeOutputEntity: (output) => ({ type: "conversation", id: output.probe.conversationId }),
  finalizeEnrichedOutput: (output) => finalizeEnrichedProbeOutput(output),
}];

const projectProbeResult = (result: CopilotAgentTurnProbeResult, requestedAgentId: string): AgentTurnProbeOutput => {
  if (result.agentId !== undefined && result.agentId !== requestedAgentId) {
    throw new Error("Agent turn probe returned a different agent identity");
  }
  const omissions: ProbeOmission[] = [];
  const projected: AgentTurnProbeOutput = {
    probe: {
      conversationId: result.conversationId,
      userMessageId: result.userMessageId,
      assistantMessageId: result.assistantMessageId,
      agentId: requestedAgentId,
      answer: boundedString(result.answer, 8_000, "answer", omissions),
      citations: projectCitations(result.citations, omissions),
      outcome: {
        status: "completed",
        skillOutcome: boundedNullableString(result.skillOutcome, 160),
        answerOutcome: boundedNullableString(result.answerOutcome, 160),
      },
      trace: projectTrace(result.turnTrace, omissions),
    },
    omissions,
  };
  if (result.activitySummary !== undefined || result.activityTrace !== undefined) {
    addOmission(omissions, { field: "diagnostics", reason: "not_allowlisted" });
  }
  return projected;
};

const projectCitations = (value: ReadonlyArray<unknown> | undefined, omissions: ProbeOmission[]): AgentTurnProbeOutput["probe"]["citations"] => {
  if (!value) return [];
  const citations = value.slice(0, 12).flatMap((entry) => {
    if (isRecord(entry) && entry.sourceUrl !== undefined) {
      addOmission(omissions, { field: "citations.sourceUrl", reason: "not_allowlisted" });
    }
    if (!isRecord(entry) || typeof entry.documentId !== "string" || typeof entry.chunkId !== "string" || typeof entry.title !== "string") {
      addOmission(omissions, { field: "citations", reason: "invalid_field", omittedCount: 1 });
      return [];
    }
    const citation = {
      documentId: clippedString(entry.documentId, 160, "citations", omissions),
      chunkId: clippedString(entry.chunkId, 160, "citations", omissions),
      title: clippedString(entry.title, 240, "citations", omissions),
    };
    return [citation];
  });
  if (value.length > 12) addOmission(omissions, { field: "citations", reason: "array_length", omittedCount: value.length - 12 });
  return citations;
};

const projectTrace = (value: unknown, omissions: ProbeOmission[]): AgentTurnProbeOutput["probe"]["trace"] => {
  if (!isRecord(value) || typeof value.version !== "number" || !isRecord(value.spine)) {
    if (value !== undefined) addOmission(omissions, { field: "trace", reason: "invalid_field" });
    return null;
  }
  const spine = value.spine;
  if (typeof spine.traceId !== "string" || typeof spine.startedAt !== "string" || !Array.isArray(spine.stages)) {
    addOmission(omissions, { field: "trace", reason: "invalid_field" });
    return null;
  }
  let invalidStageCount = 0;
  let containsPrivateDiagnostics = "summary" in value;
  const stages = spine.stages.slice(0, 80).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.kind !== "string" || typeof entry.status !== "string") {
      invalidStageCount += 1;
      return [];
    }
    containsPrivateDiagnostics = containsPrivateDiagnostics || "inputs" in entry || "outputs" in entry || "subTrace" in entry;
    return [{
      id: clippedString(entry.id, 160, "trace.spine.stages", omissions),
      kind: clippedString(entry.kind, 120, "trace.spine.stages", omissions),
      status: clippedString(entry.status, 80, "trace.spine.stages", omissions),
      ...(typeof entry.startedAt === "string" ? { startedAt: clippedString(entry.startedAt, 64, "trace.spine.stages", omissions) } : {}),
      ...(typeof entry.completedAt === "string" ? { completedAt: clippedString(entry.completedAt, 64, "trace.spine.stages", omissions) } : {}),
    }];
  });
  if (invalidStageCount > 0) addOmission(omissions, { field: "trace.spine.stages", reason: "invalid_field", omittedCount: invalidStageCount });
  if (containsPrivateDiagnostics) addOmission(omissions, { field: "diagnostics", reason: "not_allowlisted" });
  if (spine.stages.length > 80) addOmission(omissions, { field: "trace.spine.stages", reason: "array_length", omittedCount: spine.stages.length - 80 });
  const openTelemetry = isRecord(value.openTelemetry)
    && typeof value.openTelemetry.traceId === "string"
    && typeof value.openTelemetry.spanId === "string"
    && typeof value.openTelemetry.sampled === "boolean"
      ? {
          traceId: clippedString(value.openTelemetry.traceId, 160, "trace", omissions),
          spanId: clippedString(value.openTelemetry.spanId, 80, "trace", omissions),
          sampled: value.openTelemetry.sampled,
        }
      : undefined;
  return {
    version: Math.max(0, Math.trunc(value.version)),
    spine: {
      traceId: clippedString(spine.traceId, 160, "trace", omissions),
      startedAt: clippedString(spine.startedAt, 64, "trace", omissions),
      ...(typeof spine.completedAt === "string" ? { completedAt: clippedString(spine.completedAt, 64, "trace", omissions) } : {}),
      stages,
    },
    ...(openTelemetry ? { openTelemetry } : {}),
  };
};

const finalizeEnrichedProbeOutput = (output: Record<string, unknown>): AgentTurnProbeEnrichedOutput => {
  const parsed = agentTurnProbeEnrichedOutputSchema.parse(output);
  const bounded = enforcePayloadByteBudget(parsed);
  if (serializedBytes(bounded) > AGENT_TURN_PROBE_PAYLOAD_BYTE_BUDGET) {
    throw new Error("Agent turn probe output exceeds its final byte budget");
  }
  return agentTurnProbeEnrichedOutputSchema.parse(bounded);
};

const enforcePayloadByteBudget = <T extends AgentTurnProbeOutput>(output: T): T => {
  while (serializedBytes(output) > AGENT_TURN_PROBE_PAYLOAD_BYTE_BUDGET && output.probe.trace?.spine.stages.length) {
    output.probe.trace.spine.stages.pop();
    addOmission(output.omissions, { field: "trace.spine.stages", reason: "budget_omitted", omittedCount: 1 });
  }
  while (serializedBytes(output) > AGENT_TURN_PROBE_PAYLOAD_BYTE_BUDGET && output.probe.citations.length) {
    output.probe.citations.pop();
    addOmission(output.omissions, { field: "citations", reason: "budget_omitted", omittedCount: 1 });
  }
  if (serializedBytes(output) > AGENT_TURN_PROBE_PAYLOAD_BYTE_BUDGET && output.probe.trace) {
    output.probe.trace = null;
    addOmission(output.omissions, { field: "trace", reason: "budget_omitted" });
  }
  if (serializedBytes(output) > AGENT_TURN_PROBE_PAYLOAD_BYTE_BUDGET) {
    addOmission(output.omissions, { field: "answer", reason: "budget_omitted" });
    output.probe.answer = longestAnswerWithinBudget(output, output.probe.answer);
  }
  if (serializedBytes(output) > AGENT_TURN_PROBE_PAYLOAD_BYTE_BUDGET) {
    throw new Error("Agent turn probe output cannot fit within its byte budget");
  }
  return output;
};

const longestAnswerWithinBudget = <T extends AgentTurnProbeOutput>(output: T, answer: string): string => {
  const codePoints = Array.from(answer);
  let low = 0;
  let high = codePoints.length;
  let retained = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    output.probe.answer = codePoints.slice(0, middle).join("");
    if (serializedBytes(output) <= AGENT_TURN_PROBE_PAYLOAD_BYTE_BUDGET) {
      retained = output.probe.answer;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return retained;
};

const boundedString = (value: string, max: number, field: ProbeOmission["field"], omissions: ProbeOmission[]): string => {
  if (value.length <= max) return value;
  addOmission(omissions, { field, reason: "string_length" });
  return `${value.slice(0, max)}…`;
};

const clippedString = (value: string, max: number, field: ProbeOmission["field"], omissions: ProbeOmission[]): string => {
  if (value.length <= max) return value;
  addOmission(omissions, { field, reason: "string_length" });
  return value.slice(0, max);
};

const boundedNullableString = (value: string | undefined, max: number): string | null =>
  value === undefined ? null : value.slice(0, max);

const addOmission = (omissions: ProbeOmission[], omission: ProbeOmission): void => {
  const existing = omissions.find((candidate) => candidate.field === omission.field && candidate.reason === omission.reason);
  if (existing && omission.omittedCount) {
    existing.omittedCount = (existing.omittedCount ?? 0) + omission.omittedCount;
    return;
  }
  if (!existing && omissions.length < 12) omissions.push({ ...omission });
};

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
