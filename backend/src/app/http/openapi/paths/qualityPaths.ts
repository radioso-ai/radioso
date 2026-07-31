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
      "(requires the `workspace.quality.read` permission). Filters apply to operator signal, skill " +
      "action, skill status, user feedback, latency, agent, channel, and time range. Operator-test " +
      "conversations and replies authored by a human teammate are excluded.",
    operationId: "listLowQualityTurns",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      query: z.object({
        signal: csvOrArrayString
          .describe(
            "Comma-separated `QualitySignalId` values (`negative_feedback`, `grounding_gaps`, " +
            "`slow_responses`, `skill_failures`), resolved server-side from the skill catalog. " +
            "A turn matches if it carries any listed signal, and the result is layered on top " +
            "of the other filters rather than replacing them.",
          )
          .optional(),
        groundingVerdict: csvOrArrayString
          .describe("Comma-separated `grounded`, `degraded`, or `no_support` verdicts. A turn matches any listed verdict.")
          .optional(),
        hasUnsourcedClaims: z.enum(["true", "false"])
          .describe("Filter complete diagnostics by whether the unsourced claim count is positive. Unknown diagnostics match neither value.")
          .optional(),
        hasInvalidSources: z.enum(["true", "false"])
          .describe("Filter complete diagnostics by whether the invalid source count is positive. Unknown diagnostics match neither value.")
          .optional(),
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
        resolutionReason: csvOrArrayString
          .describe(
            "Comma-separated structured resolution reasons, plus `unspecified` for any terminal record without one.",
          )
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
          .describe(
            "When true, only turns with written feedback comments are returned. When false, only turns without written feedback comments are returned. " +
            "When feedback values are also selected, comment presence is evaluated for those values.",
          )
          .optional(),
        agentId: z.string().uuid().optional(),
        channel: z.string().min(1).max(64).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        resolutionFrom: z.string().datetime()
          .describe("Terminal triage closure time, inclusive. Distinct from assistant-turn `from`.")
          .optional(),
        resolutionTo: z.string().datetime()
          .describe("Terminal triage closure time, exclusive. Distinct from assistant-turn `to`.")
          .optional(),
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
    method: "get",
    path: "/api/v1/quality/stats",
    tags: ["Quality"],
    summary: "Read assistant answer-quality statistics",
    description:
      "Returns answer-quality rates for a rolling window, the equal-length window before it, " +
      "one zero-filled bucket per UTC day, and the all-time active-triage backlog per signal. " +
      "Admin/owner only (requires the `workspace.quality.read` permission). Every rate ships with " +
      "the population it is defined over, and reports `null` rather than a rate when that " +
      "population is empty. The turn population matches `GET /api/v1/quality/turns`: operator-test " +
      "conversations and replies authored by a human teammate are excluded.",
    operationId: "getQualityStats",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      query: z.object({
        range: schemas.QualityStatsRangeSchema
          .describe("Length of the health window. Defaults to `30d`.")
          .optional(),
        agentId: z.string().uuid().optional(),
        channel: z.string().min(1).max(64).optional(),
      }),
    },
    responses: {
      200: {
        description: "Answer-quality statistics for the requested window",
        content: {
          "application/json": {
            schema: schemas.QualityStatsSchema,
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
      "assistant turn using optimistic concurrency. Terminal states accept an optional structured reason; " +
      "omit it to close without classification. Admin/owner only (requires the " +
      "`workspace.quality.manage` permission).",
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
      409: {
        description: "The triage record changed after the caller loaded it; includes the current record",
        content: {
          "application/json": {
            schema: schemas.QualityTriageConflictResponseSchema,
          },
        },
      },
    },
  });
};
