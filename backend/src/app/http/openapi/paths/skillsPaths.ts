import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerSkillsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/skills",
    tags: ["Skills"],
    summary: "List available Radioso skills",
    operationId: "listSkills",
    security: [{ [security.bearerAuthScheme.name]: [] }, ...security.workspaceAdminSecurity],
    responses: {
      200: {
        description: "Skills catalog returned",
        content: {
          "application/json": {
            schema: schemas.SkillCatalogResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/skills/{skillName}",
    tags: ["Skills"],
    summary: "Get one Radioso skill catalog entry",
    operationId: "getSkill",
    security: [{ [security.bearerAuthScheme.name]: [] }, ...security.workspaceAdminSecurity],
    request: {
      params: schemas.SkillParamsSchema,
    },
    responses: {
      200: {
        description: "Skill catalog entry returned",
        content: {
          "application/json": {
            schema: schemas.SkillCatalogEntrySchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Skill not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
