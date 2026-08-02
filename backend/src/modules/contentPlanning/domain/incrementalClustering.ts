import {
  chooseTopicAssignment,
  shouldMatureTopic,
  updateTopicCentroid,
} from "./topicPolicy.js";

const MAX_REPRESENTATIVE_VECTORS = 4;

export interface ContentPlanClusterObservation {
  id: string;
  conversationId: string;
  vector: readonly number[];
}

export interface ContentPlanIncrementalTopic {
  id: string;
  lifecycle: "provisional" | "mature";
  centroid: number[];
  centroidWeight: number;
  representativeVectors: number[][];
  observationIds: string[];
  conversationIds: string[];
}

export interface ContentPlanClusterAssignment {
  observationId: string;
  topicId: string;
  similarity: number;
  cohesion: number;
  createdTopic: boolean;
}

/**
 * Deterministic in-memory form of the online assignment policy. The worker uses the
 * same policy against repository candidates; this harness locks order, maturity,
 * representative cohesion, and one-assignment-per-observation behavior in fixtures.
 */
export const clusterContentPlanObservations = (input: {
  observations: readonly ContentPlanClusterObservation[];
  createTopicId: (observation: ContentPlanClusterObservation) => string;
}): {
  topics: ContentPlanIncrementalTopic[];
  assignments: ContentPlanClusterAssignment[];
} => {
  const topics: ContentPlanIncrementalTopic[] = [];
  const assignments: ContentPlanClusterAssignment[] = [];
  const seenObservationIds = new Set<string>();
  const seenTopicIds = new Set<string>();

  for (const observation of input.observations) {
    assertObservation(observation, seenObservationIds);
    seenObservationIds.add(observation.id);
    const selected = chooseTopicAssignment({
      observationVector: observation.vector,
      candidates: topics.map((topic) => ({
        topicId: topic.id,
        centroid: topic.centroid,
        representativeVectors: topic.representativeVectors,
      })),
    });

    if (!selected) {
      const topicId = input.createTopicId(observation);
      if (topicId.length === 0 || seenTopicIds.has(topicId)) {
        throw new Error("invalid_content_plan_topic_id");
      }
      seenTopicIds.add(topicId);
      topics.push({
        id: topicId,
        lifecycle: "provisional",
        centroid: [...observation.vector],
        centroidWeight: 1,
        representativeVectors: [[...observation.vector]],
        observationIds: [observation.id],
        conversationIds: [observation.conversationId],
      });
      assignments.push({
        observationId: observation.id,
        topicId,
        similarity: 1,
        cohesion: 1,
        createdTopic: true,
      });
      continue;
    }

    const topic = topics.find((candidate) => candidate.id === selected.topicId);
    if (!topic) {
      throw new Error("selected_content_plan_topic_missing");
    }
    const updated = updateTopicCentroid({
      centroid: topic.centroid,
      weight: topic.centroidWeight,
      observationVector: observation.vector,
    });
    topic.centroid = updated.centroid;
    topic.centroidWeight = updated.weight;
    topic.observationIds.push(observation.id);
    if (!topic.conversationIds.includes(observation.conversationId)) {
      topic.conversationIds.push(observation.conversationId);
    }
    if (topic.representativeVectors.length < MAX_REPRESENTATIVE_VECTORS) {
      topic.representativeVectors.push([...observation.vector]);
    }
    if (topic.lifecycle === "provisional" && shouldMatureTopic({
      observationCount: topic.observationIds.length,
      conversationCount: topic.conversationIds.length,
    })) {
      topic.lifecycle = "mature";
    }
    assignments.push({
      observationId: observation.id,
      topicId: topic.id,
      similarity: selected.similarity,
      cohesion: selected.cohesion,
      createdTopic: false,
    });
  }

  return { topics, assignments };
};

const assertObservation = (
  observation: ContentPlanClusterObservation,
  seenObservationIds: ReadonlySet<string>,
): void => {
  if (observation.id.length === 0
    || observation.conversationId.length === 0
    || seenObservationIds.has(observation.id)
    || observation.vector.length === 0
    || observation.vector.some((value) => !Number.isFinite(value))
    || observation.vector.every((value) => value === 0)) {
    throw new Error("invalid_content_plan_cluster_observation");
  }
};
