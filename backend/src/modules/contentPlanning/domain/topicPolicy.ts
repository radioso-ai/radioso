export const CONTENT_PLAN_TOPIC_POLICY_V1 = Object.freeze({
  version: 1 as const,
  assignmentSimilarityFloor: 0.82,
  assignmentCohesionFloor: 0.76,
  maturityObservationCount: 2,
  maturityConversationCount: 2,
  mergeSimilarityFloor: 0.9,
  mergeCohesionFloor: 0.82,
  maxRedirectDepth: 8,
});

const cosineSimilarity = (left: readonly number[], right: readonly number[]): number | null => {
  if (left.length === 0 || left.length !== right.length) {
    return null;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined
      || !Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      return null;
    }
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return null;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
};

export interface TopicAssignmentCandidate {
  topicId: string;
  centroid: readonly number[];
  representativeVectors: ReadonlyArray<readonly number[]>;
}

export interface TopicAssignment {
  topicId: string;
  similarity: number;
  cohesion: number;
}

export const chooseTopicAssignment = (input: {
  observationVector: readonly number[];
  candidates: readonly TopicAssignmentCandidate[];
}): TopicAssignment | null => {
  const qualifying = input.candidates.flatMap((candidate): TopicAssignment[] => {
    const similarity = cosineSimilarity(input.observationVector, candidate.centroid);
    if (similarity === null || similarity < CONTENT_PLAN_TOPIC_POLICY_V1.assignmentSimilarityFloor) {
      return [];
    }
    const representativeSimilarities = candidate.representativeVectors
      .map((vector) => cosineSimilarity(input.observationVector, vector))
      .filter((value): value is number => value !== null);
    if (representativeSimilarities.length !== candidate.representativeVectors.length) {
      return [];
    }
    const cohesion = representativeSimilarities.length > 0
      ? Math.min(...representativeSimilarities)
      : similarity;
    if (cohesion < CONTENT_PLAN_TOPIC_POLICY_V1.assignmentCohesionFloor) {
      return [];
    }
    return [{ topicId: candidate.topicId, similarity, cohesion }];
  });

  return qualifying.sort((left, right) =>
    right.similarity - left.similarity
    || right.cohesion - left.cohesion
    || left.topicId.localeCompare(right.topicId))[0] ?? null;
};

export const updateTopicCentroid = (input: {
  centroid: readonly number[];
  weight: number;
  observationVector: readonly number[];
}): { centroid: number[]; weight: number } => {
  if (!Number.isInteger(input.weight) || input.weight < 1
    || input.centroid.length === 0
    || input.centroid.length !== input.observationVector.length) {
    throw new Error("invalid_topic_centroid_input");
  }
  const weight = input.weight + 1;
  const centroid = input.centroid.map((value, index) => {
    const observationValue = input.observationVector[index];
    if (!Number.isFinite(value) || observationValue === undefined || !Number.isFinite(observationValue)) {
      throw new Error("invalid_topic_centroid_input");
    }
    return ((value * input.weight) + observationValue) / weight;
  });
  return { centroid, weight };
};

export const shouldMatureTopic = (input: {
  observationCount: number;
  conversationCount: number;
}): boolean =>
  input.observationCount >= CONTENT_PLAN_TOPIC_POLICY_V1.maturityObservationCount
  && input.conversationCount >= CONTENT_PLAN_TOPIC_POLICY_V1.maturityConversationCount;

export const canMergeTopics = (input: {
  leftCentroid: readonly number[];
  rightCentroid: readonly number[];
  crossRepresentativeSimilarities: readonly number[];
}): { canMerge: boolean; similarity: number | null; cohesion: number | null } => {
  const similarity = cosineSimilarity(input.leftCentroid, input.rightCentroid);
  const validCohesionValues = input.crossRepresentativeSimilarities.filter(Number.isFinite);
  const cohesion = validCohesionValues.length === input.crossRepresentativeSimilarities.length
    && validCohesionValues.length > 0
    ? Math.min(...validCohesionValues)
    : null;
  return {
    canMerge: similarity !== null
      && cohesion !== null
      && similarity >= CONTENT_PLAN_TOPIC_POLICY_V1.mergeSimilarityFloor
      && cohesion >= CONTENT_PLAN_TOPIC_POLICY_V1.mergeCohesionFloor,
    similarity,
    cohesion,
  };
};

export type TopicRedirectResolution =
  | { kind: "resolved"; canonicalTopicId: string; redirectedFromTopicId: string | null }
  | { kind: "invalid" };

export const resolveTopicRedirect = (
  startTopicId: string,
  findRedirect: (topicId: string) => string | null,
): TopicRedirectResolution => {
  const seen = new Set<string>();
  let current = startTopicId;
  let redirectCount = 0;
  while (true) {
    if (seen.has(current)) {
      return { kind: "invalid" };
    }
    seen.add(current);
    const next = findRedirect(current);
    if (next === null) {
      return {
        kind: "resolved",
        canonicalTopicId: current,
        redirectedFromTopicId: current === startTopicId ? null : startTopicId,
      };
    }
    redirectCount += 1;
    if (redirectCount > CONTENT_PLAN_TOPIC_POLICY_V1.maxRedirectDepth) {
      return { kind: "invalid" };
    }
    current = next;
  }
};

export const shouldRetireProvisionalTopic = (input: {
  lifecycle: "provisional" | "mature" | "merged" | "retired";
  liveObservationCount: number;
  expiresAt: Date;
  now: Date;
}): boolean =>
  input.lifecycle === "provisional"
  && input.liveObservationCount === 0
  && input.expiresAt.getTime() <= input.now.getTime();

export const contentPlanCosineSimilarity = cosineSimilarity;
