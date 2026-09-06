import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerQualitySchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const QualityFeedbackValueSchema = registry.register(
    "QualityFeedbackValue",
    z.enum(["up", "down"]),
  );

  const GroundingDiagnosticSchema = registry.register(
    "GroundingDiagnostic",
    z.object({
      verdict: z.enum(["grounded", "degraded", "no_support"]),
      claimCount: z.number().int().min(0),
      sourcedClaimCount: z.number().int().min(0),
      unsourcedClaimCount: z.number().int().min(0),
      invalidSourceCount: z.number().int().min(0),
    }).describe("Complete immutable grounding snapshot for this answer. Null means no complete diagnostic is available."),
  );

  const QualitySkillStatusSchema = registry.register(
    "QualitySkillStatus",
    z.enum([
      "active",
      "paused",
      "awaiting_confirmation",
      "awaiting_tool",
      "completed",
      "cancelled",
      "expired",
      "failed",
    ]),
  );

  const QualityTriageStateSchema = registry.register(
    "QualityTriageState",
    z.enum(["open", "acknowledged", "resolved", "dismissed"]),
  );

  const QualityResolutionReasonSchema = registry.register(
    "QualityResolutionReason",
    z.enum([
      "knowledge_gap",
      "retrieval_issue",
      "agent_behavior",
      "platform_bug",
      "expected_behavior",
      "out_of_scope",
      "invalid_feedback",
      "other",
    ]),
  );

  const QualityResolutionSchema = registry.register(
    "QualityResolution",
    z.object({
      reason: QualityResolutionReasonSchema,
      note: z.string().max(500).nullable(),
    }),
  );

  const QualityResolutionInputSchema = registry.register(
    "QualityResolutionInput",
    z.object({
      reason: QualityResolutionReasonSchema,
      note: z.string().max(500).nullish(),
    }),
  );

  const QualityTriageRecordSchema = registry.register(
    "QualityTriageRecord",
    z.object({
      state: QualityTriageStateSchema,
      version: z.number().int().min(0),
      // Registered schemas must use an explicit union here. `.nullable()` emits an
      // `allOf` intersection that openapi-typescript cannot represent usefully.
      resolution: z.union([QualityResolutionSchema, z.null()]),
      legacyReason: z.string().nullable(),
      closedAt: z.string().datetime().nullable(),
      updatedAt: z.string().datetime().nullable(),
    }),
  );

  const QualityVerificationSchema = registry.register(
    "QualityVerification",
    z.object({
      caseId: z.string().uuid(),
      caseStatus: z.enum(["pending", "passing", "failing", "error"]),
      latestRunStatus: z.enum(["pass", "fail", "error", "recorded"]).nullable(),
      latestRunAt: z.string().datetime().nullable(),
    }),
  );

  const QualityTriageConflictResponseSchema = registry.register(
    "QualityTriageConflictResponse",
    z.object({
      error: z.object({
        code: z.literal("QUALITY_TRIAGE_CONFLICT"),
        message: z.string(),
        details: z.object({
          current: QualityTriageRecordSchema,
        }),
      }),
    }),
  );

  const QualityFeedbackCommentSchema = registry.register(
    "QualityFeedbackComment",
    z.object({
      value: QualityFeedbackValueSchema,
      comment: z.string(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const QualityFeedbackSummarySchema = registry.register(
    "QualityFeedbackSummary",
    z.object({
      upCount: z.number().int().min(0),
      downCount: z.number().int().min(0),
      latestDownUpdatedAt: z.string().datetime().nullable(),
      comments: z.array(QualityFeedbackCommentSchema),
    }),
  );

  const LowQualityTurnSchema = registry.register(
    "LowQualityTurn",
    z.object({
      assistantMessageId: z.string().uuid(),
      conversationId: z.string().uuid(),
      agentId: z.string().uuid().nullable(),
      agentName: z.string().nullable(),
      agentInternalName: z.string().nullable(),
      channel: z.string().nullable(),
      question: z.string().nullable(),
      answerPreview: z.string(),
      skillName: z.string().nullable(),
      skillOutcome: z.string().nullable(),
      skillStatus: z.union([QualitySkillStatusSchema, z.null()]),
      totalLatencyMs: z.number().int().nullable(),
      grounding: z.union([GroundingDiagnosticSchema, z.null()]),
      createdAt: z.string().datetime(),
      feedback: QualityFeedbackSummarySchema,
      triage: QualityTriageRecordSchema,
      verification: z.union([QualityVerificationSchema, z.null()]),
    }),
  );

  const QualitySignalIdSchema = registry.register(
    "QualitySignalId",
    z.enum(["negative_feedback", "grounding_gaps", "skill_failures"]),
  );

  const QualityStatsRangeSchema = registry.register("QualityStatsRange", z.enum(["7d", "30d"]));

  const QualityStatsMetricSchema = registry.register(
    "QualityStatsMetric",
    z.object({
      count: z.number().int().min(0).describe("Turns matching the metric within the window."),
      denominator: z
        .number()
        .int()
        .min(0)
        .describe("Turns the metric is defined over."),
      rate: z
        .number()
        .min(0)
        .max(1)
        .nullable()
        .describe("`count / denominator`, or null when the denominator is zero."),
    }),
  );

  const QualityStatsWindowSchema = registry.register(
    "QualityStatsWindow",
    z.object({
      from: z.string().datetime().describe("Start of the window, inclusive."),
      to: z.string().datetime().describe("End of the window, exclusive."),
      turnCount: z.number().int().min(0),
      grounded: QualityStatsMetricSchema.describe(
        "Grounded answers over turns that attempted one. Outcomes the skill catalog leaves unflagged, such as a clarifying question, are in neither the count nor the denominator.",
      ),
      negativeFeedback: QualityStatsMetricSchema.describe(
        "Turns with at least one down vote, over turns with any vote. A turn with several votes counts once.",
      ),
      skillFailures: QualityStatsMetricSchema.describe(
        "Turns whose skill ended in `failed`, over all turns.",
      ),
    }),
  );

  const QualityStatsBucketSchema = registry.register(
    "QualityStatsBucket",
    z.object({
      date: z.string().describe("UTC day as `YYYY-MM-DD`."),
      turnCount: z.number().int().min(0),
      grounded: QualityStatsMetricSchema,
      negativeFeedback: QualityStatsMetricSchema,
      skillFailures: QualityStatsMetricSchema,
    }),
  );

  const QualityStatsSchema = registry.register(
    "QualityStats",
    z.object({
      range: QualityStatsRangeSchema,
      filters: z.object({
        agentId: z.string().uuid().optional(),
        channel: z.string().optional(),
      }),
      current: QualityStatsWindowSchema,
      previous: QualityStatsWindowSchema.describe(
        "Equal length, immediately preceding the current window.",
      ),
      buckets: z
        .array(QualityStatsBucketSchema)
        .describe("Current window only, one entry per UTC day, zero-filled."),
      // Spelled out rather than z.record(QualitySignalIdSchema, ...): a record generates every
      // key as optional, but the service always emits every signal, and the UI reads them
      // unconditionally. A fixed object keeps the generated SDK types honest about that.
      backlog: z
        .object({
          negative_feedback: z.number().int().min(0),
          grounding_gaps: z.number().int().min(0),
          skill_failures: z.number().int().min(0),
        })
        .describe(
          "Turns still in an active triage state (`open` or `acknowledged`) per signal. All-time and independent of `range`.",
        ),
      resolutionBreakdown: z.array(z.object({
        state: z.enum(["resolved", "dismissed"]),
        reason: z.union([QualityResolutionReasonSchema, z.literal("unspecified")]),
        count: z.number().int().min(0),
      })).describe(
        "Current-window terminal triage counts grouped by state and structured reason. Closures without one are grouped as `unspecified`.",
      ),
    }),
  );

  const SetQualityTriageRequestSchema = registry.register(
    "SetQualityTriageRequest",
    z.object({
      state: QualityTriageStateSchema,
      expectedVersion: z.number().int().min(0),
      resolution: z.union([QualityResolutionInputSchema, z.null()]).optional().openapi({
        description:
          "Optional structured context for terminal states. Omit or send null to close without recording a reason.",
      }),
      reason: z.string().max(500).nullish().openapi({
        deprecated: true,
        description:
          "Compatibility-only free text. It remains opaque and is never classified as a structured resolution reason.",
      }),
    }),
  );

  const LowQualityTurnsPageSchema = registry.register(
    "LowQualityTurnsPage",
    z.object({
      items: z.array(LowQualityTurnSchema),
      total: z.number().int().min(0),
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1),
      totalPages: z.number().int().min(0),
    }),
  );

  schemas.QualityFeedbackValueSchema = QualityFeedbackValueSchema;
  schemas.GroundingDiagnosticSchema = GroundingDiagnosticSchema;
  schemas.QualitySkillStatusSchema = QualitySkillStatusSchema;
  schemas.QualityTriageStateSchema = QualityTriageStateSchema;
  schemas.QualityResolutionReasonSchema = QualityResolutionReasonSchema;
  schemas.QualityResolutionSchema = QualityResolutionSchema;
  schemas.QualityVerificationSchema = QualityVerificationSchema;
  schemas.QualityTriageConflictResponseSchema = QualityTriageConflictResponseSchema;
  schemas.QualityTriageRecordSchema = QualityTriageRecordSchema;
  schemas.SetQualityTriageRequestSchema = SetQualityTriageRequestSchema;
  schemas.QualityFeedbackCommentSchema = QualityFeedbackCommentSchema;
  schemas.QualityFeedbackSummarySchema = QualityFeedbackSummarySchema;
  schemas.LowQualityTurnSchema = LowQualityTurnSchema;
  schemas.LowQualityTurnsPageSchema = LowQualityTurnsPageSchema;
  schemas.QualitySignalIdSchema = QualitySignalIdSchema;
  schemas.QualityStatsRangeSchema = QualityStatsRangeSchema;
  schemas.QualityStatsMetricSchema = QualityStatsMetricSchema;
  schemas.QualityStatsWindowSchema = QualityStatsWindowSchema;
  schemas.QualityStatsBucketSchema = QualityStatsBucketSchema;
  schemas.QualityStatsSchema = QualityStatsSchema;
};
