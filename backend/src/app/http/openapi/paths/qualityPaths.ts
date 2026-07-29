import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const csvOrArrayString = z
  .string()
  .describe("Comma-separated list. May also be repeated as multiple query params.");

export const registerQualityPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/quality/turns",
    tags: ["Quality"],
    summary: "List low-quality assistant turns",
    description:
      "Returns assistant turns for the dashboard's quality review surface. Admin/owner only " +
      "(requires the `workspace.quality.read` permission). Filters apply to skill action, skill " +
      "status, user feedback, latency, agent, channel, and time range.",
    operationId: "listLowQualityTurns",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      query: z.object({
        actions: csvOrArrayString
          .describe("Comma-separated `skillName:outcome` tuples, e.g. `retrieval.answer:no_context`.")
          .optional(),
        statuses: csvOrArrayString
          .describe("Comma-separated `QualitySkillStatus` values.")
          .optional(),
        feedback: csvOrArrayString
          .describe("Comma-separated `QualityFeedbackValue` values (`up`, `down`).")
          .optional(),
        triage: csvOrArrayString
          .describe("Comma-separated `QualityTriageState` values (`open`, `acknowledged`, `resolved`, `dismissed`).")
          .optional(),
        sort: z.enum(["turn_created_at", "negative_feedback_updated_at"])
          .describe("Sort order. Defaults to assistant-turn creation time.")
          .optional(),
        activeNegativeFeedbackOnly: z.coerce.boolean()
          .describe(
            "When true, returns thumbs-down feedback that has not been triaged since its latest creation or edit. " +
            "Feedback newer than terminal triage is treated as open.",
          )
          .optional(),
        hasComment: z.coerce.boolean()
          .describe("When true, only turns with written feedback comments are returned. When false, only turns without written feedback comments are returned.")
          .optional(),
        agentId: z.string().uuid().optional(),
        channel: z.string().min(1).max(64).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        minTotalLatencyMs: z.coerce.number().int().min(0).optional(),
        maxTotalLatencyMs: z.coerce.number().int().min(0).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: "Page of low-quality assistant turns",
        content: {
          "application/json": {
            schema: schemas.LowQualityTurnsPageSchema,
          },
        },
      },
      400: {
        description: "Invalid query parameter",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
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
      403: {
        description: "Caller lacks the workspace.quality.read permission",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/quality/turns/{assistantMessageId}/triage",
    tags: ["Quality"],
    summary: "Set the triage state of an assistant turn",
    description:
      "Upserts the operator triage state (`open`, `acknowledged`, `resolved`, `dismissed`) for an " +
      "assistant turn. Admin/owner only (requires the `workspace.quality.manage` permission).",
    operationId: "setQualityTurnTriage",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: z.object({ assistantMessageId: z.string().uuid() }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.SetQualityTriageRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated triage record",
        content: {
          "application/json": {
            schema: schemas.QualityTriageRecordSchema,
          },
        },
      },
      400: {
        description: "Invalid request body or assistant message id",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
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
      403: {
        description: "Caller lacks the workspace.quality.manage permission",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Assistant turn not found in this workspace",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
