import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const usageTrendsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  granularity: z.enum(["day", "week", "month"]),
  workspaceId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
});

export const registerUsageTrendSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const UsageTrendGranularitySchema = registry.register(
    "UsageTrendGranularity",
    z.enum(["day", "week", "month"]),
  );

  const UsageTrendBucketSchema = registry.register(
    "UsageTrendBucket",
    z.object({
      periodStart: z.string().datetime(),
      periodEnd: z.string().datetime(),
      conversationsCreated: z.number().int().min(0),
      messages: z.object({
        total: z.number().int().min(0),
        user: z.number().int().min(0),
        assistant: z.number().int().min(0),
      }),
      tokens: z.object({
        input: z.number().int().min(0),
        output: z.number().int().min(0),
        total: z.number().int().min(0),
      }),
    }),
  );

  const UsageTrendsResponseSchema = registry.register(
    "UsageTrendsResponse",
    z.object({
      granularity: UsageTrendGranularitySchema,
      from: z.string(),
      to: z.string(),
      filters: z.object({
        workspaceId: z.string().uuid().nullable(),
        agentId: z.string().uuid().nullable(),
      }),
      buckets: z.array(UsageTrendBucketSchema),
    }),
  );

  schemas.UsageTrendBucketSchema = UsageTrendBucketSchema;
  schemas.UsageTrendGranularitySchema = UsageTrendGranularitySchema;
  schemas.UsageTrendsQuerySchema = usageTrendsQuerySchema;
  schemas.UsageTrendsResponseSchema = UsageTrendsResponseSchema;
};
