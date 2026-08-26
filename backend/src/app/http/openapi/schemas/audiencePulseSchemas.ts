import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS,
  audiencePulseEvidenceAnchorRequestSchema,
} from "../../../../modules/audiencePulse/contracts.js";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerAudiencePulseSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const AudiencePulseGroundingSchema = registry.register("AudiencePulseGrounding", z.object({
    grounded: z.number().int().min(0),
    degraded: z.number().int().min(0),
    noSupport: z.number().int().min(0),
    unknown: z.number().int().min(0),
    contentGapEligible: z.number().int().min(0),
  }));
  const AudiencePulseCoverageSchema = registry.register("AudiencePulseCoverage", z.object({
    populationSize: z.number().int().min(0),
    sampleSize: z.number().int().min(0),
    sampled: z.boolean(),
    // How many of populationSize had a current, embedded facet the census could cluster.
    // Zero means topic analysis has not run over this window yet, which is a different
    // statement from a computed window that found no recurring pattern.
    facetReadyQuestionCount: z.number().int().min(0),
  }));
  const AudiencePulseWeeklyVolumeSchema = registry.register("AudiencePulseWeeklyVolume", z.object({
    weekStart: z.string().datetime(),
    visitorQuestionCount: z.number().int().min(0),
    conversationCount: z.number().int().min(0),
  }));
  const AudiencePulseEvidenceSchema = registry.register("AudiencePulseEvidence", z.object({
    reference: z.string(),
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
    question: z.string().max(AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS),
    occurrenceCount: z.number().int().min(1),
  }));
  const AudiencePulseEvidenceAnchorRequestSchema = registry.register(
    "AudiencePulseEvidenceAnchorRequest",
    audiencePulseEvidenceAnchorRequestSchema,
  );
  const AudiencePulseEvidenceAnchorSourceSchema = registry.register("AudiencePulseEvidenceAnchorSource", z.object({
    messageId: z.string().uuid(),
    role: z.literal("user"),
    source: z.literal("customer"),
    content: z.string().max(AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS),
    createdAt: z.string().datetime(),
  }));
  const AudiencePulseEvidenceAnchorNextAssistantSchema = registry.register("AudiencePulseEvidenceAnchorNextAssistant", z.object({
    messageId: z.string().uuid(),
    role: z.literal("assistant"),
    source: z.enum(["customer", "ai_agent", "human_agent", "human_agent_on_behalf_of_ai_agent", "system"]),
    content: z.string().max(AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS),
    createdAt: z.string().datetime(),
  }));
  const AudiencePulseEvidenceAnchorResponseSchema = registry.register("AudiencePulseEvidenceAnchorResponse", z.object({
    conversationId: z.string().uuid(),
    source: AudiencePulseEvidenceAnchorSourceSchema,
    // A nullable registered component otherwise emits a contradictory allOf in OpenAPI 3.1.
    nextAssistant: z.union([AudiencePulseEvidenceAnchorNextAssistantSchema, z.null()]),
  }));
  const AudiencePulseThemeSchema = registry.register("AudiencePulseTheme", z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    memberCount: z.number().int().min(0),
    share: z.number().min(0).max(1),
    distinctQuestionCount: z.number().int().min(0),
    weeklyPulse: z.array(z.object({ weekStart: z.string().datetime(), count: z.number().int().min(0) })),
    grounding: AudiencePulseGroundingSchema,
    evidence: z.array(AudiencePulseEvidenceSchema),
  }));
  const AudiencePulseContentGapSchema = registry.register("AudiencePulseContentGap", z.object({
    themeId: z.string(),
    eligibleEvidenceCount: z.number().int().min(0),
    distinctConversationCount: z.number().int().min(0),
  }));
  const AudiencePulseRecommendationSchema = registry.register("AudiencePulseRecommendation", z.object({
    id: z.string(),
    themeId: z.string(),
    title: z.string(),
    rationale: z.string(),
    questions: z.array(z.string()),
    evidenceReferences: z.array(z.string()),
    startDraft: z.object({ title: z.string(), questions: z.array(z.string()) }),
  }));
  const AudiencePulseReportSchema = registry.register("AudiencePulseReport", z.object({
    period: z.object({ start: z.string().datetime(), end: z.string().datetime() }),
    generatedAt: z.string().datetime(),
    coverage: AudiencePulseCoverageSchema,
    weeklyVolume: z.array(AudiencePulseWeeklyVolumeSchema),
    summary: z.string().optional(),
    unclassifiedQuestionCount: z.number().int().min(0),
    themes: z.array(AudiencePulseThemeSchema),
    contentGaps: z.array(AudiencePulseContentGapSchema),
    recommendations: z.array(AudiencePulseRecommendationSchema),
    caveats: z.array(z.string()),
  }));
  const AudiencePulseReadResponseSchema = registry.register("AudiencePulseReadResponse", z.union([
    z.object({ kind: z.literal("not_generated") }),
    z.object({ kind: z.literal("completed"), report: AudiencePulseReportSchema }),
  ]));
  const AudiencePulseRefreshResponseSchema = registry.register("AudiencePulseRefreshResponse", z.union([
    z.object({
      kind: z.literal("no_traffic"),
      period: z.object({ start: z.string().datetime(), end: z.string().datetime() }),
      weeklyVolume: z.array(AudiencePulseWeeklyVolumeSchema),
    }),
    z.object({ kind: z.literal("preparing") }),
    z.object({ kind: z.literal("unavailable"), reason: z.enum(["provider", "validation", "cancelled"]) }),
    z.object({ kind: z.literal("completed"), report: AudiencePulseReportSchema }),
  ]));
  const AudiencePulseRefreshStatusResponseSchema = registry.register(
    "AudiencePulseRefreshStatusResponse",
    z.object({ pending: z.boolean() }),
  );

  schemas.AudiencePulseReadResponseSchema = AudiencePulseReadResponseSchema;
  schemas.AudiencePulseRefreshResponseSchema = AudiencePulseRefreshResponseSchema;
  schemas.AudiencePulseRefreshStatusResponseSchema = AudiencePulseRefreshStatusResponseSchema;
  schemas.AudiencePulseEvidenceAnchorRequestSchema = AudiencePulseEvidenceAnchorRequestSchema;
  schemas.AudiencePulseEvidenceAnchorResponseSchema = AudiencePulseEvidenceAnchorResponseSchema;
};
