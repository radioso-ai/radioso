import { describe, expect, it } from "vitest";

import { DEFAULT_TOPIC_IDENTITY_OPTIONS, matchTopicIdentities } from "../src/identity.js";
import type { TopicMembership, TopicTransition } from "../src/types.js";

const ARBITRARY_CENTROID: readonly number[] = [1, 0, 0];

const topic = (
  id: string,
  memberIds: readonly string[],
  centroid: readonly number[] = ARBITRARY_CENTROID,
): TopicMembership => ({ id, memberIds, centroid });

/** `ids("m", 1, 4)` -> `["m1", "m2", "m3", "m4"]`. */
const ids = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_unused, index) => `${prefix}${from + index}`);

/**
 * A permutation that moves every element of a list of two or more, so a test
 * that claims to shuffle its input really does. Deterministic on purpose: a
 * random shuffle would make a failure unreproducible.
 */
const rotatedAndReversed = <T>(values: readonly T[]): T[] => {
  const rotated = [...values.slice(1), ...values.slice(0, 1)];
  return rotated.reverse();
};

describe("matchTopicIdentities", () => {
  describe("survived", () => {
    it("carries a prior topic's identity onto the cluster that still holds it", () => {
      const priors = [topic("t-1", ids("m", 1, 10))];
      const clusters = [topic("c-1", [...ids("m", 1, 9), "fresh-1"])];

      expect(matchTopicIdentities(priors, clusters)).toEqual([
        {
          kind: "survived",
          topicId: "t-1",
          clusterId: "c-1",
          parentTopicIds: ["t-1"],
          viaCentroidFallback: false,
        },
      ]);
    });
  });

  describe("split", () => {
    it("records every descendant of one prior topic as new, with that topic as parent", () => {
      // Each descendant holds a third of the prior topic: 1/3 clears tauPart
      // but not tauSurvive, so no descendant inherits the identity.
      const priors = [topic("t-1", ids("p", 1, 9))];
      const clusters = [
        topic("c-1", ids("p", 1, 3)),
        topic("c-2", ids("p", 4, 6)),
        topic("c-3", ids("p", 7, 9)),
      ];

      expect(matchTopicIdentities(priors, clusters)).toEqual([
        { kind: "split", clusterId: "c-1", parentTopicIds: ["t-1"], viaCentroidFallback: false },
        { kind: "split", clusterId: "c-2", parentTopicIds: ["t-1"], viaCentroidFallback: false },
        { kind: "split", clusterId: "c-3", parentTopicIds: ["t-1"], viaCentroidFallback: false },
      ]);
    });
  });

  describe("merged", () => {
    it("records one cluster as new, with every prior topic that fed it as parent", () => {
      const priors = [
        topic("t-1", ids("g", 1, 3)),
        topic("t-2", ids("g", 4, 6)),
        topic("t-3", ids("g", 7, 9)),
      ];
      const clusters = [topic("c-1", ids("g", 1, 9))];

      expect(matchTopicIdentities(priors, clusters)).toEqual([
        {
          kind: "merged",
          clusterId: "c-1",
          parentTopicIds: ["t-1", "t-2", "t-3"],
          viaCentroidFallback: false,
        },
      ]);
    });
  });

  describe("emerged", () => {
    it("reports a cluster that shares no members with any prior topic", () => {
      const priors = [topic("t-1", ids("m", 1, 5))];
      const clusters = [topic("c-1", ids("m", 1, 5)), topic("c-2", ids("n", 1, 5))];

      expect(matchTopicIdentities(priors, clusters)).toEqual([
        {
          kind: "survived",
          topicId: "t-1",
          clusterId: "c-1",
          parentTopicIds: ["t-1"],
          viaCentroidFallback: false,
        },
        { kind: "emerged", clusterId: "c-2", parentTopicIds: [], viaCentroidFallback: false },
      ]);
    });
  });

  describe("dissolved", () => {
    it("reports a prior topic that no cluster claims", () => {
      const priors = [topic("t-1", ids("m", 1, 5)), topic("t-2", ids("m", 6, 10))];
      const clusters = [topic("c-1", ids("m", 1, 5))];

      expect(matchTopicIdentities(priors, clusters)).toEqual([
        {
          kind: "survived",
          topicId: "t-1",
          clusterId: "c-1",
          parentTopicIds: ["t-1"],
          viaCentroidFallback: false,
        },
        { kind: "dissolved", topicId: "t-2", parentTopicIds: [], viaCentroidFallback: false },
      ]);
    });
  });

  describe("ambiguous pairings", () => {
    /**
     * Contingency table over the twelve shared members:
     *
     *          c-1   c-2
     *   t-1      8     2      |t-1| = 10
     *   t-2      2     0      |t-2| =  2
     *          ----  ----
     *          10     2
     *
     * containment sums: (t-1,c-1) = .8 + .8 = 1.6, (t-1,c-2) = .2 + 1 = 1.2,
     * (t-2,c-1) = 1 + .2 = 1.2, (t-2,c-2) = 0 (no shared member, no edge).
     *
     * Greedy takes the single heaviest edge (t-1,c-1) = 1.6 and is then stuck:
     * the only pair left is (t-2,c-2), which has no edge. Optimal takes the two
     * off-diagonal edges for 2.4. The two answers disagree on every pairing.
     */
    const priors = [topic("t-1", ids("m", 1, 10)), topic("t-2", ids("m", 11, 12))];
    const clusters = [
      topic("c-1", [...ids("m", 1, 8), ...ids("m", 11, 12)]),
      topic("c-2", ids("m", 9, 10)),
    ];
    const edges = [
      { row: 0, col: 0, weight: 1.6 },
      { row: 0, col: 1, weight: 1.2 },
      { row: 1, col: 0, weight: 1.2 },
    ];

    /** Heaviest edge first, taking any edge whose endpoints are both free. */
    const greedyMatching = (): { row: number; col: number; weight: number }[] => {
      const byWeight = [...edges]
        .sort((left, right) => right.weight - left.weight || left.row - right.row || left.col - right.col);
      const takenRows = new Set<number>();
      const takenCols = new Set<number>();
      const picked: typeof edges = [];
      for (const edge of byWeight) {
        if (takenRows.has(edge.row) || takenCols.has(edge.col)) {
          continue;
        }
        picked.push(edge);
        takenRows.add(edge.row);
        takenCols.add(edge.col);
      }
      return picked;
    };

    const totalWeight = (picked: readonly { weight: number }[]): number =>
      picked.reduce((sum, edge) => sum + edge.weight, 0);

    it("is a fixture where greedy is strictly worse than the optimum", () => {
      const greedy = greedyMatching();
      expect(greedy).toEqual([{ row: 0, col: 0, weight: 1.6 }]);
      expect(totalWeight(greedy)).toBeLessThan(totalWeight([edges[1], edges[2]]));
    });

    it("resolves to the maximum-weight matching, not the greedy one", () => {
      // tauSurvive below 0.2 so all three edges clear it. At the 0.5 default the
      // survive relation is already a matching -- a cluster cannot hold over half
      // of two disjoint prior topics -- so ambiguity needs a lower threshold.
      const transitions = matchTopicIdentities(priors, clusters, { tauSurvive: 0.1 });

      expect(transitions).toEqual([
        {
          kind: "survived",
          topicId: "t-1",
          clusterId: "c-2",
          parentTopicIds: ["t-1"],
          viaCentroidFallback: false,
        },
        {
          kind: "survived",
          topicId: "t-2",
          clusterId: "c-1",
          parentTopicIds: ["t-2"],
          viaCentroidFallback: false,
        },
      ]);
      // The pairing greedy would have made is absent.
      expect(transitions).not.toContainEqual(
        expect.objectContaining({ topicId: "t-1", clusterId: "c-1" }),
      );
    });
  });

  describe("determinism", () => {
    // One fixture exercising all five transitions at once. The blocks share no
    // members, so each relationship is decided in isolation.
    const priors = [
      topic("t-survivor", ids("s", 1, 10)),
      topic("t-splitter", ids("p", 1, 9)),
      topic("t-merge-a", ids("g", 1, 3)),
      topic("t-merge-b", ids("g", 4, 6)),
      topic("t-merge-c", ids("g", 7, 9)),
      topic("t-gone", ids("z", 1, 5)),
    ];
    const clusters = [
      topic("c-survivor", ids("s", 1, 10)),
      topic("c-part-1", ids("p", 1, 3)),
      topic("c-part-2", ids("p", 4, 6)),
      topic("c-part-3", ids("p", 7, 9)),
      topic("c-merged", ids("g", 1, 9)),
      topic("c-new", ids("n", 1, 5)),
    ];

    const expected: TopicTransition[] = [
      {
        kind: "survived",
        topicId: "t-survivor",
        clusterId: "c-survivor",
        parentTopicIds: ["t-survivor"],
        viaCentroidFallback: false,
      },
      {
        kind: "split",
        clusterId: "c-part-1",
        parentTopicIds: ["t-splitter"],
        viaCentroidFallback: false,
      },
      {
        kind: "split",
        clusterId: "c-part-2",
        parentTopicIds: ["t-splitter"],
        viaCentroidFallback: false,
      },
      {
        kind: "split",
        clusterId: "c-part-3",
        parentTopicIds: ["t-splitter"],
        viaCentroidFallback: false,
      },
      {
        kind: "merged",
        clusterId: "c-merged",
        parentTopicIds: ["t-merge-a", "t-merge-b", "t-merge-c"],
        viaCentroidFallback: false,
      },
      { kind: "emerged", clusterId: "c-new", parentTopicIds: [], viaCentroidFallback: false },
      { kind: "dissolved", topicId: "t-gone", parentTopicIds: [], viaCentroidFallback: false },
    ];

    it("classifies every transition kind in one run", () => {
      expect(matchTopicIdentities(priors, clusters)).toEqual(expected);
    });

    it("returns a deeply equal result for identical input", () => {
      expect(matchTopicIdentities(priors, clusters))
        .toEqual(matchTopicIdentities(priors, clusters));
    });

    it("returns the same transitions in the same order when the input is shuffled", () => {
      const shuffled = matchTopicIdentities(
        rotatedAndReversed(priors),
        rotatedAndReversed(clusters),
      );
      expect(shuffled).not.toEqual([]);
      expect(shuffled).toEqual(expected);
    });

    it("orders member ids inside a topic irrelevantly", () => {
      const reversedMembers = priors.map((prior) => topic(prior.id, [...prior.memberIds].reverse()));
      expect(matchTopicIdentities(reversedMembers, clusters)).toEqual(expected);
    });
  });

  describe("centroid fallback", () => {
    const priors = [
      topic("t-1", ids("old", 1, 4), [1, 0, 0]),
      topic("t-2", ids("old", 5, 8), [0, 1, 0]),
    ];
    const clusters = [
      // Points essentially the same way as t-1.
      topic("c-1", ids("new", 1, 4), [0.99, 0.1, 0]),
      topic("c-2", ids("new", 5, 8), [0, 0, 1]),
    ];

    it("engages when the two runs share no members, and flags what it produced", () => {
      expect(matchTopicIdentities(priors, clusters)).toEqual([
        {
          kind: "survived",
          topicId: "t-1",
          clusterId: "c-1",
          parentTopicIds: ["t-1"],
          viaCentroidFallback: true,
        },
        { kind: "emerged", clusterId: "c-2", parentTopicIds: [], viaCentroidFallback: true },
        { kind: "dissolved", topicId: "t-2", parentTopicIds: [], viaCentroidFallback: true },
      ]);
    });

    it("honours its own threshold, independent of the containment thresholds", () => {
      const transitions = matchTopicIdentities(priors, clusters, { tauCentroid: 0.999 });
      expect(transitions.map((transition) => transition.kind))
        .toEqual(["emerged", "emerged", "dissolved", "dissolved"]);
      expect(transitions.every((transition) => transition.viaCentroidFallback)).toBe(true);
    });

    it("stays off when the runs share even one member", () => {
      const overlapping = [topic("c-1", [...ids("new", 1, 4), "old1"], [0.99, 0.1, 0])];
      expect(matchTopicIdentities(priors, overlapping)
        .every((transition) => transition.viaCentroidFallback)).toBe(false);
    });

    it("rejects centroids of differing dimension rather than scoring them as NaN", () => {
      expect(() => matchTopicIdentities(priors, [topic("c-1", ids("new", 1, 4), [1, 0])]))
        .toThrow(/dimension/);
    });
  });

  describe("degenerate runs", () => {
    it("reports everything emerged on the first ever run", () => {
      expect(matchTopicIdentities([], [topic("c-1", ids("m", 1, 3)), topic("c-2", ids("m", 4, 6))]))
        .toEqual([
          { kind: "emerged", clusterId: "c-1", parentTopicIds: [], viaCentroidFallback: false },
          { kind: "emerged", clusterId: "c-2", parentTopicIds: [], viaCentroidFallback: false },
        ]);
    });

    it("reports everything dissolved when a run produces no clusters", () => {
      expect(matchTopicIdentities([topic("t-1", ids("m", 1, 3)), topic("t-2", ids("m", 4, 6))], []))
        .toEqual([
          { kind: "dissolved", topicId: "t-1", parentTopicIds: [], viaCentroidFallback: false },
          { kind: "dissolved", topicId: "t-2", parentTopicIds: [], viaCentroidFallback: false },
        ]);
    });

    it("returns nothing when both sides are empty", () => {
      expect(matchTopicIdentities([], [])).toEqual([]);
    });

    it("treats a topic with no members as matching nothing", () => {
      expect(matchTopicIdentities([topic("t-1", [])], [topic("c-1", ids("m", 1, 3))])).toEqual([
        { kind: "emerged", clusterId: "c-1", parentTopicIds: [], viaCentroidFallback: false },
        { kind: "dissolved", topicId: "t-1", parentTopicIds: [], viaCentroidFallback: false },
      ]);
    });
  });

  describe("thresholds", () => {
    it("defaults to the values the algorithm note specifies", () => {
      expect(DEFAULT_TOPIC_IDENTITY_OPTIONS.tauSurvive).toBe(0.5);
      expect(DEFAULT_TOPIC_IDENTITY_OPTIONS.tauPart).toBe(0.3);
    });

    describe("at tauSurvive exactly", () => {
      // c-1 holds exactly half of t-1: containment(t-1 -> c-1) is 2/4, which is
      // exact in binary, so this really is the boundary and not a near miss.
      const priors = [topic("t-1", ids("m", 1, 4))];
      const clusters = [
        topic("c-1", ids("m", 1, 2)),
        topic("c-2", ["m3"]),
        topic("c-3", ["m4"]),
      ];

      it("does not survive: the threshold has to be exceeded", () => {
        expect(matchTopicIdentities(priors, clusters, { tauSurvive: 0.5 }).map((t) => t.kind))
          .toEqual(["split", "split", "split"]);
      });

      it("survives a hair below the threshold", () => {
        expect(matchTopicIdentities(priors, clusters, { tauSurvive: 0.4999 })).toEqual([
          {
            kind: "survived",
            topicId: "t-1",
            clusterId: "c-1",
            parentTopicIds: ["t-1"],
            viaCentroidFallback: false,
          },
          // t-1's identity is spent; the fragments it left behind are new.
          { kind: "emerged", clusterId: "c-2", parentTopicIds: [], viaCentroidFallback: false },
          { kind: "emerged", clusterId: "c-3", parentTopicIds: [], viaCentroidFallback: false },
        ]);
      });
    });

    describe("at tauPart exactly", () => {
      // Both containments across the weak diagonal are exactly 3/10, which is the
      // same double as the literal 0.3.
      const priors = [topic("t-1", ids("m", 1, 10)), topic("t-2", ids("m", 11, 20))];
      const clusters = [
        topic("c-1", [...ids("m", 1, 3), ...ids("m", 11, 17)]),
        topic("c-2", [...ids("m", 4, 10), ...ids("m", 18, 20)]),
      ];
      // tauSurvive is parked out of reach so this exercises tauPart alone.
      const noSurvivors = { tauSurvive: 0.99 };

      it("does not link: the threshold has to be exceeded", () => {
        expect(matchTopicIdentities(priors, clusters, { ...noSurvivors, tauPart: 0.3 })).toEqual([
          { kind: "split", clusterId: "c-1", parentTopicIds: ["t-2"], viaCentroidFallback: false },
          { kind: "split", clusterId: "c-2", parentTopicIds: ["t-1"], viaCentroidFallback: false },
        ]);
      });

      it("links a hair below the threshold, which makes both clusters merges", () => {
        expect(matchTopicIdentities(priors, clusters, { ...noSurvivors, tauPart: 0.2999 }))
          .toEqual([
            {
              kind: "merged",
              clusterId: "c-1",
              parentTopicIds: ["t-1", "t-2"],
              viaCentroidFallback: false,
            },
            {
              kind: "merged",
              clusterId: "c-2",
              parentTopicIds: ["t-1", "t-2"],
              viaCentroidFallback: false,
            },
          ]);
      });
    });
  });

  describe("input validation", () => {
    it("rejects duplicate prior topic ids", () => {
      expect(() => matchTopicIdentities([topic("t-1", ["a"]), topic("t-1", ["b"])], []))
        .toThrow(/duplicate/);
    });

    it("rejects duplicate cluster ids", () => {
      expect(() => matchTopicIdentities([], [topic("c-1", ["a"]), topic("c-1", ["b"])]))
        .toThrow(/duplicate/);
    });

    it("rejects a threshold outside [0, 1)", () => {
      expect(() => matchTopicIdentities([], [], { tauSurvive: 1 })).toThrow(/tauSurvive/);
      expect(() => matchTopicIdentities([], [], { tauPart: -0.1 })).toThrow(/tauPart/);
      expect(() => matchTopicIdentities([], [], { tauCentroid: Number.NaN }))
        .toThrow(/tauCentroid/);
    });
  });
});
