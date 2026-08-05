import { describe, expect, it } from "vitest";

import { createRandom, hashSeed, runKMeans } from "../src/kmeans.js";
import { toUnitVector, unitCosineDistance } from "../src/vector.js";
import { groupsFromAssignments, makeBlobs, partitionSignature } from "./support/fixtures.js";

const unitVectors = (items: readonly { vector: readonly number[] }[]): number[][] =>
  items.map((item) => toUnitVector(item.vector));

const draw = (seed: string, count: number): number[] => {
  const random = createRandom(seed);
  return Array.from({ length: count }, () => random());
};

describe("seeded PRNG", () => {
  it("produces the same stream for the same seed", () => {
    expect(draw("census", 12)).toEqual(draw("census", 12));
  });

  it("produces a different stream for a different seed", () => {
    expect(draw("census-a", 12)).not.toEqual(draw("census-b", 12));
  });

  it("stays inside [0, 1)", () => {
    for (const value of draw("range", 500)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("hashes seed strings to a stable 32-bit value", () => {
    expect(hashSeed("census")).toBe(hashSeed("census"));
    expect(hashSeed("census")).not.toBe(hashSeed("censux"));
    expect(Number.isInteger(hashSeed("census"))).toBe(true);
    expect(hashSeed("census")).toBeGreaterThanOrEqual(0);
    expect(hashSeed("census")).toBeLessThanOrEqual(0xffffffff);
  });

  it("distinguishes seeds that differ only above the ASCII range", () => {
    expect(hashSeed("café")).not.toBe(hashSeed("cafe"));
    expect(hashSeed("你好")).not.toBe(hashSeed("好你"));
  });

  /**
   * A golden vector. Its only job is to fail loudly if the PRNG ever changes
   * shape, because every committed clustering result depends on this stream.
   */
  it("matches its recorded stream", () => {
    expect(draw("census", 4).map((value) => value.toFixed(12))).toEqual([
      "0.233584385598",
      "0.606186801801",
      "0.332844730001",
      "0.303970347857",
    ]);
  });
});

describe("runKMeans", () => {
  const blobs = makeBlobs({ blobCount: 4, membersPerBlob: 15, seed: 7 });
  const vectors = unitVectors(blobs.items);

  it("returns identical output for identical input", () => {
    const first = runKMeans({ vectors, k: 4, restarts: 5, maxIterations: 50, seed: "s" });
    const second = runKMeans({ vectors, k: 4, restarts: 5, maxIterations: 50, seed: "s" });
    expect(first).toEqual(second);
  });

  it("converges to the planted partition from different seeds", () => {
    const signatures = ["alpha", "beta", "gamma"].map((seed) => {
      const run = runKMeans({ vectors, k: 4, restarts: 5, maxIterations: 50, seed });
      return partitionSignature(groupsFromAssignments(run.assignments));
    });
    expect(signatures[1]).toBe(signatures[0]);
    expect(signatures[2]).toBe(signatures[0]);

    const planted = partitionSignature(
      Array.from({ length: 4 }, (_unused, blob) =>
        blobs.items
          .map((item, index) => ({ item, index }))
          .filter((entry) => blobs.plantedBlobById.get(entry.item.id) === blob)
          .map((entry) => String(entry.index))),
    );
    expect(signatures[0]).toBe(planted);
  });

  it("never returns a worse solution with more restarts", () => {
    const once = runKMeans({ vectors, k: 4, restarts: 1, maxIterations: 50, seed: "s" });
    const many = runKMeans({ vectors, k: 4, restarts: 8, maxIterations: 50, seed: "s" });
    expect(many.inertia).toBeLessThanOrEqual(once.inertia);
  });

  it("keeps the earliest restart when inertias tie", () => {
    // Identical vectors make every restart produce the same inertia, so the
    // winner can only be decided by restart index.
    const identical = Array.from({ length: 6 }, () => toUnitVector([1, 0, 0]));
    const single = runKMeans({ vectors: identical, k: 2, restarts: 1, maxIterations: 20, seed: "t" });
    const eight = runKMeans({ vectors: identical, k: 2, restarts: 8, maxIterations: 20, seed: "t" });
    expect(eight).toEqual(single);
  });

  it("handles empty input", () => {
    const run = runKMeans({ vectors: [], k: 3, restarts: 3, maxIterations: 20, seed: "s" });
    expect(run.assignments).toEqual([]);
    expect(run.centroids).toEqual([]);
    expect(run.inertia).toBe(0);
  });

  it("handles a single point", () => {
    const run = runKMeans({
      vectors: [toUnitVector([3, 4, 0])],
      k: 3,
      restarts: 3,
      maxIterations: 20,
      seed: "s",
    });
    expect(run.assignments).toEqual([0]);
    expect(run.centroids).toHaveLength(1);
    expect(run.inertia).toBeCloseTo(0, 12);
  });

  it("clamps k to the number of points", () => {
    const three = [
      toUnitVector([1, 0, 0]),
      toUnitVector([0, 1, 0]),
      toUnitVector([0, 0, 1]),
    ];
    const run = runKMeans({ vectors: three, k: 9, restarts: 3, maxIterations: 20, seed: "s" });
    expect(run.centroids).toHaveLength(3);
    expect(new Set(run.assignments).size).toBe(3);
    expect(run.inertia).toBeCloseTo(0, 12);
  });

  it("collapses identical vectors into one occupied cluster", () => {
    const identical = Array.from({ length: 7 }, () => toUnitVector([0.5, 0.5, 0]));
    const run = runKMeans({ vectors: identical, k: 3, restarts: 4, maxIterations: 20, seed: "s" });
    expect(new Set(run.assignments).size).toBe(1);
    expect(run.inertia).toBeCloseTo(0, 12);
  });

  it("treats a zero vector as orthogonal to everything instead of failing", () => {
    const withZero = [
      toUnitVector([1, 0, 0]),
      toUnitVector([1, 0.01, 0]),
      toUnitVector([0, 0, 0]),
    ];
    const run = runKMeans({ vectors: withZero, k: 2, restarts: 3, maxIterations: 20, seed: "s" });
    expect(Number.isFinite(run.inertia)).toBe(true);
    for (const centroid of run.centroids) {
      expect(centroid.every((value) => Number.isFinite(value))).toBe(true);
    }
    expect(unitCosineDistance(withZero[2], withZero[0])).toBe(1);
    expect(unitCosineDistance(withZero[2], withZero[2])).toBe(1);
  });

  it("never reports a negative distance from rounding", () => {
    // A negative distance would give a cluster of identical members a negative
    // radius, and the margin rule would then dissolve the whole cluster.
    const unit = toUnitVector([0.6, 0.8, 0]);
    expect(unitCosineDistance(unit, unit)).toBeGreaterThanOrEqual(0);
    expect(unitCosineDistance(unit, unit)).toBeCloseTo(0, 12);
  });

  it("rejects a non-positive k", () => {
    expect(() => runKMeans({
      vectors: [toUnitVector([1, 0])],
      k: 0,
      restarts: 1,
      maxIterations: 5,
      seed: "s",
    })).toThrow(/k/i);
  });
});
