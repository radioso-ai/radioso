import { randomUUID } from "node:crypto";

import type {
  ContentPlanAffectedTopic,
  ContentPlanObservationRetentionPort,
  ContentPlanObservationVectorRecord,
  ContentPlanObservationWorkPort,
  ContentPlanTopicRepositoryPort,
} from "./contracts/persistence.js";
import {
  ContentPlanAssignmentProcessor,
  type ContentPlanAssignmentResult,
  type ContentPlanAssignmentTopicPort,
} from "./services/contentPlanAssignmentProcessor.js";
import { ContentPlanClaimFailureService } from "./services/contentPlanClaimFailureService.js";
import {
  ContentPlanEmbeddingProcessor,
  type ContentPlanEmbeddingBatchResult,
  type ContentPlanFallbackEmbeddingBudgetPort,
  type ContentPlanProjectionEmbeddingPort,
  type ContentPlanSemanticSourceLoaderPort,
} from "./services/contentPlanEmbeddingProcessor.js";
import {
  ContentPlanReconciliationService,
  type ContentPlanReconciliationResult,
} from "./services/contentPlanReconciliationService.js";
import {
  ContentPlanRetentionService,
  type ContentPlanRetentionResult,
} from "./services/contentPlanRetentionService.js";
import {
  ContentPlanningWorkerObservability,
  NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY,
  type ContentPlanWorkerEvent,
  type ContentPlanWorkerEventSink,
  type ContentPlanWorkerFailureReason,
  type ContentPlanWorkerOutcome,
  type ContentPlanWorkerStage,
} from "./services/contentPlanWorkerObservability.js";
import {
  CONTENT_PLAN_WORKER_POLICY_V1,
  isContentPlanClaimActive,
  resolveContentPlanWorkerOptions,
  type ContentPlanWorkerOptions,
  type ContentPlanWorkerOptionsInput,
} from "./services/contentPlanWorkerPolicy.js";

export {
  CONTENT_PLAN_WORKER_POLICY_V1,
  ContentPlanningWorkerObservability,
};
export type {
  ContentPlanFallbackEmbeddingBudgetPort,
  ContentPlanProjectionEmbeddingPort,
  ContentPlanReconciliationResult,
  ContentPlanRetentionResult,
  ContentPlanSemanticSourceLoaderPort,
  ContentPlanWorkerEvent,
  ContentPlanWorkerEventSink,
  ContentPlanWorkerFailureReason,
  ContentPlanWorkerOptions,
  ContentPlanWorkerOptionsInput,
  ContentPlanWorkerOutcome,
  ContentPlanWorkerStage,
};

export interface ContentPlanningWorkerDependencies {
  observationWork: ContentPlanObservationWorkPort;
  semanticSources: ContentPlanSemanticSourceLoaderPort;
  embeddings: ContentPlanProjectionEmbeddingPort;
  topics: ContentPlanWorkerTopicPort;
  retention: ContentPlanObservationRetentionPort;
  budget?: ContentPlanFallbackEmbeddingBudgetPort;
  observability?: ContentPlanWorkerEventSink;
  clock?: () => Date;
  createTopicId?: () => string;
  options?: ContentPlanWorkerOptionsInput;
}

export type ContentPlanWorkerTopicPort = ContentPlanAssignmentTopicPort & Pick<
  ContentPlanTopicRepositoryPort,
  | "loadReconciliationEvidence"
  | "reconcileTopic"
  | "resolveTopicRedirect"
  | "findTopicsNeedingReconciliation"
  | "pruneExpiredRedirects"
>;

export interface ContentPlanWorkerBatchResult {
  claimedCount: number;
  embeddedCount: number;
  assignedCount: number;
  createdTopicCount: number;
  maturedTopicCount: number;
  retryCount: number;
  terminalFailureCount: number;
  staleClaimCount: number;
  budgetPausedCount: number;
  claimFailureCount: number;
}

const emptyBatchResult = (): ContentPlanWorkerBatchResult => ({
  claimedCount: 0,
  embeddedCount: 0,
  assignedCount: 0,
  createdTopicCount: 0,
  maturedTopicCount: 0,
  retryCount: 0,
  terminalFailureCount: 0,
  staleClaimCount: 0,
  budgetPausedCount: 0,
  claimFailureCount: 0,
});

/**
 * Bounded projection processor. Runtime polling, bootstrap discovery, budget-window
 * lifecycle, and start/stop ownership remain application-composition concerns.
 */
export class ContentPlanningWorker {
  private readonly clock: () => Date;
  private readonly observability: ContentPlanWorkerEventSink;
  private readonly options: ContentPlanWorkerOptions;
  private readonly embedding: ContentPlanEmbeddingProcessor;
  private readonly assignment: ContentPlanAssignmentProcessor;
  private readonly reconciliation: ContentPlanReconciliationService;
  private readonly retention: ContentPlanRetentionService;

