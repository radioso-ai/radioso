import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const usageDetailsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  workspaceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

export const registerUsageDetailsSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const UsageEventKindSchema = registry.register(
    "UsageEventKind",
    z.enum(["model", "embedding", "unknown"]),
  );
  const ReasoningCoverageSchema = registry.register(
    "ReasoningCoverage",
    z.enum(["complete", "partial", "unavailable"]),
  );
  const UsageOperationSchema = registry.register(
    "UsageOperation",
    z.object({
      surface: z.string(),
      name: z.string(),
      label: z.string(),
    }),
  );
  const UsageAttemptsSchema = registry.register(
    "UsageAttempts",
    z.object({
      total: z.number().int().min(0),
      succeeded: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
  );
  const UsageQualityCountsSchema = registry.register(
    "UsageQualityCounts",
    z.object({
      actual: z.number().int().min(0),
      estimated: z.number().int().min(0),
    }),
  );
  const MessageModelTokensSchema = registry.register(
    "MessageModelTokens",
    z.object({
      input: z.number().int().min(0),
      completion: z.number().int().min(0),
      reasoning: z.object({
        tokens: z.number().int().min(0).nullable(),
        coverage: ReasoningCoverageSchema,
      }),
      visibleOutput: z.number().int().min(0).nullable(),
      total: z.number().int().min(0),
    }),
  );
  const MessageEmbeddingTokensSchema = registry.register(
    "MessageEmbeddingTokens",
    z.object({
      input: z.number().int().min(0),
      total: z.number().int().min(0),
      vectors: z.number().int().min(0),
      attempts: z.number().int().min(0),
    }),
  );
  const UnknownHistoricalTokensSchema = registry.register(
    "UnknownHistoricalTokens",
    z.object({
      total: z.number().int().min(0),
      attempts: z.number().int().min(0),
    }),
  );
  const MessageUsageSummarySchema = registry.register(
    "MessageUsageSummary",
    z.object({
      messageId: z.string().uuid(),
      conversationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      agentId: z.string().uuid().nullable(),
      lastOccurredAt: z.string().datetime(),
      providers: z.array(z.string()),
      models: z.array(z.string()),
      operations: z.array(UsageOperationSchema),
      attempts: UsageAttemptsSchema,
      quality: UsageQualityCountsSchema,
      modelTokens: MessageModelTokensSchema,
      embeddingTokens: MessageEmbeddingTokensSchema,
      unknownHistorical: UnknownHistoricalTokensSchema,
    }),
  );
  const InternalUsageTokensSchema = registry.register(
    "InternalUsageTokens",
    z.object({
      input: z.number().int().min(0).nullable(),
      completion: z.number().int().min(0).nullable(),
      reasoning: z.number().int().min(0).nullable(),
      visibleOutput: z.number().int().min(0).nullable(),
      total: z.number().int().min(0),
    }),
  );
  const InternalUsageEventSchema = registry.register(
    "InternalUsageEvent",
    z.object({
      eventId: z.string().uuid(),
      workspaceId: z.string().uuid().nullable(),
      agentId: z.string().uuid().nullable(),
      occurredAt: z.string().datetime(),
      kind: UsageEventKindSchema,
      operation: UsageOperationSchema,
      provider: z.string(),
      model: z.string(),
      status: z.enum(["succeeded", "failed"]),
      usageQuality: z.enum(["actual", "estimated"]),
      tokens: InternalUsageTokensSchema,
      vectorCount: z.number().int().min(0).nullable(),
    }),
  );
  const UsageDetailsFiltersSchema = registry.register(
    "UsageDetailsFilters",
    z.object({ workspaceId: z.string().uuid().nullable() }),
  );
  const MessageUsageResponseSchema = registry.register(
    "MessageUsageResponse",
    z.object({
      from: z.string(),
      to: z.string(),
      filters: UsageDetailsFiltersSchema,
      items: z.array(MessageUsageSummarySchema),
      nextCursor: z.string().nullable(),
    }),
  );
  const InternalUsageResponseSchema = registry.register(
    "InternalUsageResponse",
    z.object({
      from: z.string(),
      to: z.string(),
      filters: UsageDetailsFiltersSchema,
      items: z.array(InternalUsageEventSchema),
      nextCursor: z.string().nullable(),
    }),
  );

  schemas.UsageDetailsQuerySchema = usageDetailsQuerySchema;
  schemas.MessageUsageResponseSchema = MessageUsageResponseSchema;
  schemas.InternalUsageResponseSchema = InternalUsageResponseSchema;
};
