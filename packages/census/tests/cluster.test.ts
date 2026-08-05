import { describe, expect, it } from "vitest";

import { computeCensus, deriveBaseK, percentile } from "../src/cluster.js";
import type { CensusItem, CensusResult } from "../src/types.js";
import { makeBlobs, partitionSignature, shuffled } from "./support/fixtures.js";

const zeroItem = (id: string, dimensions: number): CensusItem => ({
  id,
  text: "no direction",
  vector: Array.from({ length: dimensions }, () => 0),
});

const identicalItems = (count: number): CensusItem[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: `same-${index}`,
    text: "identical",
    vector: [0.6, 0.8, 0],
  }));

const allMemberIds = (result: CensusResult): string[] =>
  result.clusters.flatMap((cluster) => [...cluster.memberIds]);

const plantedSignature = (fixture: ReturnType<typeof makeBlobs>, blobCount: number): string =>
  partitionSignature(
    Array.from({ length: blobCount }, (_unused, blob) =>
      fixture.items
        .filter((item) => fixture.plantedBlobById.get(item.id) === blob)
        .map((item) => item.id)),
  );

describe("deriveBaseK", () => {
  const bounds = { targetMembers: 20, kMin: 2, kMax: 240 };

  it("derives k from the target average cluster size", () => {
    expect(deriveBaseK(100, bounds)).toBe(5);
    expect(deriveBaseK(1000, bounds)).toBe(50);
    expect(deriveBaseK(101, bounds)).toBe(6);
  });

  it("clamps to kMin and kMax", () => {
    expect(deriveBaseK(30, bounds)).toBe(2);
    expect(deriveBaseK(100000, bounds)).toBe(240);
    expect(deriveBaseK(400, { targetMembers: 20, kMin: 25, kMax: 240 })).toBe(25);
    expect(deriveBaseK(400, { targetMembers: 20, kMin: 2, kMax: 8 })).toBe(8);
  });

  it("never asks for more clusters than points", () => {
    expect(deriveBaseK(1, bounds)).toBe(1);
    expect(deriveBaseK(0, bounds)).toBe(0);
    expect(deriveBaseK(3, { targetMembers: 1, kMin: 2, kMax: 240 })).toBe(3);
  });

  it("honours a different target size", () => {
    expect(deriveBaseK(60, { targetMembers: 15, kMin: 2, kMax: 240 })).toBe(4);
    expect(deriveBaseK(60, { targetMembers: 10, kMin: 2, kMax: 240 })).toBe(6);
  });
});

describe("percentile", () => {
  it("interpolates linearly between closest ranks", () => {
    expect(percentile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 12);
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12);
    expect(percentile([0, 10], 0.9)).toBeCloseTo(9, 12);
  });

  it("returns exact values at the ends", () => {
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 1)).toBe(5);
    expect(percentile([7], 0.9)).toBe(7);
  });

  it("returns zero for no values", () => {
    expect(percentile([], 0.9)).toBe(0);
  });

  it("does not depend on input order", () => {
    expect(percentile([4, 1, 3, 2], 0.9)).toBe(percentile([2, 3, 1, 4], 0.9));
  });
});

