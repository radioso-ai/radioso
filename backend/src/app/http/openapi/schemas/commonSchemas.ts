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

  Object.assign(schemas, {
    ErrorResponseSchema,
    FlatErrorResponseSchema,
    HealthResponseSchema,
  });
};