  constructor(private readonly dependencies: ContentPlanningWorkerDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.observability = dependencies.observability ?? NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY;
    this.options = resolveContentPlanWorkerOptions(dependencies.options);
    const failures = new ContentPlanClaimFailureService({
      observationWork: dependencies.observationWork,
      observability: this.observability,
      clock: this.clock,
      options: this.options,
    });
    this.embedding = new ContentPlanEmbeddingProcessor({
      observationWork: dependencies.observationWork,
      semanticSources: dependencies.semanticSources,
      embeddings: dependencies.embeddings,
      budget: dependencies.budget,
      failures,
      observability: this.observability,
      clock: this.clock,
      options: this.options,
    });
    this.assignment = new ContentPlanAssignmentProcessor({
      topics: dependencies.topics,
      failures,
      observability: this.observability,
      clock: this.clock,
      createTopicId: dependencies.createTopicId ?? randomUUID,
      options: this.options,
    });
    this.reconciliation = new ContentPlanReconciliationService({
      topics: dependencies.topics,
      observability: this.observability,
      clock: this.clock,
      options: this.options,
    });
    this.retention = new ContentPlanRetentionService({
      retention: dependencies.retention,
      topics: dependencies.topics,
      reconciliation: this.reconciliation,
      observability: this.observability,
      clock: this.clock,
      options: this.options,
    });
  }

  async runOnce(input: {
    workspaceId?: string;
    generationId?: string;
  } = {}): Promise<ContentPlanWorkerBatchResult> {
    const result = emptyBatchResult();
    const now = this.clock();
    let claimed: ContentPlanObservationVectorRecord[];
    try {
      claimed = await this.dependencies.observationWork.claimVectorBatch({
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.generationId ? { generationId: input.generationId } : {}),
        limit: this.options.embeddingBatchSize,
        now,
        leaseMs: this.options.leaseMs,
      });
    } catch {
      result.claimFailureCount = 1;
      this.observability.record({
        stage: "claim",
        outcome: "retry_scheduled",
        reason: "claim_repository_failed",
        workspaceId: input.workspaceId,
        generationId: input.generationId,
      });
      return result;
    }

    const unique = distinctClaims(claimed);
    result.claimedCount = unique.length;
    this.observability.record({
      stage: "claim",
      outcome: "claimed",
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      itemCount: unique.length,
    });
    const active: ContentPlanObservationVectorRecord[] = [];
    for (const record of unique) {
      if (record.state !== "processing" || !record.claimToken) {
        result.staleClaimCount += 1;
        this.recordInvalidClaim(record, record.claimToken ? "invalid_claim_state" : "missing_claim_token");
        continue;
      }
      if (!isContentPlanClaimActive(record, this.clock())) {
        result.staleClaimCount += 1;
        this.recordInvalidClaim(record, "lease_expired");
        continue;
      }
      active.push(record);
    }

    const awaitingEmbedding: ContentPlanObservationVectorRecord[] = [];
    for (const record of active) {
      if (record.embedding === null) {
        awaitingEmbedding.push(record);
        continue;
      }
      const assignmentResult = await this.assignment.process(record);
      addAssignmentResult(result, assignmentResult);
    }
    if (awaitingEmbedding.length > 0) {
      const embeddingResult = await this.embedding.process(awaitingEmbedding);
      addEmbeddingResult(result, embeddingResult);
    }
    return result;
  }

  runRetentionOnce(input: { workspaceId: string }): Promise<ContentPlanRetentionResult> {
    return this.retention.runOnce(input);
  }

  reconcileAffectedTopics(
    affected: readonly ContentPlanAffectedTopic[],
  ): Promise<ContentPlanReconciliationResult> {
    return this.reconciliation.reconcileAffected(affected);
  }

  private recordInvalidClaim(
    record: ContentPlanObservationVectorRecord,
    reason: "invalid_claim_state" | "lease_expired" | "missing_claim_token",
  ): void {
    this.observability.record({
      stage: "claim",
      outcome: "stale",
      reason,
      workspaceId: record.workspaceId,
      generationId: record.generationId,
      observationId: record.observationId,
      attemptCount: record.attemptCount,
    });
  }
}

const distinctClaims = (
  records: readonly ContentPlanObservationVectorRecord[],
): ContentPlanObservationVectorRecord[] => {
  const seen = new Set<string>();
  const unique: ContentPlanObservationVectorRecord[] = [];
  for (const record of records) {
    const key = `${record.workspaceId}\u0000${record.observationId}\u0000${record.generationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  return unique;
};

const addAssignmentResult = (
  target: ContentPlanWorkerBatchResult,
  source: ContentPlanAssignmentResult,
): void => {
  target.assignedCount += source.assignedCount;
  target.createdTopicCount += source.createdTopicCount;
  target.maturedTopicCount += source.maturedTopicCount;
  target.retryCount += source.retryCount;
  target.terminalFailureCount += source.terminalFailureCount;
  target.staleClaimCount += source.staleClaimCount;
};

const addEmbeddingResult = (
  target: ContentPlanWorkerBatchResult,
  source: ContentPlanEmbeddingBatchResult,
): void => {
  target.embeddedCount += source.embeddedCount;
  target.retryCount += source.retryCount;
  target.terminalFailureCount += source.terminalFailureCount;
  target.staleClaimCount += source.staleClaimCount;
  target.budgetPausedCount += source.budgetPausedCount;
};