describe("computeCensus determinism", () => {
  const fixture = makeBlobs({ blobCount: 5, membersPerBlob: 18, seed: 31 });
  const options = { seed: "workspace-42:2026-08", targetMembers: 18, marginFactor: 50 };

  it("returns identical output across runs", () => {
    expect(computeCensus(fixture.items, options)).toEqual(computeCensus(fixture.items, options));
  });

  it("is unaffected by the order of the input array", () => {
    const inOrder = computeCensus(fixture.items, options);
    for (const shuffleSeed of [1, 2, 3]) {
      const outOfOrder = computeCensus(shuffled(fixture.items, shuffleSeed), options);
      expect(outOfOrder).toEqual(inOrder);
      expect(partitionSignature(outOfOrder.clusters.map((cluster) => cluster.memberIds)))
        .toBe(partitionSignature(inOrder.clusters.map((cluster) => cluster.memberIds)));
    }
  });

  it("changes when the seed changes only if the data is ambiguous", () => {
    const other = computeCensus(fixture.items, { ...options, seed: "workspace-42:2026-09" });
    // Well-separated data reaches the same partition from any seed; the point of
    // the assertion is that a seed change never corrupts the result.
    expect(partitionSignature(other.clusters.map((cluster) => cluster.memberIds)))
      .toBe(partitionSignature(computeCensus(fixture.items, options).clusters.map((c) => c.memberIds)));
  });

  it("orders members by id and clusters by descending size", () => {
    const result = computeCensus(fixture.items, options);
    for (const cluster of result.clusters) {
      expect([...cluster.memberIds]).toEqual([...cluster.memberIds].sort());
    }
    const sizes = result.clusters.map((cluster) => cluster.memberIds.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect([...result.unclassifiedIds]).toEqual([...result.unclassifiedIds].sort());
  });
});

describe("computeCensus separation", () => {
  it("recovers well-separated planted blobs", () => {
    const fixture = makeBlobs({ blobCount: 4, membersPerBlob: 15, seed: 7 });
    const result = computeCensus(fixture.items, {
      seed: "separation",
      targetMembers: 15,
      marginFactor: 50,
    });
    expect(result.unclassifiedIds).toEqual([]);
    expect(partitionSignature(result.clusters.map((cluster) => cluster.memberIds)))
      .toBe(plantedSignature(fixture, 4));
  });

  it("keeps every input accounted for exactly once", () => {
    const fixture = makeBlobs({ blobCount: 6, membersPerBlob: 11, seed: 19 });
    const result = computeCensus(fixture.items, { seed: "coverage", targetMembers: 11 });
    const accounted = [...allMemberIds(result), ...result.unclassifiedIds].sort();
    expect(accounted).toEqual(fixture.items.map((item) => item.id).sort());
  });
});

describe("computeCensus hierarchy", () => {
  const fixture = makeBlobs({ blobCount: 12, membersPerBlob: 25, seed: 5 });
  const result = computeCensus(fixture.items, {
    seed: "hierarchy",
    targetMembers: 20,
    topicTarget: 10,
    marginFactor: 50,
  });

  it("agglomerates base clusters to the top-level target", () => {
    expect(result.clusters.length).toBeGreaterThan(0);
    expect(result.clusters.length).toBeLessThanOrEqual(10);
    const baseCount = result.clusters.reduce((total, cluster) => total + cluster.baseClusters.length, 0);
    expect(baseCount).toBeGreaterThanOrEqual(result.clusters.length);
    expect(baseCount).toBeLessThanOrEqual(deriveBaseK(300, { targetMembers: 20, kMin: 2, kMax: 240 }));
  });

  it("keeps each top-level cluster the exact union of its base clusters", () => {
    for (const cluster of result.clusters) {
      const fromBase = cluster.baseClusters.flatMap((base) => [...base.memberIds]).sort();
      expect(fromBase).toEqual([...cluster.memberIds].sort());
      expect(new Set(fromBase).size).toBe(fromBase.length);
    }
  });

  it("assigns every base cluster to exactly one top-level cluster", () => {
    const baseIds = result.clusters.flatMap((cluster) => cluster.baseClusters.map((base) => base.id));
    expect(new Set(baseIds).size).toBe(baseIds.length);
  });
});

describe("computeCensus radius and unclassified", () => {
  it("reports a far outlier as unclassified", () => {
    const fixture = makeBlobs({ blobCount: 4, membersPerBlob: [12, 12, 12, 1], seed: 23 });
    const outlierId = "b3-m0";
    const result = computeCensus(fixture.items, { seed: "outlier", targetMembers: 13 });

    expect(result.unclassifiedIds).toContain(outlierId);
    expect(allMemberIds(result)).not.toContain(outlierId);
    expect(partitionSignature(result.clusters.map((cluster) => cluster.memberIds)))
      .toBe(partitionSignature([
        fixture.items.filter((item) => fixture.plantedBlobById.get(item.id) === 0).map((i) => i.id),
        fixture.items.filter((item) => fixture.plantedBlobById.get(item.id) === 1).map((i) => i.id),
        fixture.items.filter((item) => fixture.plantedBlobById.get(item.id) === 2).map((i) => i.id),
      ]));
  });

  it("derives the radius from the members that remain", () => {
    const fixture = makeBlobs({ blobCount: 4, membersPerBlob: [12, 12, 12, 1], seed: 23 });
    const result = computeCensus(fixture.items, { seed: "outlier", targetMembers: 13 });
    for (const cluster of result.clusters) {
      expect(cluster.radius).toBeGreaterThanOrEqual(0);
      expect(cluster.radius).toBeLessThan(0.5);
    }
  });

  it("dissolves a cluster below the minimum size", () => {
    const fixture = makeBlobs({ blobCount: 4, membersPerBlob: [12, 12, 12, 2], seed: 29 });
    const tinyIds = fixture.items
      .filter((item) => fixture.plantedBlobById.get(item.id) === 3)
      .map((item) => item.id);
    const result = computeCensus(fixture.items, {
      seed: "dissolve",
      targetMembers: 10,
      minClusterSize: 5,
      marginFactor: 50,
    });

    expect(result.clusters).toHaveLength(3);
    expect([...result.unclassifiedIds].sort()).toEqual([...tinyIds].sort());
    for (const cluster of result.clusters) {
      expect(cluster.memberIds.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("keeps the same cluster when the minimum size allows it", () => {
    const fixture = makeBlobs({ blobCount: 4, membersPerBlob: [12, 12, 12, 2], seed: 29 });
    const result = computeCensus(fixture.items, {
      seed: "dissolve",
      targetMembers: 10,
      minClusterSize: 2,
      marginFactor: 50,
    });
    expect(result.clusters).toHaveLength(4);
    expect(result.unclassifiedIds).toEqual([]);
  });
});

describe("computeCensus edge cases", () => {
  it("handles empty input", () => {
    expect(computeCensus([], { seed: "empty" })).toEqual({ clusters: [], unclassifiedIds: [] });
  });

  it("dissolves a single item under the default minimum size", () => {
    const result = computeCensus([{ id: "only", text: "one", vector: [1, 0, 0] }], { seed: "one" });
    expect(result.clusters).toEqual([]);
    expect(result.unclassifiedIds).toEqual(["only"]);
  });

  it("returns a single item as its own cluster when the minimum allows it", () => {
    const result = computeCensus(
      [{ id: "only", text: "one", vector: [3, 4, 0] }],
      { seed: "one", minClusterSize: 1 },
    );
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberIds).toEqual(["only"]);
    expect(result.clusters[0].radius).toBeCloseTo(0, 12);
    expect(result.clusters[0].centroid[0]).toBeCloseTo(0.6, 12);
    expect(result.unclassifiedIds).toEqual([]);
  });

  it("puts identical vectors in one cluster with zero radius", () => {
    const result = computeCensus(identicalItems(8), { seed: "identical", targetMembers: 4 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberIds).toHaveLength(8);
    expect(result.clusters[0].radius).toBeCloseTo(0, 12);
    expect(result.unclassifiedIds).toEqual([]);
  });

  it("reports a zero vector as unclassified", () => {
    const fixture = makeBlobs({ blobCount: 3, membersPerBlob: 12, seed: 11 });
    const items = [...fixture.items, zeroItem("zzz-zero", 16)];
    const result = computeCensus(items, { seed: "zero", targetMembers: 13 });
    expect(result.unclassifiedIds).toContain("zzz-zero");
    expect(allMemberIds(result)).not.toContain("zzz-zero");
  });

  it("rejects duplicate ids", () => {
    const duplicate = [
      { id: "a", text: "one", vector: [1, 0] },
      { id: "a", text: "two", vector: [0, 1] },
    ];
    expect(() => computeCensus(duplicate, { seed: "dup" })).toThrow(/duplicate/i);
  });

  it("rejects vectors of differing length", () => {
    const ragged = [
      { id: "a", text: "one", vector: [1, 0] },
      { id: "b", text: "two", vector: [0, 1, 0] },
    ];
    expect(() => computeCensus(ragged, { seed: "ragged" })).toThrow(/dimension/i);
  });

  it("rejects a non-finite vector component", () => {
    const broken = [
      { id: "a", text: "one", vector: [1, 0] },
      { id: "b", text: "two", vector: [Number.NaN, 1] },
    ];
    expect(() => computeCensus(broken, { seed: "broken" })).toThrow(/finite/i);
  });

  it("rejects nonsensical options", () => {
    const items = identicalItems(4);
    expect(() => computeCensus(items, { seed: "x", targetMembers: 0 })).toThrow(/targetMembers/);
    expect(() => computeCensus(items, { seed: "x", restarts: 0 })).toThrow(/restarts/);
    expect(() => computeCensus(items, { seed: "x", kMin: 5, kMax: 2 })).toThrow(/kMax/);
    expect(() => computeCensus(items, { seed: "x", topicTarget: 0 })).toThrow(/topicTarget/);
    expect(() => computeCensus(items, { seed: "x", marginFactor: -1 })).toThrow(/marginFactor/);
  });
});
