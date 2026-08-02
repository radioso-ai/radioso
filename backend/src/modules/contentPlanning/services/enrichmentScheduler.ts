import type {
  ContentPlanEnrichmentState,
  ContentPlanEvidenceStrength,
  ContentPlanRecommendationAction,
} from "../contracts/index.js";

export const CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1 = Object.freeze({
  version: 1 as const,
  debounceMs: 5 * 60 * 1_000,
  generatedBriefCap: 10,
  membershipGrowthRatio: 0.2,
  membershipGrowthFloor: 5,
  maxAttempts: 5,
  initialRetryMs: 60_000,
  maxRetryMs: 6 * 60 * 60 * 1_000,
});

export interface ContentPlanEnrichmentEvidenceSnapshot {
  memberCount: number;
  groundedCount: number;
  degradedCount: number;
  noSupportCount: number;
  notEvaluatedCount: number;
  credibleOpportunity: boolean;
  groundingBand: ContentPlanEvidenceStrength;
  action: ContentPlanRecommendationAction | null;
  /** Content-addressed hash of normalized typed corpus evidence, never document text. */
  corpusEvidenceFingerprint: string | null;
}

export interface ContentPlanPublishedEnrichmentSnapshot
extends ContentPlanEnrichmentEvidenceSnapshot {
  sourceTopicRevision: number;
  analysisMode: ContentPlanEnrichmentAnalysisMode;
  recommendationState: Extract<ContentPlanEnrichmentState, "ready" | "outside_analysis_cap">;
}

export interface ContentPlanEnrichmentSchedulingTopic {
  workspaceId: string;
  generationId: string;
  topicId: string;
  topicRevision: number;
  lifecycle: "provisional" | "mature" | "merged" | "retired";
  current: ContentPlanEnrichmentEvidenceSnapshot;
  lastEnriched: ContentPlanPublishedEnrichmentSnapshot | null;
}

export type ContentPlanEnrichmentAnalysisMode = "label_and_brief" | "label_only";

export interface ContentPlanEnrichmentSourceEvidence {
  memberCount: number;
  groundedCount: number;
  degradedCount: number;
  noSupportCount: number;
  notEvaluatedCount: number;
  credibleOpportunity: boolean;
}

export interface ContentPlanScheduledEnrichmentJob {
  workspaceId: string;
  generationId: string;
  topicId: string;
  sourceTopicRevision: number;
  availableAt: Date;
  analysisMode: ContentPlanEnrichmentAnalysisMode;
  recommendationState: Extract<ContentPlanEnrichmentState, "ready" | "outside_analysis_cap">;
  sourceEvidence: ContentPlanEnrichmentSourceEvidence;
  evidenceStrength: ContentPlanEvidenceStrength;
  sourceCorpusEvidenceFingerprint: string | null;
}

export interface ContentPlanEnrichmentQueuePort {
  queue(input: ContentPlanScheduledEnrichmentJob): Promise<boolean>;
  rebasePublished(input: Omit<ContentPlanScheduledEnrichmentJob, "availableAt">): Promise<boolean>;
}

export const isContentPlanEnrichmentMaterialChange = (
  topic: ContentPlanEnrichmentSchedulingTopic,
): boolean => {
  if (topic.lifecycle !== "mature") return false;
  if (topic.lastEnriched === null) return true;
  const previous = topic.lastEnriched;
  if (topic.current.groundingBand !== previous.groundingBand
    || topic.current.action !== previous.action
    || topic.current.corpusEvidenceFingerprint !== previous.corpusEvidenceFingerprint) {
    return true;
  }
  const growth = topic.current.memberCount - previous.memberCount;
  const materialGrowth = Math.max(
    CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1.membershipGrowthFloor,
    Math.ceil(previous.memberCount
      * CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1.membershipGrowthRatio),
  );
  return growth >= materialGrowth;
};

export class ContentPlanningEnrichmentScheduler {
  constructor(private readonly queue: ContentPlanEnrichmentQueuePort) {}

