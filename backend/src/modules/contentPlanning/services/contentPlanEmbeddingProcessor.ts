import type {
  ContentPlanObservationVectorRecord,
  ContentPlanObservationWorkPort,
  ContentPlanProjectionBudgetPort,
} from "../contracts/persistence.js";
import type { ObservationSemanticSourceBatch } from "./observationSourceLoader.js";
import type { ContentPlanClaimFailureDisposition } from "./contentPlanClaimFailureService.js";
import { ContentPlanClaimFailureService } from "./contentPlanClaimFailureService.js";
import type {
  ContentPlanWorkerEventSink,
  ContentPlanWorkerFailureReason,
} from "./contentPlanWorkerObservability.js";
import {
  isContentPlanClaimActive,
  isValidContentPlanVector,
  type ContentPlanWorkerOptions,
} from "./contentPlanWorkerPolicy.js";

export interface ContentPlanProjectionEmbeddingPort {
  embedForProjection(input: {
    workspaceId: string;
    generationId: string;
    embeddingSpaceId: string;
    texts: readonly string[];
  }): Promise<{
    embeddingSpaceId: string;
    vectors: readonly number[][];
  }>;
}

export type ContentPlanFallbackEmbeddingBudgetPort = ContentPlanProjectionBudgetPort;

export interface ContentPlanSemanticSourceLoaderPort {
  load(input: {
    workspaceId: string;
    observationIds: readonly string[];
  }): Promise<ObservationSemanticSourceBatch>;
}

export interface ContentPlanEmbeddingBatchResult {
  embeddedCount: number;
  retryCount: number;
  terminalFailureCount: number;
  staleClaimCount: number;
  budgetPausedCount: number;
}

const emptyResult = (): ContentPlanEmbeddingBatchResult => ({
  embeddedCount: 0,
  retryCount: 0,
  terminalFailureCount: 0,
  staleClaimCount: 0,
  budgetPausedCount: 0,
});

export class ContentPlanEmbeddingProcessor {
  constructor(private readonly dependencies: {
    observationWork: Pick<
      ContentPlanObservationWorkPort,
      "storeClaimedEmbedding" | "failVectorClaim"
    >;
    semanticSources: ContentPlanSemanticSourceLoaderPort;
    embeddings: ContentPlanProjectionEmbeddingPort;
    budget?: ContentPlanFallbackEmbeddingBudgetPort;
    failures: ContentPlanClaimFailureService;
    observability: ContentPlanWorkerEventSink;
    clock: () => Date;
    options: ContentPlanWorkerOptions;
  }) {}

  async process(records: readonly ContentPlanObservationVectorRecord[]): Promise<ContentPlanEmbeddingBatchResult> {
    const result = emptyResult();
    const byWorkspace = groupBy(records, (record) => record.workspaceId);
    for (const [workspaceId, workspaceRecords] of byWorkspace) {
      let sources: ObservationSemanticSourceBatch;
      try {
        sources = await this.dependencies.semanticSources.load({
          workspaceId,
          observationIds: workspaceRecords.map((record) => record.observationId),
        });
      } catch {
        for (const record of workspaceRecords) {
          addDisposition(result, await this.dependencies.failures.settle({
            record,
            stage: "source",
            reason: "source_load_failed",
          }));
        }
        continue;
      }

      const resolutions = new Map(sources.items.map((item) => [item.observationId, item.resolution]));
      const resolved: Array<{ record: ContentPlanObservationVectorRecord; semanticText: string }> = [];
      for (const record of workspaceRecords) {
        const resolution = resolutions.get(record.observationId);
        if (!resolution || resolution.status === "unavailable") {
          const reason = resolution
            ? mapSourceFailureReason(resolution.reason)
            : "source_unavailable";
          addDisposition(result, await this.dependencies.failures.settle({
            record,
            stage: "source",
            reason,
            permanent: true,
          }));
          continue;
        }
        resolved.push({ record, semanticText: resolution.semanticText });
      }

      const projectionGroups = groupBy(
        resolved,
        ({ record }) => `${record.generationId}\u0000${record.embeddingSpaceId}`,
      );
      for (const group of projectionGroups.values()) {
        await this.embedGroup(group, result);
      }
    }
    return result;
  }

