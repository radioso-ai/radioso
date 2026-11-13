import { z } from "zod";

import { userTimeZoneSchema } from "../schemas/timeZoneSchemas.js";
import { visitorImageIdsSchema } from "../schemas/visitorImageSchemas.js";

const testValueSchema = z.object({ contextVariableId: z.string().uuid(), value: z.unknown().optional() }).strict();

export const revisionListQuerySchema = z.object({ include: z.literal("published").optional() }).strict();
export const createRevisionCandidateBodySchema = z.object({ expectedDraftGeneration: z.number().int().positive() }).strict();
export const publishRevisionBodySchema = z.object({
  expectedDraftGeneration: z.number().int().positive(),
  expectedPublishedRevisionId: z.string().uuid().nullable(),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();
export const startTestExecutionSchema = z.object({
  mode: z.enum(["single", "compare"]),
  revisionIds: z.array(z.string().uuid()).min(1).max(2),
  testValues: z.array(testValueSchema).max(100),
  expectedDraftGeneration: z.number().int().positive().optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  /** Defaults to "suppressed" when omitted (see resolveSkillEffectPolicy). */
  skillEffects: z.enum(["suppressed", "allowed"]).optional(),
  /** Starts the single side from an existing conversation's thread and runtime state. */
  seedConversationId: z.string().uuid().optional(),
}).strict().superRefine((body, context) => {
  if (body.seedConversationId !== undefined && body.mode !== "single") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["seedConversationId"],
      message: "A test execution seeded from a conversation runs a single revision.",
    });
  }
});
const testExecutionTurnSchema = z.object({
  executionGeneration: z.number().int().positive(),
  turnId: z.string().uuid(),
  attemptId: z.string().uuid(),
  userTimeZone: userTimeZoneSchema.optional().describe(
    "The operator's IANA time zone, such as America/Los_Angeles, which Test Chat sends from the browser with every message and retry. The turn reads today, tomorrow and this weekend in it; without it, or with an unknown zone, the workspace's time zone applies, then UTC.",
  ),
});
export const sendTestExecutionMessageSchema = testExecutionTurnSchema.extend({
  message: z.string().min(1).max(20_000).optional().describe("What the operator typed. Required unless `imageIds` is present."),
  imageIds: visitorImageIdsSchema.optional().describe(
    "Photos uploaded with `POST /api/v1/assistant/images` for this agent by the same caller, in the order they were attached; at most three, each sent once. Every side runs on the message followed by what the agent read in each photo.",
  ),
}).strict().superRefine((body, context) => {
  if (body.message === undefined && body.imageIds === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["message"], message: "message is required unless imageIds is present" });
  }
});
export const retryTestExecutionSideSchema = testExecutionTurnSchema.strict();
export const startRevisionEvalRunSchema = z.object({
  revisionIds: z.array(z.string().uuid()).min(1).max(2),
  caseIds: z.array(z.string().uuid()).min(1).max(500),
  testValues: z.array(testValueSchema).max(100),
  mode: z.enum(["retrieval_only", "full_assistant"]),
  executionPolicy: z.literal("safe_test"),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();
