import { toUnitVector, unitCosineDistance } from "./vector.js";

/**
 * Seeded k-means over unit vectors under cosine distance.
 *
 * Reproducibility is the point of this module: the same vectors, k, restart
 * count, iteration cap, and seed must produce byte-identical output on any
 * platform and any Node version. That holds because
 *
 *  - randomness comes only from the seeded PRNG below, never `Math.random`;
 *  - the PRNG is integer-only (`Math.imul`, shifts, xor), so it cannot drift
 *    with floating-point library differences;
 *  - each restart draws from its own stream derived from the seed and the
 *    restart index, so a restart's result does not depend on how many numbers
 *    earlier restarts happened to consume;
 *  - every scan that could tie -- nearest centroid, best restart, k-means++
 *    fallbacks -- is resolved by the lowest index, using a strict comparison
 *    while iterating in ascending order;
 *  - every summation runs in ascending point order, since floating-point
 *    addition is not associative.
 *
 * It does *not* hold across a change to input order: this module works
 * positionally, and `cluster.ts` owns canonicalizing the input before calling.
 */

export type KMeansRequest = {
  /** Unit vectors, all of the same dimension. */
  readonly vectors: readonly (readonly number[])[];
  readonly k: number;
  readonly restarts: number;
  readonly maxIterations: number;
  readonly seed: string;
};

export type KMeansRun = {
  /** Index into `centroids` for each input vector, positionally aligned. */
  readonly assignments: readonly number[];
  readonly centroids: readonly (readonly number[])[];
  /** Sum of squared distances from each point to its assigned centroid. */
  readonly inertia: number;
};

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over the UTF-16 code units of the seed, low byte first. Hashing both
 * bytes of each code unit keeps non-ASCII seeds distinguishable.
 */
export const hashSeed = (seed: string): number => {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < seed.length; index += 1) {
    const unit = seed.charCodeAt(index);
    hash = Math.imul(hash ^ (unit & 0xff), FNV_PRIME);
    hash = Math.imul(hash ^ ((unit >>> 8) & 0xff), FNV_PRIME);
  }
  return hash >>> 0;
};

