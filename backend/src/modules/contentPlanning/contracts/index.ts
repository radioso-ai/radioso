import { z } from "zod";

import type { LowQualityTurnsPage } from "../../quality/contracts/index.js";

export const CONTENT_PLAN_VIEWS = ["opportunities", "all_interests"] as const;
export const CONTENT_PLAN_PROJECTION_STATES = [
  "bootstrapping",
  "ready",
  "updating",
  "delayed",
  "reprojecting",
  "degraded",
  "budget_paused",
] as const;
export const CONTENT_PLAN_TRENDS = [
  "new",
  "rising",
  "steady",
  "falling",
  "insufficient_data",
] as const;
export const CONTENT_PLAN_EVIDENCE_STRENGTHS = ["none", "low", "medium", "high"] as const;
export const CONTENT_PLAN_RECOMMENDATION_ACTIONS = [
  "add_content",
  "review_existing_content",
  "investigate_retrieval",
  "monitor",
] as const;
export const CONTENT_PLAN_ENRICHMENT_STATES = [
  "pending",
  "ready",
  "stale",
  "unavailable",
  "outside_analysis_cap",
] as const;
export const CONTENT_PLAN_CORPUS_STATES = ["pending", "ready", "unavailable", "stale"] as const;
export const CONTENT_PLAN_HEADLINE_STATES = [
  "measured",
  "insufficient_measured_turns",
  "unmeasured",
] as const;

export const contentPlanViewSchema = z.enum(CONTENT_PLAN_VIEWS);
export const contentPlanProjectionStateSchema = z.enum(CONTENT_PLAN_PROJECTION_STATES);
export const contentPlanTrendSchema = z.enum(CONTENT_PLAN_TRENDS);
export const contentPlanEvidenceStrengthSchema = z.enum(CONTENT_PLAN_EVIDENCE_STRENGTHS);
export const contentPlanRecommendationActionSchema = z.enum(CONTENT_PLAN_RECOMMENDATION_ACTIONS);
export const contentPlanEnrichmentStateSchema = z.enum(CONTENT_PLAN_ENRICHMENT_STATES);
export const contentPlanCorpusStateSchema = z.enum(CONTENT_PLAN_CORPUS_STATES);
export const contentPlanHeadlineStateSchema = z.enum(CONTENT_PLAN_HEADLINE_STATES);

const nonNegativeInteger = z.number().int().min(0);
const rate = z.number().finite().min(0).max(1);
const isoInstant = z.string().datetime({ offset: true });
const nullableIsoInstant = z.union([isoInstant, z.null()]);
const nullableRate = z.union([rate, z.null()]);
const nullableText = z.union([z.string(), z.null()]);
const nullableUuid = z.union([z.string().uuid(), z.null()]);