  private async embedGroup(
    items: ReadonlyArray<{ record: ContentPlanObservationVectorRecord; semanticText: string }>,
    result: ContentPlanEmbeddingBatchResult,
  ): Promise<void> {
    const first = items[0];
    if (!first) return;
    const activeItems = items.filter(({ record }) => {
      if (isContentPlanClaimActive(record, this.dependencies.clock())) return true;
      result.staleClaimCount += 1;
      this.recordStaleLease(record, "embedding");
      return false;
    });
    if (activeItems.length === 0) return;

    if (this.dependencies.budget) {
      let reservation: Awaited<ReturnType<ContentPlanProjectionBudgetPort["reserve"]>>;
      try {
        reservation = await this.dependencies.budget.reserve({
          workspaceId: first.record.workspaceId,
          generationId: first.record.generationId,
          requests: 1,
          estimatedSpendMicros: this.dependencies.options.estimatedEmbeddingBatchSpendMicros,
          now: this.dependencies.clock(),
        });
      } catch {
        await this.failAll(activeItems, result, "embedding_budget_reservation_failed", false);
        return;
      }
      if (reservation.kind === "budget_paused") {
        result.budgetPausedCount += activeItems.length;
        for (const { record } of activeItems) {
          addDisposition(result, await this.dependencies.failures.settle({
            record,
            stage: "embedding",
            reason: "embedding_budget_paused",
            ignoreAttemptCeiling: true,
          }));
        }
        return;
      }
    }

    let embedded: Awaited<ReturnType<ContentPlanProjectionEmbeddingPort["embedForProjection"]>>;
    const providerStartedAt = Date.now();
    try {
      embedded = await this.dependencies.embeddings.embedForProjection({
        workspaceId: first.record.workspaceId,
        generationId: first.record.generationId,
        embeddingSpaceId: first.record.embeddingSpaceId,
        texts: activeItems.map((item) => item.semanticText),
      });
    } catch {
      this.dependencies.observability.record({
        stage: "embedding",
        outcome: "retry_scheduled",
        reason: "embedding_provider_failed",
        workspaceId: first.record.workspaceId,
        generationId: first.record.generationId,
        itemCount: activeItems.length,
        durationMs: Math.max(0, Date.now() - providerStartedAt),
        providerOperation: "embedding",
        providerCallCount: 1,
      });
      for (const { record } of activeItems) {
        addDisposition(result, await this.dependencies.failures.settle({
          record,
          stage: "embedding",
          reason: "embedding_provider_failed",
        }));
      }
      return;
    }
    this.dependencies.observability.record({
      stage: "embedding",
      outcome: "completed",
      workspaceId: first.record.workspaceId,
      generationId: first.record.generationId,
      itemCount: activeItems.length,
      durationMs: Math.max(0, Date.now() - providerStartedAt),
      providerOperation: "embedding",
      providerCallCount: 1,
    });

    if (embedded.embeddingSpaceId !== first.record.embeddingSpaceId) {
      await this.failAll(activeItems, result, "embedding_space_mismatch", true);
      return;
    }
    if (embedded.vectors.length !== activeItems.length) {
      await this.failAll(activeItems, result, "embedding_result_count_mismatch", false);
      return;
    }

    for (let index = 0; index < activeItems.length; index += 1) {
      const item = activeItems[index]!;
      const vector = embedded.vectors[index] ?? null;
      if (!isValidContentPlanVector(vector, vector?.length ?? null)) {
        addDisposition(result, await this.dependencies.failures.settle({
          record: item.record,
          stage: "embedding",
          reason: "embedding_vector_invalid",
          permanent: true,
        }));
        continue;
      }
      if (!isContentPlanClaimActive(item.record, this.dependencies.clock())) {
        result.staleClaimCount += 1;
        this.recordStaleLease(item.record, "embedding");
        continue;
      }
      let applied: boolean;
      try {
        applied = await this.dependencies.observationWork.storeClaimedEmbedding({
          workspaceId: item.record.workspaceId,
          observationId: item.record.observationId,
          generationId: item.record.generationId,
          claimToken: item.record.claimToken!,
          dimensions: vector.length,
          embedding: vector,
          vectorSource: "fallback",
        });
      } catch {
        addDisposition(result, await this.dependencies.failures.settle({
          record: item.record,
          stage: "embedding",
          reason: "claim_settlement_failed",
        }));
        continue;
      }
      if (!applied) {
        result.staleClaimCount += 1;
        this.dependencies.observability.record({
          stage: "embedding",
          outcome: "stale",
          reason: "claim_settlement_failed",
          workspaceId: item.record.workspaceId,
          generationId: item.record.generationId,
          observationId: item.record.observationId,
          attemptCount: item.record.attemptCount,
        });
        continue;
      }
      result.embeddedCount += 1;
      this.dependencies.observability.record({
        stage: "embedding",
        outcome: "completed",
        workspaceId: item.record.workspaceId,
        generationId: item.record.generationId,
        observationId: item.record.observationId,
        attemptCount: item.record.attemptCount,
        vectorSource: "fallback",
      });
    }
  }

  private async failAll(
    items: ReadonlyArray<{ record: ContentPlanObservationVectorRecord }>,
    result: ContentPlanEmbeddingBatchResult,
    reason: ContentPlanWorkerFailureReason,
    permanent: boolean,
  ): Promise<void> {
    for (const { record } of items) {
      addDisposition(result, await this.dependencies.failures.settle({
        record,
        stage: "embedding",
        reason,
        permanent,
      }));
    }
  }

  private recordStaleLease(
    record: ContentPlanObservationVectorRecord,
    stage: "embedding",
  ): void {
    this.dependencies.observability.record({
      stage,
      outcome: "stale",
      reason: "lease_expired",
      workspaceId: record.workspaceId,
      generationId: record.generationId,
      observationId: record.observationId,
      attemptCount: record.attemptCount,
    });
  }
}

const mapSourceFailureReason = (
  reason: "semantic_intent_missing" | "hash_mismatch" | "ambiguous" | "source_unavailable",
): ContentPlanWorkerFailureReason => {
  switch (reason) {
    case "semantic_intent_missing":
      return "semantic_intent_missing";
    case "hash_mismatch":
      return "semantic_hash_mismatch";
    case "ambiguous":
      return "semantic_intent_ambiguous";
    case "source_unavailable":
      return "source_unavailable";
  }
};

const addDisposition = (
  result: ContentPlanEmbeddingBatchResult,
  disposition: ContentPlanClaimFailureDisposition,
): void => {
  if (disposition === "retry") result.retryCount += 1;
  if (disposition === "terminal") result.terminalFailureCount += 1;
  if (disposition === "stale") result.staleClaimCount += 1;
};

const groupBy = <T>(
  values: readonly T[],
  keyFor: (value: T) => string,
): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
};
