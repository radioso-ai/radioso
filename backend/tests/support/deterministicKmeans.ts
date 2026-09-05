/**
 * Seeded k-means over unit-normalized vectors, for the facet-quality eval.
 *
 * `@radioso/census` owns the production clustering; it exports contracts but no
 * algorithm yet. This is a self-contained stand-in with the same shape — items
 * carry an id and a precomputed vector, the run is fully determined by its seed
 * — so the eval measures the facet space rather than a clustering
 * implementation, and swaps to `computeCensus` without changing its scoring.
 */

export interface ClusterableItem {
  id: string;
  vector: readonly number[];
}

export interface KmeansOptions {
  clusterCount: number;
  seed: string;
  restarts?: number;
  maxIterations?: number;
}

/** `assignments[i]` is the cluster index of `items[i]`. */
export interface KmeansResult {
  assignments: readonly number[];
  inertia: number;
}

const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/** mulberry32: small, fast, and identical across runs and platforms. */
const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

export const unitNormalize = (vector: readonly number[]): number[] => {
  let sumOfSquares = 0;
  for (const value of vector) {
    sumOfSquares += value * value;
  }
  const magnitude = Math.sqrt(sumOfSquares);
  return magnitude === 0 ? [...vector] : vector.map((value) => value / magnitude);
};

const squaredDistance = (left: readonly number[], right: readonly number[]): number => {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    total += delta * delta;
  }
  return total;
};

/** Lowest index wins a tie, so assignment never depends on iteration order. */
const nearestCentroid = (vector: readonly number[], centroids: readonly number[][]): number => {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < centroids.length; index += 1) {
    const distance = squaredDistance(vector, centroids[index]);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
};

const kmeansPlusPlusInit = (
  vectors: readonly number[][],
  clusterCount: number,
  random: () => number,
): number[][] => {
  const centroids: number[][] = [[...vectors[Math.floor(random() * vectors.length)]]];

  while (centroids.length < clusterCount) {
    const distances = vectors.map((vector) => squaredDistance(vector, centroids[nearestCentroid(vector, centroids)]));
    const total = distances.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      centroids.push([...vectors[centroids.length % vectors.length]]);
      continue;
    }
    let threshold = random() * total;
    let chosen = vectors.length - 1;
    for (let index = 0; index < distances.length; index += 1) {
      threshold -= distances[index];
      if (threshold <= 0) {
        chosen = index;
        break;
      }
    }
    centroids.push([...vectors[chosen]]);
  }

  return centroids;
};

const recomputeCentroids = (
  vectors: readonly number[][],
  assignments: readonly number[],
  clusterCount: number,
  previous: readonly number[][],
): number[][] => {
  const dimensions = vectors[0].length;
  const sums = Array.from({ length: clusterCount }, () => new Array<number>(dimensions).fill(0));
  const counts = new Array<number>(clusterCount).fill(0);

  for (let index = 0; index < vectors.length; index += 1) {
    const cluster = assignments[index];
    counts[cluster] += 1;
    const vector = vectors[index];
    const sum = sums[cluster];
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      sum[dimension] += vector[dimension];
    }
  }

  return sums.map((sum, cluster) => {
    const count = counts[cluster];
    // An emptied cluster keeps its previous centroid rather than drifting to the
    // origin, which would silently pull unrelated points into it next round.
    if (count === 0) {
      return [...previous[cluster]];
    }
    return sum.map((value) => value / count);
  });
};

const runOnce = (
  vectors: readonly number[][],
  clusterCount: number,
  random: () => number,
  maxIterations: number,
): KmeansResult => {
  let centroids = kmeansPlusPlusInit(vectors, clusterCount, random);
  let assignments = vectors.map((vector) => nearestCentroid(vector, centroids));

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    centroids = recomputeCentroids(vectors, assignments, clusterCount, centroids);
    const next = vectors.map((vector) => nearestCentroid(vector, centroids));
    const settled = next.every((cluster, index) => cluster === assignments[index]);
    assignments = next;
    if (settled) {
      break;
    }
  }

  const inertia = vectors.reduce(
    (total, vector, index) => total + squaredDistance(vector, centroids[assignments[index]]),
    0,
  );
  return { assignments, inertia };
};

/**
 * Runs `restarts` seeded initializations and keeps the lowest-inertia solution.
 * Identical input and seed always produce identical output.
 */
export const clusterDeterministically = (
  items: readonly ClusterableItem[],
  options: KmeansOptions,
): KmeansResult => {
  const { clusterCount, seed, restarts = 12, maxIterations = 100 } = options;
  if (items.length === 0) {
    return { assignments: [], inertia: 0 };
  }
  if (clusterCount <= 1 || items.length <= clusterCount) {
    return { assignments: items.map((_, index) => Math.min(index, clusterCount - 1)), inertia: 0 };
  }

  const vectors = items.map((item) => unitNormalize(item.vector));
  let best: KmeansResult | null = null;

  for (let restart = 0; restart < restarts; restart += 1) {
    const random = createRandom(hashSeed(`${seed}#${restart}`));
    const candidate = runOnce(vectors, clusterCount, random, maxIterations);
    if (best === null || candidate.inertia < best.inertia) {
      best = candidate;
    }
  }

  return best!;
};