/** mulberry32, seeded from the string hash. Returns values in `[0, 1)`. */
export const createRandom = (seed: string): (() => number) => {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * k-means++ seeding: the first center is uniform, each later center is drawn
 * with probability proportional to its squared distance to the nearest center
 * already chosen.
 */
const chooseInitialCenters = (
  vectors: readonly (readonly number[])[],
  k: number,
  random: () => number,
): number[] => {
  const count = vectors.length;
  const centerIndices: number[] = [];
  const isCenter = new Array<boolean>(count).fill(false);
  const nearestSquared = new Array<number>(count).fill(Number.POSITIVE_INFINITY);

  const take = (index: number): void => {
    centerIndices.push(index);
    isCenter[index] = true;
    for (let point = 0; point < count; point += 1) {
      const distance = unitCosineDistance(vectors[point], vectors[index]);
      const squared = distance * distance;
      if (squared < nearestSquared[point]) {
        nearestSquared[point] = squared;
      }
    }
  };

  take(Math.min(count - 1, Math.floor(random() * count)));

  while (centerIndices.length < k) {
    // Points already chosen contribute nothing, which also stops a zero vector
    // -- whose distance to itself is 1, not 0 -- from being chosen twice.
    let total = 0;
    for (let point = 0; point < count; point += 1) {
      total += isCenter[point] ? 0 : nearestSquared[point];
    }

    if (total <= 0) {
      // Every remaining point coincides with a center already chosen, so the
      // draw carries no information. Take the lowest free index instead of
      // consuming randomness that cannot distinguish the candidates.
      const fallback = isCenter.indexOf(false);
      if (fallback === -1) {
        break;
      }
      take(fallback);
      continue;
    }

    const target = random() * total;
    let cumulative = 0;
    let picked = -1;
    for (let point = 0; point < count; point += 1) {
      cumulative += isCenter[point] ? 0 : nearestSquared[point];
      // Strictly greater, so the picked point always carries positive weight.
      if (cumulative > target) {
        picked = point;
        break;
      }
    }

    if (picked === -1) {
      // The running sum can finish a hair below `total` through rounding. Fall
      // back to the heaviest free point, ties to the lowest index.
      let bestWeight = -1;
      for (let point = 0; point < count; point += 1) {
        const weight = isCenter[point] ? 0 : nearestSquared[point];
        if (weight > bestWeight) {
          bestWeight = weight;
          picked = point;
        }
      }
    }

    take(picked);
  }

  return centerIndices;
};

const runOnce = (
  vectors: readonly (readonly number[])[],
  k: number,
  maxIterations: number,
  random: () => number,
): KMeansRun => {
  const count = vectors.length;
  const dimensions = vectors[0].length;
  const centroids: number[][] = chooseInitialCenters(vectors, k, random)
    .map((index) => [...vectors[index]]);
  const assignments = new Array<number>(count).fill(-1);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let changed = false;
    for (let point = 0; point < count; point += 1) {
      let best = 0;
      let bestDistance = unitCosineDistance(vectors[point], centroids[0]);
      for (let cluster = 1; cluster < centroids.length; cluster += 1) {
        const distance = unitCosineDistance(vectors[point], centroids[cluster]);
        // Strictly closer, so an equidistant point keeps the lowest cluster.
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cluster;
        }
      }
      if (assignments[point] !== best) {
        assignments[point] = best;
        changed = true;
      }
    }

    if (!changed) {
      break;
    }

    const sums = centroids.map(() => new Array<number>(dimensions).fill(0));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let point = 0; point < count; point += 1) {
      const cluster = assignments[point];
      counts[cluster] += 1;
      const vector = vectors[point];
      const target = sums[cluster];
      for (let axis = 0; axis < dimensions; axis += 1) {
        target[axis] += vector[axis];
      }
    }
    for (let cluster = 0; cluster < centroids.length; cluster += 1) {
      // An emptied cluster keeps its centroid rather than being reseeded from
      // the data: reseeding would make the result depend on which point was
      // "farthest" under floating point, and callers drop empty clusters.
      if (counts[cluster] === 0) {
        continue;
      }
      centroids[cluster] = toUnitVector(sums[cluster]);
    }
  }

  let inertia = 0;
  for (let point = 0; point < count; point += 1) {
    const distance = unitCosineDistance(vectors[point], centroids[assignments[point]]);
    inertia += distance * distance;
  }

  return { assignments, centroids, inertia };
};

/**
 * Runs `restarts` independent k-means attempts and keeps the lowest-inertia
 * one. `k` is capped at the number of points. Ties keep the earliest restart.
 */
export const runKMeans = (request: KMeansRequest): KMeansRun => {
  if (!Number.isInteger(request.k) || request.k < 1) {
    throw new Error(`census: k must be a positive integer, received ${request.k}`);
  }
  if (!Number.isInteger(request.restarts) || request.restarts < 1) {
    throw new Error(`census: restarts must be a positive integer, received ${request.restarts}`);
  }
  if (!Number.isInteger(request.maxIterations) || request.maxIterations < 1) {
    throw new Error(
      `census: maxIterations must be a positive integer, received ${request.maxIterations}`,
    );
  }

  const count = request.vectors.length;
  if (count === 0) {
    return { assignments: [], centroids: [], inertia: 0 };
  }

  const k = Math.min(request.k, count);
  let best: KMeansRun | null = null;
  for (let restart = 0; restart < request.restarts; restart += 1) {
    // A stream per restart, so restart r is independent of how many draws
    // restarts 0..r-1 made.
    const random = createRandom(`${request.seed}#restart:${restart}`);
    const run = runOnce(request.vectors, k, request.maxIterations, random);
    // Strictly lower, so equal inertia keeps the earliest restart index.
    if (best === null || run.inertia < best.inertia) {
      best = run;
    }
  }

  return best as KMeansRun;
};