export const contentPlanListQuerySchema = z.object({
  view: contentPlanViewSchema.default("opportunities"),
  cursor: z.string().trim().min(1).max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const contentPlanTopicTurnsQuerySchema = z.object({
  window: z.enum(["current", "comparison", "both"]).default("current"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const contentPlanWindowSchema = z.object({
  from: isoInstant,
  to: isoInstant,
}).strict();

export const contentPlanProjectionSchema = z.object({
  state: contentPlanProjectionStateSchema,
  processedThrough: nullableIsoInstant,
  processingLagSeconds: z.union([nonNegativeInteger, z.null()]),
  pendingEmbeddingCount: nonNegativeInteger,
  pendingAssignmentCount: nonNegativeInteger,
  pendingEnrichmentTopicCount: nonNegativeInteger,
  processedCount: z.union([nonNegativeInteger, z.null()]),
  totalCount: z.union([nonNegativeInteger, z.null()]),
  embeddingSpaceFingerprint: nullableText,
  reason: nullableText,
}).strict();

export const contentPlanGroundingSummarySchema = z.object({
  evaluatedAnswerCount: nonNegativeInteger,
  groundedAnswerCount: nonNegativeInteger,
  degradedAnswerCount: nonNegativeInteger,
  noSupportAnswerCount: nonNegativeInteger,
  notEvaluatedAnswerCount: nonNegativeInteger,
  reducedOrNoSupportRate: nullableRate,
  headlineState: contentPlanHeadlineStateSchema,
}).strict();

export const contentPlanSummarySchema = z.object({
  questionCount: nonNegativeInteger,
  conversationCount: nonNegativeInteger,
  matureTopicCount: nonNegativeInteger,
  emergingQuestionCount: nonNegativeInteger,
  opportunityCount: nonNegativeInteger,
  grounding: contentPlanGroundingSummarySchema,
}).strict();

export const contentPlanTopicGroundingSchema = z.object({
  groundedAnswerCount: nonNegativeInteger,
  degradedAnswerCount: nonNegativeInteger,
  noSupportAnswerCount: nonNegativeInteger,
  notEvaluatedAnswerCount: nonNegativeInteger,
  evaluatedAnswerCount: nonNegativeInteger,
  reducedOrNoSupportRate: nullableRate,
  headlineState: contentPlanHeadlineStateSchema,
}).strict();

const contentPlanRecommendationSchema = z.object({
  action: z.union([contentPlanRecommendationActionSchema, z.null()]),
  state: contentPlanEnrichmentStateSchema,
  rationale: nullableText,
  suggestedTitle: nullableText,
  questionsToAnswer: z.array(z.string().trim().min(1).max(500)).max(7),
  suggestedShape: z.union([
    z.enum(["guide", "faq", "reference", "policy", "troubleshooting"]),
    z.null(),
  ]),
  evidenceStatement: nullableText,
  factsMustBeVerified: z.literal(true),
}).strict();

export const contentPlanTopicSummarySchema = z.object({
  id: z.string().uuid(),
  lifecycle: z.literal("mature"),
  label: nullableText,
  description: nullableText,
  labelState: contentPlanEnrichmentStateSchema,
  demand: z.object({
    currentQuestionCount: nonNegativeInteger,
    comparisonQuestionCount: nonNegativeInteger,
    currentConversationCount: nonNegativeInteger,
    comparisonConversationCount: nonNegativeInteger,
    currentShare: nullableRate,
    absoluteChange: z.number().int(),
    trend: contentPlanTrendSchema,
  }).strict(),
  grounding: contentPlanTopicGroundingSchema,
  evidence: z.object({
    strength: contentPlanEvidenceStrengthSchema,
    evaluatedConversationCount: nonNegativeInteger,
    activeGapConversationCount: nonNegativeInteger,
  }).strict(),
  opportunity: z.object({
    credible: z.boolean(),
    priorityReasons: z.array(z.enum([
      "active_no_support",
      "active_degraded",
      "high_demand",
      "new_demand",
      "rising_demand",
    ])).max(5),
  }).strict(),
  recommendation: contentPlanRecommendationSchema,
  corpusEvidence: z.object({
    state: contentPlanCorpusStateSchema,
    relatedDocumentCount: nonNegativeInteger.max(5),
    actionRuleVersion: z.literal(1),
  }).strict(),
  affected: z.object({
    agentCount: nonNegativeInteger,
    channelCount: nonNegativeInteger,
  }).strict(),
  updatedAt: isoInstant,
}).strict();

export const contentPlanEmergingQuestionSchema = z.object({
  observationId: z.string().uuid(),
  question: nullableText,
  sourceAvailable: z.boolean(),
  conversationId: nullableUuid,
  assistantMessageId: nullableUuid,
  questionCount: nonNegativeInteger,
  conversationCount: nonNegativeInteger,
  observedAt: isoInstant,
  state: z.enum(["emerging", "awaiting_context", "awaiting_embedding"]),
}).strict();

export const contentPlanPageSchema = z.object({
  range: z.literal("30d"),
  window: contentPlanWindowSchema,
  comparisonWindow: contentPlanWindowSchema,
  asOf: isoInstant,
  projection: contentPlanProjectionSchema,
  summary: contentPlanSummarySchema,
  rankingVersion: z.literal(1),
  recommendedTopicId: nullableUuid,
  items: z.array(contentPlanTopicSummarySchema),
  emerging: z.array(contentPlanEmergingQuestionSchema),
  nextCursor: nullableText,
}).strict();

export const contentPlanTopicDetailParamsSchema = z.object({
  topicId: z.string().uuid(),
}).strict();

export const contentPlanDetailSchema = z.object({
  asOf: isoInstant,
  window: contentPlanWindowSchema,
  comparisonWindow: contentPlanWindowSchema,
  projection: contentPlanProjectionSchema,
  canonicalTopicId: z.string().uuid(),
  redirectedFromTopicId: nullableUuid,
  topic: contentPlanTopicSummarySchema,
  decision: z.object({
    action: z.union([contentPlanRecommendationActionSchema, z.null()]),
    actionState: z.enum(["ready", "unavailable", "pending", "stale"]),
    reasons: z.array(z.string().trim().min(1).max(500)).max(8),
  }).strict(),
  representativeQuestions: z.array(z.object({
    observationId: z.string().uuid(),
    question: nullableText,
    sourceAvailable: z.boolean(),
    conversationId: nullableUuid,
    userMessageId: nullableUuid,
    assistantMessageId: nullableUuid,
    observedAt: isoInstant,
    groundingVerdict: z.enum(["grounded", "degraded", "no_support", "not_evaluated"]),
  }).strict()).max(8),
  relatedDocuments: z.array(z.object({
    id: z.string().uuid(),
    title: z.string(),
    updatedAt: isoInstant,
    possibleRelevance: rate,
    evidence: z.object({
      existedBeforeGap: z.boolean(),
      retrievedByGapAnswers: z.boolean(),
      citedByGapAnswers: z.boolean(),
      changedAfterGap: z.boolean(),
    }).strict(),
  }).strict()).max(5),
  affectedAgents: z.array(z.object({
    id: z.string().uuid(),
    name: nullableText,
    questionCount: nonNegativeInteger,
  }).strict()),
  affectedChannels: z.array(z.object({
    channel: nullableText,
    questionCount: nonNegativeInteger,
  }).strict()),
}).strict();

export type ContentPlanView = z.infer<typeof contentPlanViewSchema>;
export type ContentPlanProjectionState = z.infer<typeof contentPlanProjectionStateSchema>;
export type ContentPlanTrend = z.infer<typeof contentPlanTrendSchema>;
export type ContentPlanEvidenceStrength = z.infer<typeof contentPlanEvidenceStrengthSchema>;
export type ContentPlanRecommendationAction = z.infer<typeof contentPlanRecommendationActionSchema>;
export type ContentPlanEnrichmentState = z.infer<typeof contentPlanEnrichmentStateSchema>;
export type ContentPlanCorpusState = z.infer<typeof contentPlanCorpusStateSchema>;
export type ContentPlanHeadlineState = z.infer<typeof contentPlanHeadlineStateSchema>;
export type ContentPlanListQuery = z.infer<typeof contentPlanListQuerySchema>;
export type ContentPlanTopicTurnsQuery = z.infer<typeof contentPlanTopicTurnsQuerySchema>;
export type ContentPlanProjection = z.infer<typeof contentPlanProjectionSchema>;
export type ContentPlanSummary = z.infer<typeof contentPlanSummarySchema>;
export type ContentPlanTopicSummary = z.infer<typeof contentPlanTopicSummarySchema>;
export type ContentPlanEmergingQuestion = z.infer<typeof contentPlanEmergingQuestionSchema>;
export type ContentPlanPage = z.infer<typeof contentPlanPageSchema>;
export type ContentPlanTopicDetail = z.infer<typeof contentPlanDetailSchema>;

export interface ContentPlanReadServicePort {
  list(workspaceId: string, query: ContentPlanListQuery): Promise<ContentPlanPage>;
  getTopic(workspaceId: string, topicId: string): Promise<ContentPlanTopicDetail | null>;
  listTopicTurns(
    workspaceId: string,
    topicId: string,
    query: ContentPlanTopicTurnsQuery,
  ): Promise<LowQualityTurnsPage | null>;
}

export * from "./persistence.js";