  async schedule(input: {
    /** Topics must use the canonical backend opportunity order. */
    topics: readonly ContentPlanEnrichmentSchedulingTopic[];
    now: Date;
  }): Promise<{
    queuedCount: number;
    rebasedCount: number;
    staleCount: number;
    failedCount: number;
    jobs: ContentPlanScheduledEnrichmentJob[];
  }> {
    if (!Number.isFinite(input.now.getTime())) {
      throw new Error("content_plan_enrichment_schedule_time_invalid");
    }
    const credibleRank = new Map<string, number>();
    let rank = 0;
    for (const candidate of input.topics) {
      if (candidate.lifecycle === "mature" && candidate.current.credibleOpportunity) {
        rank += 1;
        credibleRank.set(candidate.topicId, rank);
      }
    }

    const jobs: ContentPlanScheduledEnrichmentJob[] = [];
    let queuedCount = 0;
    let rebasedCount = 0;
    let staleCount = 0;
    let failedCount = 0;
    for (const candidate of input.topics) {
      const opportunityRank = credibleRank.get(candidate.topicId) ?? null;
      const receivesBrief = opportunityRank !== null
        && opportunityRank <= CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1.generatedBriefCap;
      const analysisMode = receivesBrief ? "label_and_brief" : "label_only";
      const recommendationState = candidate.current.credibleOpportunity && !receivesBrief
        ? "outside_analysis_cap"
        : "ready";
      const publishedModeChanged = candidate.lifecycle === "mature"
        && candidate.lastEnriched !== null
        && (candidate.lastEnriched.analysisMode !== analysisMode
          || candidate.lastEnriched.recommendationState !== recommendationState);
      if (!isContentPlanEnrichmentMaterialChange(candidate) && !publishedModeChanged) {
        if (candidate.lastEnriched?.sourceTopicRevision !== candidate.topicRevision) {
          try {
            const rebased = await this.queue.rebasePublished({
              workspaceId: candidate.workspaceId,
              generationId: candidate.generationId,
              topicId: candidate.topicId,
              sourceTopicRevision: candidate.topicRevision,
              analysisMode,
              recommendationState,
              sourceEvidence: toSourceEvidence(candidate.current),
              evidenceStrength: candidate.current.groundingBand,
              sourceCorpusEvidenceFingerprint: candidate.current.corpusEvidenceFingerprint,
            });
            if (rebased) rebasedCount += 1;
            else staleCount += 1;
          } catch {
            failedCount += 1;
          }
        }
        continue;
      }
      const job: ContentPlanScheduledEnrichmentJob = {
        workspaceId: candidate.workspaceId,
        generationId: candidate.generationId,
        topicId: candidate.topicId,
        sourceTopicRevision: candidate.topicRevision,
        availableAt: new Date(
          input.now.getTime() + CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1.debounceMs,
        ),
        analysisMode,
        recommendationState,
        sourceEvidence: toSourceEvidence(candidate.current),
        evidenceStrength: candidate.current.groundingBand,
        sourceCorpusEvidenceFingerprint: candidate.current.corpusEvidenceFingerprint,
      };
      jobs.push(job);
      try {
        if (await this.queue.queue(job)) {
          queuedCount += 1;
        } else {
          staleCount += 1;
        }
      } catch {
        failedCount += 1;
      }
    }
    return { queuedCount, rebasedCount, staleCount, failedCount, jobs };
  }
}

const toSourceEvidence = (
  snapshot: ContentPlanEnrichmentEvidenceSnapshot,
): ContentPlanEnrichmentSourceEvidence => ({
  memberCount: snapshot.memberCount,
  groundedCount: snapshot.groundedCount,
  degradedCount: snapshot.degradedCount,
  noSupportCount: snapshot.noSupportCount,
  notEvaluatedCount: snapshot.notEvaluatedCount,
  credibleOpportunity: snapshot.credibleOpportunity,
});

export const resolveContentPlanEnrichmentRetry = (input: {
  attemptCount: number;
  now: Date;
}): { terminal: boolean; availableAt: Date } => {
  if (!Number.isInteger(input.attemptCount) || input.attemptCount < 1
    || !Number.isFinite(input.now.getTime())) {
    throw new Error("content_plan_enrichment_retry_input_invalid");
  }
  if (input.attemptCount >= CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1.maxAttempts) {
    return { terminal: true, availableAt: new Date(input.now) };
  }
  const delay = Math.min(
    CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1.maxRetryMs,
    CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1.initialRetryMs
      * (2 ** (input.attemptCount - 1)),
  );
  return { terminal: false, availableAt: new Date(input.now.getTime() + delay) };
};
