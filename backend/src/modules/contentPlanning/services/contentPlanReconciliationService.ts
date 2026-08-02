import type {
  ContentPlanAffectedTopic,
  ContentPlanTopicReconciliationEvidence,
  ContentPlanTopicRecord,
  ContentPlanTopicRepositoryPort,
} from "../contracts/persistence.js";
import { shouldMatureTopic } from "../domain/topicPolicy.js";
import type { ContentPlanWorkerEventSink } from "./contentPlanWorkerObservability.js";
import {
  isValidContentPlanVector,
  type ContentPlanWorkerOptions,
} from "./contentPlanWorkerPolicy.js";

export interface ContentPlanReconciliationResult {
  requestedTopicCount: number;
  reconciledTopicCount: number;
  maturedTopicCount: number;
  retiredTopicCount: number;
  conflictCount: number;
  failureCount: number;
  truncatedTopicCount: number;
}

const emptyResult = (
  requestedTopicCount: number,
  truncatedTopicCount: number,
): ContentPlanReconciliationResult => ({
  requestedTopicCount,
  reconciledTopicCount: 0,
  maturedTopicCount: 0,
  retiredTopicCount: 0,
  conflictCount: 0,
  failureCount: 0,
  truncatedTopicCount,
});

export class ContentPlanReconciliationService {
  constructor(private readonly dependencies: {
    topics: Pick<
      ContentPlanTopicRepositoryPort,
      "loadReconciliationEvidence" | "reconcileTopic" | "resolveTopicRedirect"
    >;
    observability: ContentPlanWorkerEventSink;
    clock: () => Date;
    options: Pick<
      ContentPlanWorkerOptions,
      "representativeObservationLimit" | "retentionBatchSize"
    >;
  }) {}

  async reconcileAffected(
    affected: readonly ContentPlanAffectedTopic[],
  ): Promise<ContentPlanReconciliationResult> {
    const unique = distinctAffectedTopics(affected);
    const selected = unique.slice(0, this.dependencies.options.retentionBatchSize);
    const result = emptyResult(unique.length, unique.length - selected.length);
    const grouped = groupAffectedTopics(selected);

    for (const group of grouped.values()) {
      let evidence: ContentPlanTopicReconciliationEvidence[];
      try {
        evidence = await this.dependencies.topics.loadReconciliationEvidence({
          workspaceId: group.workspaceId,
          generationId: group.generationId,
          topicIds: group.topicIds,
          limit: group.topicIds.length,
        });
      } catch {
        result.failureCount += group.topicIds.length;
        this.dependencies.observability.record({
          stage: "reconciliation",
          outcome: "retry_scheduled",
          reason: "reconciliation_repository_failed",
          workspaceId: group.workspaceId,
          generationId: group.generationId,
          itemCount: group.topicIds.length,
        });
        continue;
      }
      const evidenceByTopic = new Map(evidence.map((item) => [item.topicId, item]));
      for (const topicId of group.topicIds) {
        const item = evidenceByTopic.get(topicId);
        if (!item) {
          result.failureCount += 1;
          this.recordFailure(group.workspaceId, group.generationId, topicId, "reconciliation_evidence_unavailable");
          continue;
        }
        await this.reconcileOne({
          workspaceId: group.workspaceId,
          generationId: group.generationId,
          topicId,
          evidence: item,
          result,
        });
      }
    }
    return result;
  }

