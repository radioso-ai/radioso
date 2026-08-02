import type {
  QualityContentPlanningEvidenceSourcePort,
  QualityContentPlanningTurnEvidence,
} from "../../quality/contracts/contentPlanningEvidence.js";
import type { ContentPlanProjection } from "../contracts/index.js";
import { resolveContentPlanWindows } from "../domain/aggregationPolicy.js";
import type {
  ContentPlanReadSourcePort,
  ContentPlanReportReadData,
} from "../infra/contentPlanReadSource.js";
import { presentContentPlanReport } from "./contentPlanPresenter.js";
import { contentPlanCorpusEvidenceFingerprint } from "./enrichmentContextService.js";
import {
  NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY,
  type ContentPlanWorkerEventSink,
} from "./contentPlanWorkerObservability.js";
import {
  ContentPlanningEnrichmentScheduler,
  type ContentPlanEnrichmentSchedulingTopic,
} from "./enrichmentScheduler.js";

const QUALITY_EVIDENCE_BATCH_SIZE = 500;
const DIRTY_TOPIC_BATCH_SIZE = 100;

export interface ContentPlanEnrichmentDirtyMarker {
  topicId: string;
  revision: number;
  dirtyAt: Date;
}

export interface ContentPlanEnrichmentTriggerPort {
  listDirtyTopics(input: {
    workspaceId: string;
    generationId: string;
    limit: number;
  }): Promise<ContentPlanEnrichmentDirtyMarker[]>;
  acknowledgeDirtyTopics(input: {
    workspaceId: string;
    generationId: string;
    markers: readonly ContentPlanEnrichmentDirtyMarker[];
  }): Promise<number>;
  invalidateWorkspaceCorpusEvidence(input: {
    workspaceId: string;
    dirtyAt: Date;
  }): Promise<number>;
}

export interface ContentPlanEnrichmentPlanningSourcePort {
  load(input: {
    workspaceId: string;
    generationId: string;
    asOf: Date;
  }): Promise<ContentPlanEnrichmentSchedulingTopic[]>;
}

export class ContentPlanReportEnrichmentPlanningSource
implements ContentPlanEnrichmentPlanningSourcePort {
  constructor(private readonly dependencies: {
    source: ContentPlanReadSourcePort;
    qualityEvidence: Pick<QualityContentPlanningEvidenceSourcePort, "getEvidenceByAssistantMessageIds">;
  }) {}

  async load(input: {
    workspaceId: string;
    generationId: string;
    asOf: Date;
  }): Promise<ContentPlanEnrichmentSchedulingTopic[]> {
    const windows = resolveContentPlanWindows(input.asOf);
    const data = await this.dependencies.source.getReportData(
      input.workspaceId,
      input.generationId,
      { from: windows.comparison.from, to: windows.current.to },
    );
    const evidence = await this.loadEvidence(
      input.workspaceId,
      data.observations.map((observation) => observation.sourceAssistantMessageId),
    );
    const report = presentContentPlanReport({
      asOf: input.asOf,
      projection: EMPTY_PROJECTION,
      data,
      evidenceByAssistantMessageId: evidence,
    });
    return toSchedulingTopics(input, data, report.topics);
  }

  private async loadEvidence(workspaceId: string, assistantMessageIds: string[]) {
    const unique = [...new Set(assistantMessageIds)];
    const combined = new Map<string, QualityContentPlanningTurnEvidence>();
    for (let offset = 0; offset < unique.length; offset += QUALITY_EVIDENCE_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + QUALITY_EVIDENCE_BATCH_SIZE);
      const evidence = await this.dependencies.qualityEvidence
        .getEvidenceByAssistantMessageIds(workspaceId, batch);
      for (const [assistantMessageId, value] of evidence) {
        combined.set(assistantMessageId, value);
      }
    }
    return combined;
  }
}

export class ContentPlanningEnrichmentPlanningService {
  private readonly clock: () => Date;
  private readonly observability: ContentPlanWorkerEventSink;

