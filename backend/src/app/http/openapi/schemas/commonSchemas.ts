import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerCommonSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const ErrorResponseSchema = registry.register(
    "ErrorResponse",
    z.object({
      error: z.object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      }),
    }),
  );

  const FlatErrorResponseSchema = registry.register(
    "FlatErrorResponse",
    z.object({
      code: z.string(),
      message: z.string(),
    }),
  );

  const HealthResponseSchema = registry.register(
    "HealthResponse",
    z.object({
      status: z.literal("ok"),
    }),
  );

  const OrganizationCreationRateLimitExceededSchema = registry.register(
    "OrganizationCreationRateLimitExceeded",
    z.object({
      error: z.object({
        code: z.literal("rate_limit_exceeded"),
        message: z.string(),
        details: z.object({
          limit: z.number().int().min(0),
          used: z.number().int().min(0),
          periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          resetAt: z.string().datetime(),
        }),
      }),
    }),
  );

  const OrganizationCreationOverrideSchema = registry.register(
    "OrganizationCreationOverride",
    z.object({
      userId: z.string().uuid(),
      monthlyLimit: z.number().int().min(0).nullable(),
      unlimited: z.boolean(),
      updatedAt: z.string().datetime(),
    }),
  );

  const OrganizationCreationOverrideResponseSchema = registry.register(
    "OrganizationCreationOverrideResponse",
    z.object({
      override: OrganizationCreationOverrideSchema.nullable(),
    }),
  );

  const OrganizationCreationOverrideRequestSchema = registry.register(
    "OrganizationCreationOverrideRequest",
    z.object({
      monthlyLimit: z.number().int().min(0).nullable(),
    }),
  );

  const organizationCreationUserParamsSchema = z.object({
    userId: z.string().uuid(),
  });

  Object.assign(schemas, {
    ErrorResponseSchema,
    FlatErrorResponseSchema,
    HealthResponseSchema,
    OrganizationCreationRateLimitExceededSchema,
    OrganizationCreationOverrideSchema,
    OrganizationCreationOverrideResponseSchema,
    OrganizationCreationOverrideRequestSchema,
    organizationCreationUserParamsSchema,
  });
};