  private async reconcileOne(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    evidence: ContentPlanTopicReconciliationEvidence;
    result: ContentPlanReconciliationResult;
  }): Promise<void> {
    let current: ContentPlanTopicRecord;
    try {
      const resolution = await this.dependencies.topics.resolveTopicRedirect({
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        topicId: input.topicId,
        now: this.dependencies.clock(),
      });
      if (resolution.kind !== "active" || resolution.topic.id !== input.topicId) {
        input.result.conflictCount += 1;
        this.recordFailure(input.workspaceId, input.generationId, input.topicId, "reconciliation_conflict", "stale");
        return;
      }
      current = resolution.topic;
    } catch {
      input.result.failureCount += 1;
      this.recordFailure(input.workspaceId, input.generationId, input.topicId, "reconciliation_repository_failed");
      return;
    }

    const aggregate = toAggregate(current, input.evidence, this.dependencies.clock(),
      this.dependencies.options.representativeObservationLimit);
    if (!aggregate) {
      input.result.failureCount += 1;
      this.recordFailure(input.workspaceId, input.generationId, input.topicId, "reconciliation_evidence_unavailable");
      return;
    }
    try {
      const persisted = await this.dependencies.topics.reconcileTopic({
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        topicId: input.topicId,
        expectedRevision: current.revision,
        topic: aggregate,
      });
      if (!persisted) {
        input.result.conflictCount += 1;
        this.recordFailure(input.workspaceId, input.generationId, input.topicId, "reconciliation_conflict", "stale");
        return;
      }
      input.result.reconciledTopicCount += 1;
      const matured = current.lifecycle === "provisional" && aggregate.lifecycle === "mature";
      const retired = aggregate.lifecycle === "retired";
      if (matured) input.result.maturedTopicCount += 1;
      if (retired) input.result.retiredTopicCount += 1;
      this.dependencies.observability.record({
        stage: "reconciliation",
        outcome: retired ? "retired" : matured ? "matured" : "completed",
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        topicId: input.topicId,
        lifecycle: aggregate.lifecycle,
        revision: aggregate.revision,
      });
    } catch {
      input.result.failureCount += 1;
      this.recordFailure(input.workspaceId, input.generationId, input.topicId, "reconciliation_repository_failed");
    }
  }

  private recordFailure(
    workspaceId: string,
    generationId: string,
    topicId: string,
    reason: "reconciliation_evidence_unavailable" | "reconciliation_conflict" | "reconciliation_repository_failed",
    outcome: "retry_scheduled" | "stale" = "retry_scheduled",
  ): void {
    this.dependencies.observability.record({
      stage: "reconciliation",
      outcome,
      reason,
      workspaceId,
      generationId,
      topicId,
    });
  }
}

const toAggregate = (
  topic: ContentPlanTopicRecord,
  evidence: ContentPlanTopicReconciliationEvidence,
  now: Date,
  representativeLimit: number,
) => {
  if (evidence.liveObservationCount === 0) {
    return {
      lifecycle: "retired" as const,
      centroid: null,
      dimensions: topic.dimensions,
      centroidWeight: 0,
      representativeObservationIds: [],
      revision: topic.revision + 1,
      enrichmentDirtyAt: now,
    };
  }
  if (
    evidence.liveCentroid === null
    || !isValidContentPlanVector(evidence.liveCentroid, topic.dimensions)
    || evidence.liveConversationCount < 1
  ) {
    return null;
  }
  const matures = topic.lifecycle === "provisional" && shouldMatureTopic({
    observationCount: evidence.liveObservationCount,
    conversationCount: evidence.liveConversationCount,
  });
  return {
    lifecycle: topic.lifecycle === "mature" || matures ? "mature" as const : "provisional" as const,
    centroid: evidence.liveCentroid,
    dimensions: topic.dimensions,
    centroidWeight: evidence.liveObservationCount,
    representativeObservationIds: [...new Set(evidence.representativeObservationIds)].slice(0, representativeLimit),
    revision: topic.revision + 1,
    enrichmentDirtyAt: now,
  };
};

const distinctAffectedTopics = (
  affected: readonly ContentPlanAffectedTopic[],
): ContentPlanAffectedTopic[] => {
  const seen = new Set<string>();
  const unique: ContentPlanAffectedTopic[] = [];
  for (const topic of affected) {
    const key = `${topic.workspaceId}\u0000${topic.generationId}\u0000${topic.topicId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(topic);
  }
  return unique;
};

const groupAffectedTopics = (
  affected: readonly ContentPlanAffectedTopic[],
): Map<string, { workspaceId: string; generationId: string; topicIds: string[] }> => {
  const groups = new Map<string, { workspaceId: string; generationId: string; topicIds: string[] }>();
  for (const topic of affected) {
    const key = `${topic.workspaceId}\u0000${topic.generationId}`;
    const group = groups.get(key) ?? {
      workspaceId: topic.workspaceId,
      generationId: topic.generationId,
      topicIds: [],
    };
    group.topicIds.push(topic.topicId);
    groups.set(key, group);
  }
  return groups;
};
