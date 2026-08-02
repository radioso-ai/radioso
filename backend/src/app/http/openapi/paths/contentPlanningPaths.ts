import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  contentPlanListQuerySchema,
  contentPlanTopicTurnsQuerySchema,
} from "../../../../modules/contentPlanning/contracts/index.js";
import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerContentPlanningPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const auth = [{ [security.bearerAuthScheme.name]: [] }];
  const commonErrors = {
    400: {
      description: "Invalid query, topic identifier, or cursor",
      content: { "application/json": { schema: schemas.ErrorResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: schemas.ErrorResponseSchema } },
    },
    403: {
      description: "Caller lacks the workspace.quality.read permission",
      content: { "application/json": { schema: schemas.ErrorResponseSchema } },
    },
  };
  const topicNotFound = {
    description: "Topic is unknown, foreign, retired, or no longer has a valid redirect",
    content: { "application/json": { schema: schemas.ErrorResponseSchema } },
  };

  registry.registerPath({
    method: "get",
    path: "/api/v1/quality/content-plan",
    tags: ["Quality"],
    summary: "List the continuously maintained content plan",
    description:
      "Returns a frozen 30-day demand and grounding view, ranked content opportunities, " +
      "emerging questions, and honest projection freshness for the active workspace.",
    operationId: "listContentPlan",
    security: auth,
    request: { query: contentPlanListQuerySchema },
    responses: {
      200: {
        description: "Content plan page",
        content: { "application/json": { schema: schemas.ContentPlanPageSchema } },
      },
      ...commonErrors,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/quality/content-plan/topics/{topicId}",
    tags: ["Quality"],
    summary: "Get content plan topic evidence",
    description:
      "Returns the canonical mature topic, decision evidence, representative source questions, " +
      "related documents, and affected surfaces. A live merged ID resolves to its canonical topic.",
    operationId: "getContentPlanTopic",
    security: auth,
    request: { params: schemas.ContentPlanTopicParamsSchema },
    responses: {
      200: {
        description: "Content plan topic detail",
        content: { "application/json": { schema: schemas.ContentPlanTopicDetailSchema } },
      },
      ...commonErrors,
      404: topicNotFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/quality/content-plan/topics/{topicId}/turns",
    tags: ["Quality"],
    summary: "List Quality turns belonging to a content plan topic",
    description:
      "Returns the existing Quality turn DTO for deduplicated topic members in the requested " +
      "current, comparison, or combined window. A live merged ID resolves to its canonical topic.",
    operationId: "listContentPlanTopicTurns",
    security: auth,
    request: {
      params: schemas.ContentPlanTopicParamsSchema,
      query: contentPlanTopicTurnsQuerySchema,
    },
    responses: {
      200: {
        description: "Page of topic member turns",
        content: { "application/json": { schema: schemas.LowQualityTurnsPageSchema } },
      },
      ...commonErrors,
      404: topicNotFound,
    },
  });
};
