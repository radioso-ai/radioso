import type {
  ContentPlanAffectedTopic,
  ContentPlanObservationRetentionPort,
  ContentPlanProjectionRepositoryPort,
  ContentPlanTopicRepositoryPort,
} from "../contracts/persistence.js";
import type { ContentPlanReconciliationResult } from "./contentPlanReconciliationService.js";
import { ContentPlanReconciliationService } from "./contentPlanReconciliationService.js";
import type { ContentPlanWorkerEventSink } from "./contentPlanWorkerObservability.js";
import type { ContentPlanWorkerOptions } from "./contentPlanWorkerPolicy.js";

export interface ContentPlanRetentionResult extends ContentPlanReconciliationResult {
  expiredPendingContextCount: number;
  deletedCount: number;
  scannedTopicCount: number;
  prunedRedirectCount: number;
  prunedFailedGenerationCount: number;
  prunedSupersededGenerationCount: number;
  retentionFailureCount: number;
}

export class ContentPlanRetentionService {
  constructor(private readonly dependencies: {
    retention: ContentPlanObservationRetentionPort;
    generationRetention: Pick<ContentPlanProjectionRepositoryPort, "pruneExpiredGenerations">;
    topics: Pick<
      ContentPlanTopicRepositoryPort,
      "findTopicsNeedingReconciliation" | "pruneExpiredRedirects"
    >;
    reconciliation: ContentPlanReconciliationService;
    observability: ContentPlanWorkerEventSink;
    clock: () => Date;
    options: Pick<
      ContentPlanWorkerOptions,
      | "retentionBatchSize"
      | "retentionDays"
      | "failedGenerationRetentionDays"
      | "supersededGenerationRetentionDays"
    >;
  }) {}

  async runOnce(input: { workspaceId: string }): Promise<ContentPlanRetentionResult> {
    const now = this.dependencies.clock();
    const observedBefore = new Date(
      now.getTime() - this.dependencies.options.retentionDays * 24 * 60 * 60 * 1_000,
    );
    let deletedCount = 0;
    let expiredPendingContextCount = 0;
    let retentionFailureCount = 0;
    let affectedTopics: ContentPlanAffectedTopic[] = [];
    try {
      expiredPendingContextCount = await this.dependencies.retention.expirePendingContexts({
        workspaceId: input.workspaceId,
        now,
        limit: this.dependencies.options.retentionBatchSize,
      });
    } catch {
      retentionFailureCount += 1;
      this.dependencies.observability.record({
        stage: "retention",
        outcome: "retry_scheduled",
        reason: "retention_repository_failed",
        workspaceId: input.workspaceId,
      });
    }
    try {
      const pruned = await this.dependencies.retention.pruneExpiredObservations({
        workspaceId: input.workspaceId,
        observedBefore,
        limit: this.dependencies.options.retentionBatchSize,
      });
      deletedCount = pruned.deletedCount;
      affectedTopics = pruned.affectedTopics;
    } catch {
      retentionFailureCount += 1;
      this.dependencies.observability.record({
        stage: "retention",
        outcome: "retry_scheduled",
        reason: "retention_repository_failed",
        workspaceId: input.workspaceId,
      });
    }

    let scannedTopics: ContentPlanAffectedTopic[] = [];
    try {
      scannedTopics = await this.dependencies.topics.findTopicsNeedingReconciliation({
        workspaceId: input.workspaceId,
        limit: this.dependencies.options.retentionBatchSize,
      });
    } catch {
      retentionFailureCount += 1;
      this.dependencies.observability.record({
        stage: "reconciliation",
        outcome: "retry_scheduled",
        reason: "reconciliation_repository_failed",
        workspaceId: input.workspaceId,
      });
    }

    let prunedRedirectCount = 0;
    try {
      prunedRedirectCount = await this.dependencies.topics.pruneExpiredRedirects({
        workspaceId: input.workspaceId,
        now,
        limit: this.dependencies.options.retentionBatchSize,
      });
    } catch {
      retentionFailureCount += 1;
      this.dependencies.observability.record({
        stage: "retention",
        outcome: "retry_scheduled",
        reason: "retention_repository_failed",
        workspaceId: input.workspaceId,
      });
    }

    const reconciliation = await this.dependencies.reconciliation.reconcileAffected([
      ...affectedTopics,
      ...scannedTopics,
    ]);
    let prunedFailedGenerationCount = 0;
    let prunedSupersededGenerationCount = 0;
    try {
      const pruned = await this.dependencies.generationRetention.pruneExpiredGenerations({
        workspaceId: input.workspaceId,
        failedBefore: new Date(
          now.getTime()
            - this.dependencies.options.failedGenerationRetentionDays * 24 * 60 * 60 * 1_000,
        ),
        supersededBefore: new Date(
          now.getTime()
            - this.dependencies.options.supersededGenerationRetentionDays * 24 * 60 * 60 * 1_000,
        ),
        limit: this.dependencies.options.retentionBatchSize,
      });
      prunedFailedGenerationCount = pruned.failedCount;
      prunedSupersededGenerationCount = pruned.supersededCount;
      this.dependencies.observability.record({
        stage: "generation_retention",
        outcome: "completed",
        workspaceId: input.workspaceId,
        itemCount: pruned.failedCount + pruned.supersededCount,
      });
    } catch {
      retentionFailureCount += 1;
      this.dependencies.observability.record({
        stage: "generation_retention",
        outcome: "retry_scheduled",
        reason: "generation_retention_repository_failed",
        workspaceId: input.workspaceId,
      });
    }
    this.dependencies.observability.record({
      stage: "retention",
      outcome: retentionFailureCount > 0 ? "retry_scheduled" : "completed",
      ...(retentionFailureCount > 0 ? { reason: "retention_repository_failed" as const } : {}),
      workspaceId: input.workspaceId,
      itemCount: deletedCount + expiredPendingContextCount,
    });
    return {
      expiredPendingContextCount,
      deletedCount,
      scannedTopicCount: scannedTopics.length,
      prunedRedirectCount,
      prunedFailedGenerationCount,
      prunedSupersededGenerationCount,
      retentionFailureCount,
      ...reconciliation,
    };
  }
}