  constructor(private readonly dependencies: {
    source: ContentPlanEnrichmentPlanningSourcePort;
    scheduler: ContentPlanningEnrichmentScheduler;
    trigger: Pick<ContentPlanEnrichmentTriggerPort, "listDirtyTopics" | "acknowledgeDirtyTopics">;
    observability?: ContentPlanWorkerEventSink;
    clock?: () => Date;
  }) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.observability = dependencies.observability ?? NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY;
  }

  async runOnce(input: {
    workspaceId: string;
    generationId: string;
    forceRepair?: boolean;
  }) {
    const startedAt = Date.now();
    try {
      return await this.runOnceInternal(input, startedAt);
    } catch (error) {
      this.observability.record({
        stage: "enrichment_schedule",
        outcome: "retry_scheduled",
        reason: "enrichment_schedule_failed",
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      throw error;
    }
  }

  private async runOnceInternal(input: {
    workspaceId: string;
    generationId: string;
    forceRepair?: boolean;
  }, startedAt: number) {
    const now = this.clock();
    const dirtyMarkers = await this.dependencies.trigger.listDirtyTopics({
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      limit: DIRTY_TOPIC_BATCH_SIZE,
    });
    if (dirtyMarkers.length === 0 && !input.forceRepair) {
      this.observability.record({
        stage: "enrichment_schedule",
        outcome: "skipped",
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        itemCount: 0,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      return { kind: "skipped" as const, dirtyTopicCount: 0 };
    }
    const topics = await this.dependencies.source.load({ ...input, asOf: now });
    const scheduled = await this.dependencies.scheduler.schedule({ topics, now });
    const acknowledgedDirtyTopicCount = scheduled.failedCount === 0 && dirtyMarkers.length > 0
      ? await this.dependencies.trigger.acknowledgeDirtyTopics({
          workspaceId: input.workspaceId,
          generationId: input.generationId,
          markers: dirtyMarkers,
        })
      : 0;
    this.observability.record({
      stage: "enrichment_schedule",
      outcome: scheduled.failedCount > 0 ? "retry_scheduled" : "completed",
      ...(scheduled.failedCount > 0 ? { reason: "enrichment_schedule_failed" as const } : {}),
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      itemCount: scheduled.queuedCount,
      durationMs: Math.max(0, Date.now() - startedAt),
      matureTopicCount: topics.length,
      pendingEnrichmentCount: scheduled.jobs.length,
    });
    return {
      kind: "planned" as const,
      dirtyTopicCount: dirtyMarkers.length,
      acknowledgedDirtyTopicCount,
      ...scheduled,
    };
  }
}

const toSchedulingTopics = (
  input: { workspaceId: string; generationId: string },
  data: ContentPlanReportReadData,
  topics: ReturnType<typeof presentContentPlanReport>["topics"],
): ContentPlanEnrichmentSchedulingTopic[] => {
  const sourceTopics = new Map(data.topics.map((topic) => [topic.id, topic]));
  const documentsByTopic = new Map<string, ContentPlanReportReadData["documents"]>();
  for (const document of data.documents) {
    const documents = documentsByTopic.get(document.topicId) ?? [];
    documents.push(document);
    documentsByTopic.set(document.topicId, documents);
  }
  return topics.flatMap((presented) => {
    const source = sourceTopics.get(presented.summary.id);
    if (!source || source.lifecycle !== "mature") return [];
    const documents = documentsByTopic.get(source.id) ?? [];
    const corpusEvidenceFingerprint = contentPlanCorpusEvidenceFingerprint({
      state: source.enrichment.corpusState,
      documents: documents.map((document) => ({
        id: document.id,
        updatedAt: document.updatedAt,
        possibleRelevance: document.possibleRelevance,
        evidence: {
          existedBeforeGap: document.existedBeforeGap,
          retrievedByGapAnswers: document.retrievedByGapAnswers,
          citedByGapAnswers: document.citedByGapAnswers,
          changedAfterGap: document.changedAfterGap,
        },
      })),
    });
    const publishedEvidence = source.enrichment.publishedSourceEvidence;
    const publishedStrength = source.enrichment.publishedSourceEvidenceStrength;
    const publishedAnalysisMode = hasPublishedContentBrief(source.enrichment)
      ? "label_and_brief"
      : "label_only";
    return [{
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      topicId: source.id,
      topicRevision: source.revision,
      lifecycle: "mature" as const,
      current: {
        memberCount: presented.summary.demand.currentQuestionCount,
        groundedCount: presented.summary.grounding.groundedAnswerCount,
        degradedCount: presented.summary.grounding.degradedAnswerCount,
        noSupportCount: presented.summary.grounding.noSupportAnswerCount,
        notEvaluatedCount: presented.summary.grounding.notEvaluatedAnswerCount,
        credibleOpportunity: presented.summary.opportunity.credible,
        groundingBand: presented.summary.evidence.strength,
        action: presented.summary.recommendation.action,
        corpusEvidenceFingerprint,
      },
      lastEnriched: publishedEvidence && publishedStrength
        ? {
            ...publishedEvidence,
            groundingBand: publishedStrength,
            action: source.enrichment.persistedAction,
            corpusEvidenceFingerprint: source.enrichment.publishedSourceCorpusEvidenceFingerprint,
            analysisMode: publishedAnalysisMode,
            recommendationState: publishedEvidence.credibleOpportunity
              && publishedAnalysisMode === "label_only"
              ? "outside_analysis_cap"
              : "ready",
          }
        : null,
    }];
  });
};

const hasPublishedContentBrief = (
  enrichment: ContentPlanReportReadData["topics"][number]["enrichment"],
): boolean => enrichment.suggestedTitle !== null
  && enrichment.rationale !== null
  && Array.isArray(enrichment.questionsToAnswer)
  && enrichment.questionsToAnswer.length >= 3
  && enrichment.suggestedShape !== null
  && enrichment.evidenceStatement !== null;

const EMPTY_PROJECTION: ContentPlanProjection = {
  state: "ready",
  processedThrough: null,
  processingLagSeconds: null,
  pendingEmbeddingCount: 0,
  pendingAssignmentCount: 0,
  pendingEnrichmentTopicCount: 0,
  processedCount: null,
  totalCount: null,
  embeddingSpaceFingerprint: null,
  reason: null,
};
