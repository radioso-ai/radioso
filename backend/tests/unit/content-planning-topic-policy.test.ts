import { describe, expect, it } from "vitest";

import {
  CONTENT_PLAN_TOPIC_POLICY_V1,
  canMergeTopics,
  chooseTopicAssignment,
  resolveTopicRedirect,
  shouldMatureTopic,
  shouldRetireProvisionalTopic,
  updateTopicCentroid,
} from "../../src/modules/contentPlanning/domain/topicPolicy.js";

const unitAtCosine = (cosine: number): number[] => [
  cosine,
  Math.sqrt(1 - cosine ** 2),
];

describe("content planning topic policy v1", () => {
  it("locks conservative, versioned assignment and merge thresholds", () => {
    expect(CONTENT_PLAN_TOPIC_POLICY_V1).toEqual({
      version: 1,
      assignmentSimilarityFloor: 0.82,
      assignmentCohesionFloor: 0.76,
      maturityObservationCount: 2,
      maturityConversationCount: 2,
      mergeSimilarityFloor: 0.9,
      mergeCohesionFloor: 0.82,
      maxRedirectDepth: 8,
    });
  });

  it("selects the closest qualifying centroid with a representative cohesion guard", () => {
    const selected = chooseTopicAssignment({
      observationVector: [1, 0],
      candidates: [
        {
          topicId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          centroid: unitAtCosine(0.91),
          representativeVectors: [unitAtCosine(0.8), unitAtCosine(0.77)],
        },
        {
          topicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          centroid: unitAtCosine(0.91),
          representativeVectors: [unitAtCosine(0.84)],
        },
      ],
    });

    expect(selected).toEqual({
      topicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      similarity: expect.closeTo(0.91, 8),
      cohesion: expect.closeTo(0.84, 8),
    });
  });

  it("rejects a centroid-near outlier when representative cohesion is too low", () => {
    expect(chooseTopicAssignment({
      observationVector: [1, 0],
      candidates: [{
        topicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        centroid: unitAtCosine(0.95),
        representativeVectors: [unitAtCosine(0.74)],
      }],
    })).toBeNull();
  });

  it("updates a weighted centroid without mutating the stored vector", () => {
    const centroid = [1, 0];
    const updated = updateTopicCentroid({ centroid, weight: 3, observationVector: [0, 1] });

    expect(centroid).toEqual([1, 0]);
    expect(updated.weight).toBe(4);
    expect(updated.centroid[0]).toBeCloseTo(0.75);
    expect(updated.centroid[1]).toBeCloseTo(0.25);
  });

  it("matures only with two observations from two conversations", () => {
    expect(shouldMatureTopic({ observationCount: 2, conversationCount: 2 })).toBe(true);
    expect(shouldMatureTopic({ observationCount: 3, conversationCount: 1 })).toBe(false);
    expect(shouldMatureTopic({ observationCount: 1, conversationCount: 1 })).toBe(false);
  });

  it("requires both centroid similarity and cross-representative cohesion to merge", () => {
    expect(canMergeTopics({
      leftCentroid: [1, 0],
      rightCentroid: unitAtCosine(0.92),
      crossRepresentativeSimilarities: [0.86, 0.83],
    })).toEqual({ canMerge: true, similarity: expect.closeTo(0.92, 8), cohesion: 0.83 });
    expect(canMergeTopics({
      leftCentroid: [1, 0],
      rightCentroid: unitAtCosine(0.92),
      crossRepresentativeSimilarities: [0.81],
    }).canMerge).toBe(false);
  });

  it("resolves redirects transitively and rejects cycles or overlong chains", () => {
    const redirects = new Map([
      ["one", "two"],
      ["two", "three"],
    ]);
    expect(resolveTopicRedirect("one", (id) => redirects.get(id) ?? null)).toEqual({
      kind: "resolved",
      canonicalTopicId: "three",
      redirectedFromTopicId: "one",
    });

    const cycle = new Map([["one", "two"], ["two", "one"]]);
    expect(resolveTopicRedirect("one", (id) => cycle.get(id) ?? null)).toEqual({ kind: "invalid" });

    const long = new Map(Array.from({ length: 9 }, (_, index) => [String(index), String(index + 1)]));
    expect(resolveTopicRedirect("0", (id) => long.get(id) ?? null)).toEqual({ kind: "invalid" });
  });

  it("retires only zero-member provisional topics whose grace period elapsed", () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    expect(shouldRetireProvisionalTopic({
      lifecycle: "provisional",
      liveObservationCount: 0,
      expiresAt: new Date("2026-08-02T11:59:59.000Z"),
      now,
    })).toBe(true);
    expect(shouldRetireProvisionalTopic({
      lifecycle: "mature",
      liveObservationCount: 0,
      expiresAt: new Date("2026-08-02T11:59:59.000Z"),
      now,
    })).toBe(false);
  });
});
