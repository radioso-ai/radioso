import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerSystemPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/health",
    tags: ["System"],
    summary: "Health check",
    operationId: "getHealth",
    responses: {
      200: {
        description: "Service is healthy",
        content: {
          "application/json": {
            schema: schemas.HealthResponseSchema,
          },
        },
      },
    },
  });
};
