import { z } from "zod";

const testValueSchema = z.object({ contextVariableId: z.string().uuid(), value: z.unknown() }).strict();

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
}).strict();
export const sendTestExecutionMessageSchema = z.object({
  message: z.string().min(1).max(20_000),
  executionGeneration: z.number().int().positive(),
  turnId: z.string().uuid(),
  attemptId: z.string().uuid(),
}).strict();
export const retryTestExecutionSideSchema = sendTestExecutionMessageSchema.omit({ message: true });
export const startRevisionEvalRunSchema = z.object({
  revisionIds: z.array(z.string().uuid()).min(1).max(2),
  caseIds: z.array(z.string().uuid()).min(1).max(500),
  testValues: z.array(testValueSchema).max(100),
  mode: z.enum(["retrieval_only", "full_assistant"]),
  executionPolicy: z.literal("safe_test"),
}).strict();
