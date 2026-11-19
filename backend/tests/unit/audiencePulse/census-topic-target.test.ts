import { describe, expect, it } from "vitest";

import {
  TOPIC_TARGET_MAX,
  TOPIC_TARGET_MIN,
  deriveTopicTarget,
} from "../../../src/modules/audiencePulse/domain/censusTopicTarget.js";

describe("deriveTopicTarget", () => {
  it("holds the floor of 10 topics for small and empty populations", () => {
    expect(TOPIC_TARGET_MIN).toBe(10);
    for (const questionCount of [0, 1, 8, 100, 1_200]) {
      expect(deriveTopicTarget(questionCount)).toBe(10);
    }
  });

  it("stays on the floor until round(sqrt(n) / 3.5) first reaches 11", () => {
    // sqrt(1350) / 3.5 = 10.498 rounds down; sqrt(1351) / 3.5 = 10.502 rounds up.
    expect(deriveTopicTarget(1_350)).toBe(10);
    expect(deriveTopicTarget(1_351)).toBe(11);
  });

  it("scales with the square root of the clustered question count", () => {
    expect(deriveTopicTarget(5_000)).toBe(20);
    expect(deriveTopicTarget(14_000)).toBe(34);
  });

  it("never decreases as the population grows", () => {
    let previous = deriveTopicTarget(0);
    for (let questionCount = 1; questionCount <= 25_000; questionCount += 7) {
      const current = deriveTopicTarget(questionCount);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("caps at 40 topics", () => {
    expect(TOPIC_TARGET_MAX).toBe(40);
    // sqrt(19113) / 3.5 = 39.499 rounds to 39; sqrt(19114) / 3.5 = 39.501 rounds to 40.
    expect(deriveTopicTarget(19_113)).toBe(39);
    expect(deriveTopicTarget(19_114)).toBe(40);
    expect(deriveTopicTarget(19_600)).toBe(40);
    expect(deriveTopicTarget(1_000_000)).toBe(40);
  });

  it("falls back to the floor for counts that cannot be a population", () => {
    for (const questionCount of [-5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(deriveTopicTarget(questionCount)).toBe(10);
    }
    expect(deriveTopicTarget(Number.POSITIVE_INFINITY)).toBe(40);
  });

  it("always returns a positive integer the census accepts", () => {
    for (const questionCount of [0, 3, 999, 4_321, 14_000, 90_000]) {
      const target = deriveTopicTarget(questionCount);
      expect(Number.isInteger(target)).toBe(true);
      expect(target).toBeGreaterThanOrEqual(TOPIC_TARGET_MIN);
      expect(target).toBeLessThanOrEqual(TOPIC_TARGET_MAX);
    }
  });
});
