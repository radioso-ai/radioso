import { describe, expect, it } from "vitest";

import { maxWeightBipartiteMatching } from "../src/matching.js";
import { createFixtureRandom } from "./support/fixtures.js";

const totalWeight = (
  weights: readonly (readonly number[])[],
  matched: readonly number[],
): number =>
  matched.reduce(
    (sum, column, row) => (column < 0 ? sum : sum + weights[row][column]),
    0,
  );

/**
 * Every legal pairing, by exhaustive search: each row takes a free column or
 * takes nothing. Exponential, so it is only ever run on tiny matrices -- its
 * job is to be obviously correct, not fast, so the Hungarian implementation has
 * something independent to be wrong against.
 */
const bruteForceBestWeight = (
  weights: readonly (readonly number[])[],
  rowCount: number,
  columnCount: number,
): number => {
  const taken = new Array<boolean>(columnCount).fill(false);
  const search = (row: number): number => {
    if (row === rowCount) {
      return 0;
    }
    let best = search(row + 1);
    for (let column = 0; column < columnCount; column += 1) {
      if (taken[column] || weights[row][column] <= 0) {
        continue;
      }
      taken[column] = true;
      best = Math.max(best, weights[row][column] + search(row + 1));
      taken[column] = false;
    }
    return best;
  };
  return search(0);
};

const isLegalMatching = (matched: readonly number[], columnCount: number): boolean => {
  const seen = new Set<number>();
  for (const column of matched) {
    if (column < 0) {
      continue;
    }
    if (column >= columnCount || seen.has(column)) {
      return false;
    }
    seen.add(column);
  }
  return true;
};

describe("maxWeightBipartiteMatching", () => {
  it("returns no pairings for an empty side", () => {
    expect(maxWeightBipartiteMatching([], 0, 3)).toEqual([]);
    expect(maxWeightBipartiteMatching([[], []], 2, 0)).toEqual([-1, -1]);
  });

  it("leaves a row unpaired rather than forcing it onto a non-edge", () => {
    expect(maxWeightBipartiteMatching([[1, 0], [0, 0]], 2, 2)).toEqual([0, -1]);
  });

  it("prefers two lighter pairings over one heavy one", () => {
    // Greedy takes (0,0) at 1.6 and is then stranded, since (1,1) is a non-edge.
    expect(maxWeightBipartiteMatching([[1.6, 1.2], [1.2, 0]], 2, 2)).toEqual([1, 0]);
  });

  it("breaks ties on the lowest column index", () => {
    expect(maxWeightBipartiteMatching([[1, 1, 1]], 1, 3)).toEqual([0]);
    expect(maxWeightBipartiteMatching([[1, 1], [1, 1]], 2, 2)).toEqual([0, 1]);
  });

  it("handles matrices that are not square in either direction", () => {
    expect(maxWeightBipartiteMatching([[0.2, 0.9, 0.4]], 1, 3)).toEqual([1]);
    expect(maxWeightBipartiteMatching([[0.2], [0.9], [0.4]], 3, 1)).toEqual([-1, 0, -1]);
  });

  it("matches an exhaustive search on random matrices", () => {
    const random = createFixtureRandom(20260804);
    for (let trial = 0; trial < 400; trial += 1) {
      const rowCount = 1 + Math.floor(random() * 4);
      const columnCount = 1 + Math.floor(random() * 4);
      const weights = Array.from({ length: rowCount }, () =>
        Array.from({ length: columnCount }, () => {
          // A third of the cells are non-edges, so the search has to decide when
          // leaving a vertex out beats pairing it.
          const draw = random();
          return draw < 0.33 ? 0 : Math.round(draw * 1000) / 1000;
        }));

      const matched = maxWeightBipartiteMatching(weights, rowCount, columnCount);
      expect(isLegalMatching(matched, columnCount), `trial ${trial}: illegal matching`).toBe(true);
      expect(totalWeight(weights, matched), `trial ${trial}`)
        .toBeCloseTo(bruteForceBestWeight(weights, rowCount, columnCount), 10);
    }
  });

  it("is a pure function of the matrix", () => {
    const weights = [[0.8, 0.2, 0], [0.3, 0.9, 0.1], [0, 0.4, 0.7]];
    const first = maxWeightBipartiteMatching(weights, 3, 3);
    expect(maxWeightBipartiteMatching(weights, 3, 3)).toEqual(first);
  });
});
