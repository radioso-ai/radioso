import type { ContentPlanGenerationKind } from "../contracts/persistence.js";
import {
  NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY,
  type ContentPlanWorkerEventSink,
  type ContentPlanWorkerProjectionState,
} from "./contentPlanWorkerObservability.js";

export interface ContentPlanningOperationalMetricsSnapshot {
  projectionKind: Extract<ContentPlanGenerationKind, "bootstrap" | "reprojection">;
  projectionState: ContentPlanWorkerProjectionState;
  processedThrough: Date | null;
  processedCount: number | null;
  totalCount: number | null;
  pendingObservationCount: number;
  pendingEmbeddingCount: number;
  pendingAssignmentCount: number;
  pendingEnrichmentCount: number;
  provisionalTopicCount: number;
  matureTopicCount: number;
  mergedTopicCount: number;
}

export interface ContentPlanningOperationalMetricsSourcePort {
  load(input: {
    workspaceId: string;
    generationId: string;
  }): Promise<ContentPlanningOperationalMetricsSnapshot>;
}

/**
 * Converts a workspace-scoped database snapshot into content-free operational
 * telemetry. Source failures are deliberately contained so metrics can never affect
 * projection availability.
 */
export class ContentPlanningOperationalMetricsReporter {
  private readonly clock: () => Date;
  private readonly observability: ContentPlanWorkerEventSink;

  constructor(private readonly dependencies: {
    source: ContentPlanningOperationalMetricsSourcePort;
    observability?: ContentPlanWorkerEventSink;
    clock?: () => Date;
  }) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.observability = dependencies.observability ?? NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY;
  }

  async capture(input: {
    workspaceId: string;
    generationId: string;
  }): Promise<void> {
    let snapshot: ContentPlanningOperationalMetricsSnapshot;
    try {
      snapshot = await this.dependencies.source.load(input);
    } catch {
      this.observability.record({
        stage: "projection_snapshot",
        outcome: "skipped",
        reason: "operational_snapshot_failed",
        workspaceId: input.workspaceId,
        generationId: input.generationId,
      });
      return;
    }

    const now = this.clock();
    const projectionLagSeconds = snapshot.processedThrough === null
      ? undefined
      : Math.max(0, Math.floor((now.getTime() - snapshot.processedThrough.getTime()) / 1_000));
    this.observability.record({
      stage: "projection_snapshot",
      outcome: "completed",
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      projectionKind: snapshot.projectionKind,
      projectionState: snapshot.projectionState,
      ...(snapshot.processedCount === null ? {} : { processedCount: snapshot.processedCount }),
      ...(snapshot.totalCount === null ? {} : { totalCount: snapshot.totalCount }),
      ...(projectionLagSeconds === undefined ? {} : { projectionLagSeconds }),
      pendingObservationCount: snapshot.pendingObservationCount,
      pendingEmbeddingCount: snapshot.pendingEmbeddingCount,
      pendingAssignmentCount: snapshot.pendingAssignmentCount,
      pendingEnrichmentCount: snapshot.pendingEnrichmentCount,
      provisionalTopicCount: snapshot.provisionalTopicCount,
      matureTopicCount: snapshot.matureTopicCount,
      mergedTopicCount: snapshot.mergedTopicCount,
    });
  }
}
