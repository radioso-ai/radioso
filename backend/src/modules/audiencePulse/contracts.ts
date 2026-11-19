import { z } from "zod";

import type { ModelInferencePipeline } from "../../shared/infra/llm/modelInferencePipeline.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import type {
  AudiencePulseStoredReport,
  AudiencePulseWeeklyVolume,
} from "./domain/report.js";
import { AUDIENCE_PULSE_ANSWER_STATUSES } from "./domain/answerStatus.js";
import { AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS } from "./contracts/history.js";
import type {
  AudiencePulseEvidenceAnchor,
  AudiencePulsePromptEvidenceReference,
} from "./contracts/history.js";

export {
  AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS,
  type AudiencePulseHistorySnapshot,
  type AudiencePulseHistorySource,
  type AudiencePulseEvidenceAnchor,
  type AudiencePulseHydratedEvidence,
  type AudiencePulsePromptEvidenceReference,
  type AudiencePulseQuestionOutcome,
} from "./contracts/history.js";

export { AUDIENCE_PULSE_ANSWER_STATUSES };

export const AUDIENCE_PULSE_ANALYSIS_DAYS = 30;

export interface AudiencePulseSnapshotRecord {
  workspaceId: string;
  revision: string;
  period: { start: Date; end: Date };
  generatedAt: Date;
  report: AudiencePulseStoredReport;
  promptEvidenceRefs: AudiencePulsePromptEvidenceReference[];
}

export interface AudiencePulseSnapshotStore {
  find(workspaceId: string): Promise<AudiencePulseSnapshotRecord | null>;
  replace(input: Omit<AudiencePulseSnapshotRecord, "revision">): Promise<AudiencePulseSnapshotRecord>;
  invalidate(input: { workspaceId: string; expectedRevision: string }): Promise<boolean>;
}

export interface AudiencePulseRunLease {
  release(): Promise<void>;
}

export interface AudiencePulseRunGate {
  tryAcquire(workspaceId: string): Promise<AudiencePulseRunLease | null>;
}

export interface AudiencePulseRefreshRateLimitPort {
  enforce(input: { accountId: string; workspaceId: string }): Promise<void>;
}

/**
 * The only facet-processing capability Audience Pulse needs. The facets module owns
 * claiming, retries, model calls, and persistence; Audience Pulse merely asks it to
 * make this workspace's report population ready before running a census.
 */
export interface AudiencePulseFacetDrainPort {
  requestWorkspaceDrain(input: { workspaceId: string; analysisStart: Date; analysisEnd: Date }): Promise<boolean>;
  hasPendingWorkspaceWork(input: { workspaceId: string; analysisStart: Date; analysisEnd: Date }): Promise<boolean>;
}

export interface AudiencePulseInferenceFactory {
  create(input: {
    workspaceContext: { workspaceId: string; accountId?: string | null };
    modelCallContext: ModelCallUsageContext;
  }): Promise<ModelInferencePipeline>;
}

/**
 * How far back a workspace's history reaches: it has nothing from before it was created, and with
 * conversation retention set, older conversations are being swept away.
 */
export interface AudiencePulseHistoryHorizonSource {
  /** Null for a workspace that does not exist. */
  read(workspaceId: string): Promise<{ workspaceCreatedAt: Date; conversationRetentionDays: number | null } | null>;
}

/** An operator's state on one topic, read beside the snapshot rather than stored in it. */
export interface AudiencePulseTopicState {
  /** Set while the operator has marked the topic "not for us". */
  dismissedAt: Date | null;
  /** The newest document drafted from the topic that still exists. */
  latestDraft: { documentId: string; createdAt: Date } | null;
}

export type AudiencePulseTopicStateWrite = "changed" | "unchanged" | "topic_not_found";
export type AudiencePulseTopicDraftLink = AudiencePulseTopicStateWrite | "document_not_found";

/**
 * Operator state on Audience Pulse topics: dismissals and draft links. It lives apart from the
 * overwrite-only snapshot so a refresh keeps it, and goes with the topic, the document or the
 * workspace it names. A write answers `topic_not_found` for a topic outside the workspace.
 */
export interface AudiencePulseTopicStateStore {
  /** Only topics with a dismissal or a draft appear. */
  readTopicStates(input: { workspaceId: string; topicIds: readonly string[] }): Promise<Map<string, AudiencePulseTopicState>>;
  dismiss(input: { workspaceId: string; topicId: string; userId: string }): Promise<AudiencePulseTopicStateWrite>;
  restore(input: { workspaceId: string; topicId: string }): Promise<AudiencePulseTopicStateWrite>;
  linkDraft(input: {
    workspaceId: string;
    topicId: string;
    documentId: string;
    userId: string;
  }): Promise<AudiencePulseTopicDraftLink>;
}

