import type {
  ContentPlanNearestTopic,
  ContentPlanObservationVectorRecord,
  ContentPlanTopicAssignmentEvidence,
  ContentPlanTopicRepositoryPort,
} from "../contracts/persistence.js";
import {
  chooseTopicAssignment,
  shouldMatureTopic,
  updateTopicCentroid,
} from "../domain/topicPolicy.js";
import type { ContentPlanClaimFailureDisposition } from "./contentPlanClaimFailureService.js";
import { ContentPlanClaimFailureService } from "./contentPlanClaimFailureService.js";
import type { ContentPlanWorkerEventSink } from "./contentPlanWorkerObservability.js";
import {
  isContentPlanClaimActive,
  isValidContentPlanVector,
  type ContentPlanWorkerOptions,
} from "./contentPlanWorkerPolicy.js";

export interface ContentPlanAssignmentResult {
  assignedCount: number;
  createdTopicCount: number;
  maturedTopicCount: number;
  retryCount: number;
  terminalFailureCount: number;
  staleClaimCount: number;
}

export type ContentPlanAssignmentTopicPort = Pick<
  ContentPlanTopicRepositoryPort,
  | "findNearestTopics"
  | "loadAssignmentEvidence"
  | "createTopicAndAssign"
  | "assignToExistingTopic"
>;

const emptyResult = (): ContentPlanAssignmentResult => ({
  assignedCount: 0,
  createdTopicCount: 0,
  maturedTopicCount: 0,
  retryCount: 0,
  terminalFailureCount: 0,
  staleClaimCount: 0,
});

export class ContentPlanAssignmentProcessor {
  constructor(private readonly dependencies: {
    topics: ContentPlanAssignmentTopicPort;
    failures: ContentPlanClaimFailureService;
    observability: ContentPlanWorkerEventSink;
    clock: () => Date;
    createTopicId: () => string;
    options: ContentPlanWorkerOptions;
  }) {}

  async process(record: ContentPlanObservationVectorRecord): Promise<ContentPlanAssignmentResult> {
    const result = emptyResult();
    const embedding = record.embedding;
    const dimensions = record.dimensions;
    if (
      embedding === null
      || dimensions === null
      || record.vectorSource === null
      || !isValidContentPlanVector(embedding, dimensions)
    ) {
      addDisposition(result, await this.dependencies.failures.settle({
        record,
        stage: "embedding",
        reason: "embedding_vector_invalid",
        permanent: true,
      }));
      return result;
    }

    let candidates: ContentPlanNearestTopic[];
    let evidence: ContentPlanTopicAssignmentEvidence[] = [];
    try {
      candidates = await this.dependencies.topics.findNearestTopics({
        workspaceId: record.workspaceId,
        generationId: record.generationId,
        embeddingSpaceId: record.embeddingSpaceId,
        dimensions,
        embedding,
        limit: this.dependencies.options.nearestTopicLimit,
      });
      if (candidates.length > 0) {
        evidence = await this.dependencies.topics.loadAssignmentEvidence({
          workspaceId: record.workspaceId,
          generationId: record.generationId,
          observationId: record.observationId,
          topicIds: candidates.map((candidate) => candidate.id),
          limit: candidates.length,
        });
      }
    } catch {
      addDisposition(result, await this.dependencies.failures.settle({
        record,
        stage: "assignment",
        reason: "assignment_repository_failed",
      }));
      return result;
    }

    const evidenceByTopic = new Map(evidence.map((item) => [item.topicId, item]));
    if (!hasCompleteCandidateEvidence(candidates, evidenceByTopic, dimensions)) {
      addDisposition(result, await this.dependencies.failures.settle({
        record,
        stage: "assignment",
        reason: "assignment_evidence_unavailable",
      }));
      return result;
    }
    const assignment = chooseTopicAssignment({
      observationVector: embedding,
      candidates: candidates.map((candidate) => ({
        topicId: candidate.id,
        centroid: candidate.centroid,
        representativeVectors: evidenceByTopic.get(candidate.id)!.representativeVectors
          .map((representative) => representative.embedding),
      })),
    });

    if (!isContentPlanClaimActive(record, this.dependencies.clock())) {
      this.recordStaleLease(record);
      result.staleClaimCount += 1;
      return result;
    }
    if (!assignment) {
      return this.createTopic({ ...record, embedding, dimensions }, result);
    }
    const selected = candidates.find((candidate) => candidate.id === assignment.topicId);
    const selectedEvidence = evidenceByTopic.get(assignment.topicId);
    if (!selected || !selectedEvidence || selectedEvidence.liveObservationCount !== selected.centroidWeight) {
      addDisposition(result, await this.dependencies.failures.settle({
        record,
        stage: "assignment",
        reason: "assignment_evidence_unavailable",
      }));
      return result;
    }

    const centroid = updateTopicCentroid({
      centroid: selected.centroid,
      weight: selected.centroidWeight,
      observationVector: embedding,
    });
    const nextConversationCount = selectedEvidence.liveConversationCount
      + (selectedEvidence.incomingConversationAlreadyPresent ? 0 : 1);
    const matures = selected.lifecycle === "provisional" && shouldMatureTopic({
      observationCount: selectedEvidence.liveObservationCount + 1,
      conversationCount: nextConversationCount,
    });
    const lifecycle = selected.lifecycle === "mature" || matures ? "mature" : "provisional";
    const representatives = appendBounded(
      selected.representativeObservationIds,
      record.observationId,
      this.dependencies.options.representativeObservationLimit,
    );

    try {
      const persisted = await this.dependencies.topics.assignToExistingTopic({
        workspaceId: record.workspaceId,
        generationId: record.generationId,
        observationId: record.observationId,
        claimToken: record.claimToken!,
        topicId: selected.id,
        expectedTopicRevision: selected.revision,
        topic: {
          lifecycle,
          centroid: centroid.centroid,
          dimensions,
          centroidWeight: centroid.weight,
          representativeObservationIds: representatives,
          revision: selected.revision + 1,
          enrichmentDirtyAt: lifecycle === "mature"
            ? selected.enrichmentDirtyAt ?? this.dependencies.clock()
            : selected.enrichmentDirtyAt,
        },
        assignmentVersion: this.dependencies.options.assignmentVersion,
        similarity: boundedScore(assignment.similarity),
        cohesion: boundedScore(assignment.cohesion),
        assignedAt: this.dependencies.clock(),
      });
      if (!persisted.applied) {
        addDisposition(result, await this.dependencies.failures.settle({
          record,
          stage: "assignment",
          reason: "assignment_conflict",
        }));
        return result;
      }
      result.assignedCount = 1;
      result.maturedTopicCount = matures ? 1 : 0;
      this.dependencies.observability.record({
        stage: "assignment",
        outcome: matures ? "matured" : "assigned_existing",
        workspaceId: record.workspaceId,
        generationId: record.generationId,
        observationId: record.observationId,
        topicId: selected.id,
        attemptCount: record.attemptCount,
        vectorSource: record.vectorSource ?? undefined,
        assignmentOutcome: "existing",
        lifecycle,
        revision: selected.revision + 1,
      });
      return result;
    } catch {
      addDisposition(result, await this.dependencies.failures.settle({
        record,
        stage: "assignment",
        reason: "assignment_repository_failed",
      }));
      return result;
    }
  }

