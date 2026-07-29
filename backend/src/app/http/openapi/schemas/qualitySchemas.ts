import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerQualitySchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const QualityFeedbackValueSchema = registry.register(
    "QualityFeedbackValue",
    z.enum(["up", "down"]),
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

  const QualityTriageRecordSchema = registry.register(
    "QualityTriageRecord",
    z.object({
      state: QualityTriageStateSchema,
      reason: z.string().nullable(),
      updatedAt: z.string().datetime().nullable(),
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
      channel: z.string().nullable(),
      question: z.string().nullable(),
      answerPreview: z.string(),
      skillName: z.string().nullable(),
      skillOutcome: z.string().nullable(),
      skillStatus: QualitySkillStatusSchema.nullable(),
      totalLatencyMs: z.number().int().nullable(),
      createdAt: z.string().datetime(),
      feedback: QualityFeedbackSummarySchema,
      triage: QualityTriageRecordSchema,
    }),
  );

  const SetQualityTriageRequestSchema = registry.register(
    "SetQualityTriageRequest",
    z.object({
      state: QualityTriageStateSchema,
      reason: z.string().max(500).nullish(),
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
  schemas.QualitySkillStatusSchema = QualitySkillStatusSchema;
  schemas.QualityTriageStateSchema = QualityTriageStateSchema;
  schemas.QualityTriageRecordSchema = QualityTriageRecordSchema;
  schemas.SetQualityTriageRequestSchema = SetQualityTriageRequestSchema;
  schemas.QualityFeedbackCommentSchema = QualityFeedbackCommentSchema;
  schemas.QualityFeedbackSummarySchema = QualityFeedbackSummarySchema;
  schemas.LowQualityTurnSchema = LowQualityTurnSchema;
  schemas.LowQualityTurnsPageSchema = LowQualityTurnsPageSchema;
};
