import type {
  QualityContentPlanningEvidenceSourcePort,
} from "../../quality/contracts/contentPlanningEvidence.js";
import { resolveContentPlanWindows } from "../domain/aggregationPolicy.js";
import type {
  ContentPlanReadDocument,
  ContentPlanReadTopic,
} from "../infra/contentPlanReadSource.js";
import {
  NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY,
  type ContentPlanWorkerEventSink,
} from "./contentPlanWorkerObservability.js";
import {
  ContentPlanningEnrichmentScheduler,
  type ContentPlanEnrichmentSchedulingTopic,
} from "./enrichmentScheduler.js";
import {
  ContentPlanEnrichmentPlanningAccumulator,
  type ContentPlanEnrichmentPlanningObservation,
} from "./enrichmentPlanningAccumulator.js";

const QUALITY_EVIDENCE_BATCH_SIZE = 500;
const DIRTY_TOPIC_BATCH_SIZE = 100;
const REPAIR_TOPIC_BATCH_SIZE = 100;

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
}

export interface ContentPlanEnrichmentPlanningSourcePort {
  load(input: {
    workspaceId: string;
    generationId: string;
    asOf: Date;
    dirtyTopicIds: readonly string[];
    repair: { limit: number } | null;
  }): Promise<{
    topics: ContentPlanEnrichmentSchedulingTopic[];
    repairCheckpoint: ContentPlanEnrichmentRepairCheckpoint | null;
  }>;
  completeRepairPage(input: {
    workspaceId: string;
    generationId: string;
    checkpoint: ContentPlanEnrichmentRepairCheckpoint;
  }): Promise<boolean>;
}

export interface ContentPlanEnrichmentRepairCheckpoint {
  expectedVersion: number;
  nextTopicId: string | null;
}

export interface ContentPlanEnrichmentObservationCursor {
  observedAt: string;
  observationId: string;
}

export interface ContentPlanEnrichmentPlanningDataSourcePort {
  loadData(input: {
    workspaceId: string;
    generationId: string;
    window: { from: string; to: string };
    dirtyTopicIds: readonly string[];
    repair: { limit: number } | null;
  }): Promise<{
    topics: ContentPlanReadTopic[];
    documents: ContentPlanReadDocument[];
    repairCheckpoint: ContentPlanEnrichmentRepairCheckpoint | null;
  }>;
  pageObservations(input: {
    workspaceId: string;
    generationId: string;
    window: { from: string; to: string };
    topicIds: readonly string[];
    cursor: ContentPlanEnrichmentObservationCursor | null;
    limit: number;
  }): Promise<{
    items: ContentPlanEnrichmentPlanningObservation[];
    nextCursor: ContentPlanEnrichmentObservationCursor | null;
  }>;
  completeRepairPage(input: {
    workspaceId: string;
    generationId: string;
    checkpoint: ContentPlanEnrichmentRepairCheckpoint;
  }): Promise<boolean>;
}

export class ContentPlanReportEnrichmentPlanningSource
implements ContentPlanEnrichmentPlanningSourcePort {
  constructor(private readonly dependencies: {
    source: ContentPlanEnrichmentPlanningDataSourcePort;
    qualityEvidence: Pick<QualityContentPlanningEvidenceSourcePort, "getEvidenceByAssistantMessageIds">;
  }) {}

  async load(input: {
    workspaceId: string;
    generationId: string;
    asOf: Date;
    dirtyTopicIds: readonly string[];
    repair: { limit: number } | null;
  }): Promise<{
    topics: ContentPlanEnrichmentSchedulingTopic[];
    repairCheckpoint: ContentPlanEnrichmentRepairCheckpoint | null;
  }> {
    const windows = resolveContentPlanWindows(input.asOf);
    const batch = await this.dependencies.source.loadData({
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      window: { from: windows.comparison.from, to: windows.current.to },
      dirtyTopicIds: input.dirtyTopicIds,
      repair: input.repair,
    });
    const accumulator = new ContentPlanEnrichmentPlanningAccumulator({
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      asOf: input.asOf,
      topics: batch.topics,
      documents: batch.documents,
    });
    if (batch.topics.length === 0) {
      return { topics: [], repairCheckpoint: batch.repairCheckpoint };
    }
    let cursor: ContentPlanEnrichmentObservationCursor | null = null;
    do {
      const page = await this.dependencies.source.pageObservations({
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        window: { from: windows.comparison.from, to: windows.current.to },
        topicIds: batch.topics.map((topic) => topic.id),
        cursor,
        limit: QUALITY_EVIDENCE_BATCH_SIZE,
      });
      const evidence = await this.dependencies.qualityEvidence.getEvidenceByAssistantMessageIds(
        input.workspaceId,
        page.items.map((observation) => observation.sourceAssistantMessageId),
      );
      accumulator.addPage(page.items, evidence);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return {
      topics: accumulator.finish(),
      repairCheckpoint: batch.repairCheckpoint,
    };
  }

  completeRepairPage(input: {
    workspaceId: string;
    generationId: string;
    checkpoint: ContentPlanEnrichmentRepairCheckpoint;
  }): Promise<boolean> {
    return this.dependencies.source.completeRepairPage(input);
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
    const repair = input.forceRepair
      ? { limit: REPAIR_TOPIC_BATCH_SIZE }
      : null;
    const batch = await this.dependencies.source.load({
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      asOf: now,
      dirtyTopicIds: dirtyMarkers.map((marker) => marker.topicId),
      repair,
    });
    const scheduled = await this.dependencies.scheduler.schedule({ topics: batch.topics, now });
    const acknowledgedDirtyTopicCount = scheduled.failedCount === 0 && dirtyMarkers.length > 0
      ? await this.dependencies.trigger.acknowledgeDirtyTopics({
          workspaceId: input.workspaceId,
          generationId: input.generationId,
          markers: dirtyMarkers,
        })
      : 0;
    if (input.forceRepair && scheduled.failedCount === 0 && batch.repairCheckpoint) {
      await this.dependencies.source.completeRepairPage({
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        checkpoint: batch.repairCheckpoint,
      });
    }
    this.observability.record({
      stage: "enrichment_schedule",
      outcome: scheduled.failedCount > 0 ? "retry_scheduled" : "completed",
      ...(scheduled.failedCount > 0 ? { reason: "enrichment_schedule_failed" as const } : {}),
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      itemCount: scheduled.queuedCount + scheduled.rebasedCount,
      durationMs: Math.max(0, Date.now() - startedAt),
      matureTopicCount: batch.topics.length,
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
