import { describe, expect, it } from "vitest";

import {
  clusterContentPlanObservations,
} from "../../src/modules/contentPlanning/domain/incrementalClustering.js";
import {
  contentPlanningClusteringFixture,
} from "../fixtures/content-planning/clustering.js";

describe("content planning deterministic clustering fixture", () => {
  it("contains the committed multilingual and adversarial coverage", () => {
    expect(contentPlanningClusteringFixture.length).toBeGreaterThanOrEqual(160);
    expect(new Set(contentPlanningClusteringFixture.map((row) => row.goldTopicId)).size)
      .toBeGreaterThanOrEqual(8);
    expect(new Set(contentPlanningClusteringFixture.map((row) => row.language)).size)
      .toBeGreaterThanOrEqual(4);
    expect(contentPlanningClusteringFixture.some((row) => row.question.includes("Ignore prior")))
      .toBe(true);
    expect(new Set(contentPlanningClusteringFixture.map((row) => row.turnId)).size)
      .toBeLessThan(contentPlanningClusteringFixture.length);
  });

  it("meets the locked pairwise F1 gates without a provider call or question-text rule", () => {
    const result = clusterContentPlanObservations({
      observations: contentPlanningClusteringFixture.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        vector: row.vector,
      })),
      createTopicId: (observation) => `topic:${observation.id}`,
    });
    const predictedByObservation = new Map(
      result.topics.flatMap((topic) => topic.observationIds.map((id) => [id, topic.id] as const)),
    );

    const overall = pairwiseF1(contentPlanningClusteringFixture, predictedByObservation);
    const crossLanguage = pairwiseF1(
      contentPlanningClusteringFixture,
      predictedByObservation,
      (left, right) => left.language !== right.language,
    );

    expect(overall).toBeGreaterThanOrEqual(0.85);
    expect(crossLanguage).toBeGreaterThanOrEqual(0.8);
    expect(result.assignments).toHaveLength(contentPlanningClusteringFixture.length);
    expect(new Set(result.assignments.map((assignment) => assignment.observationId)).size)
      .toBe(contentPlanningClusteringFixture.length);
  });
});

const pairwiseF1 = (
  rows: typeof contentPlanningClusteringFixture,
  predicted: ReadonlyMap<string, string>,
  include: (left: (typeof rows)[number], right: (typeof rows)[number]) => boolean = () => true,
): number => {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const left = rows[leftIndex]!;
      const right = rows[rightIndex]!;
      if (!include(left, right)) continue;
      const expectedSame = left.goldTopicId === right.goldTopicId;
      const predictedSame = predicted.get(left.id) === predicted.get(right.id);
      if (expectedSame && predictedSame) truePositive += 1;
      if (!expectedSame && predictedSame) falsePositive += 1;
      if (expectedSame && !predictedSame) falseNegative += 1;
    }
  }
  const precision = truePositive / (truePositive + falsePositive);
  const recall = truePositive / (truePositive + falseNegative);
  return (2 * precision * recall) / (precision + recall);
};