export interface AudiencePulseAuditPort {
  record(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: "success" | "failure";
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

const dateTime = z.string().datetime();
const groundingSchema = z.object({
  grounded: z.number().int().min(0),
  degraded: z.number().int().min(0),
  noSupport: z.number().int().min(0),
  unknown: z.number().int().min(0),
  contentGapEligible: z.number().int().min(0),
});

const answerSummarySchema = z.object({
  answered: z.number().int().min(0),
  partial: z.number().int().min(0),
  unanswered: z.number().int().min(0),
  unclear: z.number().int().min(0),
  outOfScope: z.number().int().min(0),
  notAssessed: z.number().int().min(0),
});

const periodTotalsShape = {
  questionCount: z.number().int().min(0),
  conversationCount: z.number().int().min(0),
  answeredCount: z.number().int().min(0),
  contentGapEligibleCount: z.number().int().min(0),
};

const answerTallyShape = {
  questionCount: z.number().int().min(0),
  answers: answerSummarySchema,
  contentGapEligibleCount: z.number().int().min(0),
};

const topicTransitionSchema = z.object({
  kind: z.enum(["survived", "split", "merged", "emerged", "dissolved"]),
  parentTopicIds: z.array(z.string()),
  viaCentroidFallback: z.boolean(),
  membershipOverlap: z.number().min(0).max(1).nullable(),
});

export const audiencePulseReportResponseSchema = z.object({
  period: z.object({ start: dateTime, end: dateTime }),
  generatedAt: dateTime,
  isFirstCensus: z.boolean(),
  narrativeGeneratedAt: dateTime,
  narrativeReuseCount: z.number().int().min(0),
  narrativeReuseMaxDrift: z.number().min(0).max(1),
  coverage: z.object({
    populationSize: z.number().int().min(0),
    sampleSize: z.number().int().min(0),
    sampled: z.boolean(),
    facetReadyQuestionCount: z.number().int().min(0),
  }),
  weeklyVolume: z.array(z.object({
    weekStart: dateTime,
    visitorQuestionCount: z.number().int().min(0),
    conversationCount: z.number().int().min(0),
  })),
  // Absent when no narrative call ran, which happens when nothing in the window has a
  // current embedded facet yet. Clients read `coverage.facetReadyQuestionCount` to tell
  // that state apart from a computed window that simply found no recurring pattern.
  summary: z.string().optional(),
  unclassifiedQuestionCount: z.number().int().min(0),
  dissolvedTopics: z.array(z.object({ id: z.string(), title: z.string() })),
  themes: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    memberCount: z.number().int().min(0),
    previousMemberCount: z.number().int().min(0).nullable(),
    previousShare: z.number().min(0).max(1).nullable(),
    transition: topicTransitionSchema.nullable(),
    share: z.number().min(0).max(1),
    distinctQuestionCount: z.number().int().min(0),
    weeklyPulse: z.array(z.object({ weekStart: dateTime, count: z.number().int().min(0) })),
    grounding: groundingSchema,
    coverage: z.object({
      answered: z.number().int().min(0),
      partial: z.number().int().min(0),
      unanswered: z.number().int().min(0),
      unclear: z.number().int().min(0),
      unassessed: z.number().int().min(0),
      legacy: z.number().int().min(0),
      reasons: z.record(z.string(), z.number().int().min(0)),
    }).optional(),
    answers: answerSummarySchema,
    evidence: z.array(z.object({
      reference: z.string(),
      conversationId: z.string().uuid(),
      messageId: z.string().uuid(),
      question: z.string().max(AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS),
      questionPhotoCount: z.number().int().min(0),
      occurrenceCount: z.number().int().min(1),
      answerCoverage: z.object({
        availability: z.enum(["assessed", "not_recorded", "failed", "invalid"]),
        coverage: z.enum(["answered", "partial", "unanswered", "unclear"]).optional(),
        reason: z.enum(["sufficient_evidence", "insufficient_evidence", "conflicting_evidence", "ambiguous_request", "intentional_scope_boundary"]).optional(),
      }).optional(),
      answerStatus: z.enum(AUDIENCE_PULSE_ANSWER_STATUSES).optional(),
    })),
  })),
  contentGaps: z.array(z.object({
    themeId: z.string(),
    eligibleEvidenceCount: z.number().int().min(0),
    distinctConversationCount: z.number().int().min(0),
    // Operator state, read at request time: a dismissal changes no count.
    dismissedAt: dateTime.nullable(),
    latestDraft: z.object({ documentId: z.string().uuid(), createdAt: dateTime }).nullable(),
  })),
  recommendations: z.array(z.object({
    id: z.string(),
    themeId: z.string(),
    title: z.string(),
    rationale: z.string(),
    questions: z.array(z.string()),
    evidenceReferences: z.array(z.string()),
    startDraft: z.object({ title: z.string(), questions: z.array(z.string()) }),
  })),
  caveats: z.array(z.string()),
  // Absent from a report saved before they existed.
  totals: z.object({
    ...answerTallyShape,
    conversationCount: z.number().int().min(0),
    unclassified: z.object(answerTallyShape),
  }).optional(),
  dailyVolume: z.array(z.object({ day: z.string().date(), ...periodTotalsShape })).optional(),
  previousPeriod: z.object({ period: z.object({ start: dateTime, end: dateTime }), ...periodTotalsShape }).nullable().optional(),
  channels: z.array(z.object({
    channel: z.string().nullable(),
    questionCount: z.number().int().min(0),
    answeredCount: z.number().int().min(0),
    contentGapEligibleCount: z.number().int().min(0),
  })).optional(),
  previousGeneratedAt: dateTime.nullable().optional(),
});