  private async createTopic(
    record: ContentPlanObservationVectorRecord & { embedding: readonly number[]; dimensions: number },
    result: ContentPlanAssignmentResult,
  ): Promise<ContentPlanAssignmentResult> {
    try {
      const persisted = await this.dependencies.topics.createTopicAndAssign({
        workspaceId: record.workspaceId,
        generationId: record.generationId,
        observationId: record.observationId,
        claimToken: record.claimToken!,
        topic: {
          id: this.dependencies.createTopicId(),
          embeddingSpaceId: record.embeddingSpaceId,
          lifecycle: "provisional",
          centroid: record.embedding,
          dimensions: record.dimensions,
          centroidWeight: 1,
          representativeObservationIds: [record.observationId],
          revision: 1,
          enrichmentDirtyAt: null,
        },
        assignmentVersion: this.dependencies.options.assignmentVersion,
        similarity: 1,
        cohesion: 1,
        assignedAt: this.dependencies.clock(),
      });
      if (!persisted.applied) {
        addDisposition(result, await this.dependencies.failures.settle({
          record,
          stage: "assignment",
          reason: "assignment_conflict",
        }));
        return result;
      }
      result.assignedCount = 1;
      result.createdTopicCount = 1;
      this.dependencies.observability.record({
        stage: "assignment",
        outcome: "created_topic",
        workspaceId: record.workspaceId,
        generationId: record.generationId,
        observationId: record.observationId,
        topicId: persisted.topic?.id,
        attemptCount: record.attemptCount,
        vectorSource: record.vectorSource ?? undefined,
        assignmentOutcome: "created",
        lifecycle: "provisional",
        revision: 1,
      });
      return result;
    } catch {
      addDisposition(result, await this.dependencies.failures.settle({
        record,
        stage: "assignment",
        reason: "assignment_repository_failed",
      }));
      return result;
    }
  }

  private recordStaleLease(record: ContentPlanObservationVectorRecord): void {
    this.dependencies.observability.record({
      stage: "assignment",
      outcome: "stale",
      reason: "lease_expired",
      workspaceId: record.workspaceId,
      generationId: record.generationId,
      observationId: record.observationId,
      attemptCount: record.attemptCount,
    });
  }
}

const hasCompleteCandidateEvidence = (
  candidates: readonly ContentPlanNearestTopic[],
  evidenceByTopic: ReadonlyMap<string, ContentPlanTopicAssignmentEvidence>,
  dimensions: number,
): boolean => candidates.every((candidate) => {
  const evidence = evidenceByTopic.get(candidate.id);
  if (!evidence) return false;
  const representatives = new Map(
    evidence.representativeVectors.map((representative) => [
      representative.observationId,
      representative.embedding,
    ]),
  );
  return candidate.representativeObservationIds.every((observationId) =>
    isValidContentPlanVector(representatives.get(observationId) ?? null, dimensions));
});

const appendBounded = (
  values: readonly string[],
  value: string,
  limit: number,
): string[] => {
  const next = [...new Set(values)];
  if (!next.includes(value) && next.length < limit) next.push(value);
  return next.slice(0, limit);
};

const boundedScore = (value: number): number => Math.max(0, Math.min(1, value));

const addDisposition = (
  result: ContentPlanAssignmentResult,
  disposition: ContentPlanClaimFailureDisposition,
): void => {
  if (disposition === "retry") result.retryCount += 1;
  if (disposition === "terminal") result.terminalFailureCount += 1;
  if (disposition === "stale") result.staleClaimCount += 1;
};
