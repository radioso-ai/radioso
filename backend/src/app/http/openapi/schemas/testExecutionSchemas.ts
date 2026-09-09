import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { retryTestExecutionSideSchema, sendTestExecutionMessageSchema, startTestExecutionSchema } from "../../routes/agentRevisionRequestSchemas.js";

const uuid = z.string().uuid();

export const registerTestExecutionSchemas = (registry: OpenAPIRegistry) => {
  const TestExecutionEventSchema = registry.register("TestExecutionEvent", z.discriminatedUnion("type", [
    z.object({ type: z.literal("side_started"), executionId: uuid, generation: z.number().int(), turnId: uuid, attemptId: uuid, sideId: uuid }),
    z.object({ type: z.literal("message_delta"), executionId: uuid, generation: z.number().int(), turnId: uuid, attemptId: uuid, sideId: uuid, delta: z.string() }),
    z.object({ type: z.literal("side_completed"), executionId: uuid, generation: z.number().int(), turnId: uuid, attemptId: uuid, sideId: uuid, messageId: uuid }),
    z.object({ type: z.literal("side_failed"), executionId: uuid, generation: z.number().int(), turnId: uuid, attemptId: uuid, sideId: uuid, code: z.string(), retryable: z.boolean() }),
    z.object({ type: z.literal("execution_partial"), executionId: uuid, generation: z.number().int(), turnId: uuid, attemptId: uuid }),
    z.object({ type: z.literal("execution_completed"), executionId: uuid, generation: z.number().int(), turnId: uuid, attemptId: uuid }),
  ]));
  const RevisionSummarySchema = z.object({ id: uuid, label: z.string(), kind: z.enum(["candidate", "published"]), versionNumber: z.number().int().positive().nullable(), createdAt: z.string().datetime(), publishedAt: z.string().datetime().optional() });
  const TestExecutionHistoryEntrySchema = z.object({ turnId: uuid, role: z.enum(["user", "assistant"]), content: z.string(), messageId: uuid.optional(), attemptId: uuid, createdAt: z.string().datetime() });
  const TestExecutionSideSchema = registry.register("TestExecutionSide", z.object({
    id: uuid, revision: RevisionSummarySchema,
    conversationId: uuid, state: z.enum(["running", "partial", "failed", "completed"]), retryable: z.boolean(), history: z.array(TestExecutionHistoryEntrySchema),
  }));
  const StartTestExecutionRequestSchema = registry.register("StartTestExecutionRequest", startTestExecutionSchema);
  const TestExecutionSchema = registry.register("TestExecution", z.object({ id: uuid, generation: z.number().int().positive(), mode: z.enum(["single", "compare"]), sides: z.array(TestExecutionSideSchema) }));
  const TestExecutionMessageRequestSchema = registry.register("TestExecutionMessageRequest", sendTestExecutionMessageSchema);
  const TestExecutionRetryRequestSchema = registry.register("TestExecutionRetryRequest", retryTestExecutionSideSchema);
  const TestExecutionHistorySideSummarySchema = z.object({ id: uuid, revision: RevisionSummarySchema, conversationId: uuid, state: z.enum(["ready", "running", "failed", "completed"]), retryable: z.boolean() });
  const TestExecutionHistorySideSchema = TestExecutionHistorySideSummarySchema.extend({ history: z.array(TestExecutionHistoryEntrySchema) });
  const TestExecutionHistoryItemSchema = registry.register("TestExecutionHistoryItem", z.object({ id: uuid, generation: z.number().int().positive(), mode: z.enum(["single", "compare"]), state: z.enum(["running", "partial", "failed", "completed"]), createdAt: z.string().datetime(), sides: z.array(TestExecutionHistorySideSummarySchema) }));
  const TestExecutionAttemptRecordSchema = registry.register("TestExecutionAttemptRecord", z.object({ executionId: uuid, sideId: uuid, turnId: uuid, attemptId: uuid, fence: z.number().int().positive(), state: z.enum(["running", "failed", "completed"]), failureCode: z.string().nullable(), leaseExpiresAt: z.string().datetime(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }));
  const TestExecutionHistoryDetailSchema = registry.register("TestExecutionHistoryDetail", TestExecutionHistoryItemSchema.extend({ testValues: z.array(z.unknown()), sides: z.array(TestExecutionHistorySideSchema), attempts: z.array(TestExecutionAttemptRecordSchema) }));
  const TestExecutionHistoryListResponseSchema = registry.register("TestExecutionHistoryListResponse", z.object({ executions: z.array(TestExecutionHistoryItemSchema), nextCursor: z.string().nullable(), hasMore: z.boolean() }));
  const TestExecutionHistoryDetailResponseSchema = registry.register("TestExecutionHistoryDetailResponse", z.object({ execution: TestExecutionHistoryDetailSchema }));
  const TestExecutionParamsSchema = z.object({ agentId: uuid, executionId: uuid });
  const TestExecutionRetryParamsSchema = TestExecutionParamsSchema.extend({ sideId: uuid });
  const TestExecutionRetainParamsSchema = TestExecutionParamsSchema.extend({ sideId: uuid });
  return { TestExecutionEventSchema, TestExecutionSideSchema, StartTestExecutionRequestSchema, TestExecutionSchema, TestExecutionMessageRequestSchema, TestExecutionRetryRequestSchema, TestExecutionHistoryListResponseSchema, TestExecutionHistoryDetailResponseSchema, TestExecutionParamsSchema, TestExecutionRetryParamsSchema, TestExecutionRetainParamsSchema };
};
