import type { CensusItem } from "../../src/types.js";

/**
 * Fixture generation deliberately uses its own PRNG rather than the package's,
 * so a determinism bug in the implementation cannot quietly move the fixtures
 * that are supposed to catch it.
 */
export const createFixtureRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const standardNormal = (random: () => number): number => {
  let u1 = random();
  while (u1 <= 0) {
    u1 = random();
  }
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

const unitize = (vector: readonly number[]): number[] => {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  return norm === 0 ? vector.map(() => 0) : vector.map((value) => value / norm);
};

export type BlobFixture = {
  readonly items: CensusItem[];
  /** Item id -> index of the blob it was planted in. */
  readonly plantedBlobById: Map<string, number>;
  readonly centers: readonly (readonly number[])[];
};

/**
 * Well-separated Gaussian-ish blobs on the unit sphere. Centers are drawn
 * independently in `dimensions` dimensions, so in any reasonable dimension they
 * are close to orthogonal (cosine distance near 1) while members sit within
 * `spread` of their own center.
 */
export const makeBlobs = (config: {
  blobCount: number;
  membersPerBlob: number | readonly number[];
  dimensions?: number;
  spread?: number;
  seed?: number;
}): BlobFixture => {
  const dimensions = config.dimensions ?? 16;
  const spread = config.spread ?? 0.03;
  const random = createFixtureRandom(config.seed ?? 12345);

  const centers: number[][] = [];
  for (let blob = 0; blob < config.blobCount; blob += 1) {
    const raw: number[] = [];
    for (let axis = 0; axis < dimensions; axis += 1) {
      raw.push(standardNormal(random));
    }
    centers.push(unitize(raw));
  }

  const items: CensusItem[] = [];
  const plantedBlobById = new Map<string, number>();
  for (let blob = 0; blob < config.blobCount; blob += 1) {
    const members = typeof config.membersPerBlob === "number"
      ? config.membersPerBlob
      : config.membersPerBlob[blob];
    for (let member = 0; member < members; member += 1) {
      const center = centers[blob];
      const raw = center.map((value) => value + standardNormal(random) * spread);
      const id = `b${blob}-m${member}`;
      items.push({ id, text: `blob ${blob} member ${member}`, vector: unitize(raw) });
      plantedBlobById.set(id, blob);
    }
  }

  return { items, plantedBlobById, centers };
};

/** Deterministic shuffle driven by the fixture PRNG (Fisher-Yates). */
export const shuffled = <T>(values: readonly T[], seed: number): T[] => {
  const random = createFixtureRandom(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = copy[index];
    copy[index] = copy[swap];
    copy[swap] = held;
  }
  return copy;
};

/**
 * Order-independent description of a partition: sorted members inside sorted
 * groups. Two partitions with the same signature contain the same groups.
 */
export const partitionSignature = (groups: readonly (readonly string[])[]): string =>
  groups
    .map((group) => [...group].sort().join(","))
    .sort()
    .join(" | ");

/** Groups member indices by assignment, for comparing raw k-means output. */
export const groupsFromAssignments = (assignments: readonly number[]): string[][] => {
  const byCluster = new Map<number, string[]>();
  assignments.forEach((cluster, index) => {
    const existing = byCluster.get(cluster);
    if (existing) {
      existing.push(String(index));
      return;
    }
    byCluster.set(cluster, [String(index)]);
  });
  return [...byCluster.values()];
};