export type AudiencePulseHydratedReport = z.infer<typeof audiencePulseReportResponseSchema>;

export type AudiencePulseReadResult =
  | { kind: "not_generated" }
  | { kind: "completed"; report: AudiencePulseHydratedReport };

export type AudiencePulseRefreshResult =
  | { kind: "no_traffic"; period: { start: string; end: string }; weeklyVolume: AudiencePulseWeeklyVolume[] }
  | { kind: "preparing" }
  | { kind: "unavailable"; reason: "provider" | "validation" | "census" | "cancelled" }
  | { kind: "busy" }
  | { kind: "usage_limited" }
  | { kind: "completed"; report: AudiencePulseHydratedReport };

export const audiencePulseReadInputSchema = z.object({
  accountId: z.string().uuid(),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
}).strict();

export const audiencePulseRefreshInputSchema = audiencePulseReadInputSchema.extend({
  signal: z.instanceof(AbortSignal).optional(),
}).strict();

export const audiencePulseEvidenceAnchorRequestSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
}).strict();

export const audiencePulseEvidenceAnchorInputSchema = audiencePulseReadInputSchema.extend(
  audiencePulseEvidenceAnchorRequestSchema.shape,
).strict();

export const audiencePulseTopicParamsSchema = z.object({
  topicId: z.string().uuid(),
}).strict();

export const audiencePulseTopicDraftRequestSchema = z.object({
  documentId: z.string().uuid(),
}).strict();

const audiencePulseTopicInputSchema = audiencePulseReadInputSchema.extend(audiencePulseTopicParamsSchema.shape).strict();

const audiencePulseTopicDraftInputSchema = audiencePulseTopicInputSchema.extend(
  audiencePulseTopicDraftRequestSchema.shape,
).strict();

export interface AudiencePulsePort {
  read(input: z.infer<typeof audiencePulseReadInputSchema>): Promise<AudiencePulseReadResult>;
  refresh(input: z.infer<typeof audiencePulseRefreshInputSchema>): Promise<AudiencePulseRefreshResult>;
  refreshStatus(input: z.infer<typeof audiencePulseReadInputSchema>): Promise<{ pending: boolean }>;
  readEvidenceAnchor(
    input: z.infer<typeof audiencePulseEvidenceAnchorInputSchema>,
  ): Promise<AudiencePulseEvidenceAnchor | null>;
  /** Takes a topic out of the "Content to write" queue. Changes no count. */
  dismissTopic(input: z.infer<typeof audiencePulseTopicInputSchema>): Promise<AudiencePulseTopicStateWrite>;
  restoreTopic(input: z.infer<typeof audiencePulseTopicInputSchema>): Promise<AudiencePulseTopicStateWrite>;
  /** Records a document drafted from a topic, so the queue can show it was written. */
  linkTopicDraft(input: z.infer<typeof audiencePulseTopicDraftInputSchema>): Promise<AudiencePulseTopicDraftLink>;
}
