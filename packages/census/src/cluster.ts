import { runKMeans } from "./kmeans.js";
import type {
  CensusCluster,
  CensusItem,
  CensusOptions,
  CensusResult,
  CensusSubcluster,
  ResolvedCensusOptions,
} from "./types.js";
import { toUnitVector, unitCentroid, unitCosineDistance } from "./vector.js";

/**
 * Census policy on top of k-means: how many clusters to ask for, how to
 * agglomerate them into operator-visible topics, how wide a topic is, and what
 * falls outside every topic.
 *
 * k-means assigns every point to some cluster, so "unclassified" needs its own
 * rule. Two apply, in this order:
 *
 *  1. Distance. Each cluster learns a radius from its own members, so a tight
 *     cluster gets a tight bound and a broad one a broad bound, with no global
 *     threshold to tune per workspace or per language. A member beyond
 *     `radius * marginFactor` is unclassified.
 *  2. Size. A cluster left below `minClusterSize` is not a topic; all of its
 *     members are unclassified.
 *
 * Removing outliers shifts the centroid, which shifts the radius, which could
 * remove more members. That loop is deliberately not run to convergence: it
 * would peel a cluster down over successive passes with no principled stopping
 * point. Exactly one recomputation happens after the removal, and the reported
 * centroid and radius describe the members that remain.
 */

/** The percentile of member-to-centroid distance that defines a cluster's radius. */
export const RADIUS_PERCENTILE = 0.9;

export const DEFAULT_CENSUS_OPTIONS: Omit<ResolvedCensusOptions, "seed"> = {
  targetMembers: 20,
  minClusterSize: 3,
  restarts: 5,
  maxIterations: 50,
  // A member has to sit half again beyond the 90th percentile before it is
  // called unclassified: unclassified is meant to be a finding, not the tail
  // of every healthy cluster.
  marginFactor: 1.5,
  kMin: 2,
  kMax: 240,
  topicTarget: 10,
};

const requirePositiveInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`census: ${name} must be a positive integer, received ${value}`);
  }
};

const resolveOptions = (options: CensusOptions): ResolvedCensusOptions => {
  const resolved: ResolvedCensusOptions = { ...DEFAULT_CENSUS_OPTIONS, ...options };
  if (typeof resolved.seed !== "string" || resolved.seed.length === 0) {
    throw new Error("census: seed must be a non-empty string");
  }
  requirePositiveInteger(resolved.targetMembers, "targetMembers");
  requirePositiveInteger(resolved.minClusterSize, "minClusterSize");
  requirePositiveInteger(resolved.restarts, "restarts");
  requirePositiveInteger(resolved.maxIterations, "maxIterations");
  requirePositiveInteger(resolved.kMin, "kMin");
  requirePositiveInteger(resolved.kMax, "kMax");
  requirePositiveInteger(resolved.topicTarget, "topicTarget");
  if (resolved.kMax < resolved.kMin) {
    throw new Error(
      `census: kMax (${resolved.kMax}) must be at least kMin (${resolved.kMin})`,
    );
  }
  if (!Number.isFinite(resolved.marginFactor) || resolved.marginFactor < 0) {
    throw new Error(
      `census: marginFactor must be a non-negative number, received ${resolved.marginFactor}`,
    );
  }
  return resolved;
};

/**
 * Code-unit comparison. `localeCompare` is deliberately not used: its ordering
 * depends on the host's locale data, which would make the output of a run
 * depend on where it ran.
 */
const compareIds = (left: CensusItem, right: CensusItem): number => {
  if (left.id < right.id) {
    return -1;
  }
  return left.id > right.id ? 1 : 0;
};

/**
 * Sorts the input by id and validates it. Everything downstream addresses items
 * by position in this canonical array, which is what makes the result
 * independent of the order the caller supplied.
 */
const canonicalItems = (items: readonly CensusItem[]): CensusItem[] => {
  const sorted = [...items].sort(compareIds);
  for (let index = 1; index < sorted.length; index += 1) {
    // Duplicates are adjacent after sorting. They are rejected rather than
    // de-duplicated because they would silently break the guarantee that topic
    // sizes plus unclassified equal the population.
    if (sorted[index].id === sorted[index - 1].id) {
      throw new Error(`census: duplicate item id ${JSON.stringify(sorted[index].id)}`);
    }
  }
  if (sorted.length === 0) {
    return sorted;
  }
  const dimensions = sorted[0].vector.length;
  if (dimensions === 0) {
    throw new Error("census: vectors must have at least one dimension");
  }
  for (const item of sorted) {
    if (item.vector.length !== dimensions) {
      throw new Error(
        `census: every vector must have the same dimension; ${JSON.stringify(item.id)} has `
        + `${item.vector.length}, expected ${dimensions}`,
      );
    }
    for (const value of item.vector) {
      if (!Number.isFinite(value)) {
        throw new Error(
          `census: vector components must be finite; ${JSON.stringify(item.id)} has ${value}`,
        );
      }
    }
  }
  return sorted;
};

/**
 * Base `k` from a target average cluster size:
 * `clamp(ceil(n / targetMembers), kMin, kMax)`, then capped at `n` because a
 * cluster cannot be emptier than empty.
 */
export const deriveBaseK = (
  itemCount: number,
  options: Pick<ResolvedCensusOptions, "targetMembers" | "kMin" | "kMax">,
): number => {
  if (itemCount <= 0) {
    return 0;
  }
  const fromTarget = Math.ceil(itemCount / options.targetMembers);
  const clamped = Math.min(Math.max(fromTarget, options.kMin), options.kMax);
  return Math.min(clamped, itemCount);
};

/**
 * Percentile by linear interpolation between closest ranks -- the "R-7" method,
 * which is what `numpy.percentile` and Excel's `PERCENTILE.INC` use. For `n`
 * sorted values the rank is `(n - 1) * p`; a fractional rank interpolates
 * linearly between its neighbours. `p = 0` is the minimum and `p = 1` the
 * maximum, so a cluster's radius never exceeds its widest member.
 */
export const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (sorted.length - 1) * fraction;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (rank - lower) * (sorted[upper] - sorted[lower]);
};

/** Buckets point indices by cluster. Indices stay ascending within a bucket. */
const groupByAssignment = (
  assignments: readonly number[],
  clusterCount: number,
): number[][] => {
  const groups: number[][] = Array.from({ length: clusterCount }, () => []);
  for (let point = 0; point < assignments.length; point += 1) {
    groups[assignments[point]].push(point);
  }
  return groups.filter((group) => group.length > 0);
};

type PrunedCluster = {
  readonly memberIndices: readonly number[];
  readonly centroid: readonly number[];
  readonly radius: number;
  readonly removedIndices: readonly number[];
};

const pruneOutliers = (
  vectors: readonly (readonly number[])[],
  memberIndices: readonly number[],
  dimensions: number,
  marginFactor: number,
): PrunedCluster => {
  const initialCentroid = unitCentroid(vectors, memberIndices, dimensions);
  const initialDistances = memberIndices
    .map((member) => unitCosineDistance(vectors[member], initialCentroid));
  const initialRadius = percentile(initialDistances, RADIUS_PERCENTILE);
  const limit = initialRadius * marginFactor;

  const kept: number[] = [];
  const removed: number[] = [];
  for (let position = 0; position < memberIndices.length; position += 1) {
    if (initialDistances[position] <= limit) {
      kept.push(memberIndices[position]);
    } else {
      removed.push(memberIndices[position]);
    }
  }

  if (removed.length === 0) {
    return {
      memberIndices: kept,
      centroid: initialCentroid,
      radius: initialRadius,
      removedIndices: removed,
    };
  }
  if (kept.length === 0) {
    return {
      memberIndices: kept,
      centroid: initialCentroid,
      radius: 0,
      removedIndices: removed,
    };
  }

  const centroid = unitCentroid(vectors, kept, dimensions);
  const distances = kept.map((member) => unitCosineDistance(vectors[member], centroid));
  return {
    memberIndices: kept,
    centroid,
    radius: percentile(distances, RADIUS_PERCENTILE),
    removedIndices: removed,
  };
};

/**
 * Largest first, ties broken by the lowest member index -- which, since indices
 * are canonical, means the lowest member id. Equal-sized clusters therefore
 * never depend on the order they were produced in.
 */
const compareGroups = (left: readonly number[], right: readonly number[]): number => {
  if (left.length !== right.length) {
    return right.length - left.length;
  }
  return left[0] - right[0];
};

type TopLevelDraft = {
  readonly memberIndices: readonly number[];
  readonly centroid: readonly number[];
  readonly radius: number;
  readonly baseGroups: readonly (readonly number[])[];
};

/**
 * Clusters items into top-level topics.
 *
 * Base k-means over the items produces fine-grained clusters that track the
 * data; a second k-means over those base centroids agglomerates them into
 * `topicTarget` topics, whose members are the union of the members of their
 * base clusters. The hierarchy is the same primitive applied twice. Base
 * centroids are agglomerated unweighted, so a topic is a group of similar
 * base clusters rather than a group of similar-sized ones.
 *
 * Determinism: the input is sorted by id before anything else runs, so the
 * result does not depend on the order the caller supplied. Given the same items
 * and options, output is byte-identical across platforms and Node versions.
 */
export const computeCensus = (
  items: readonly CensusItem[],
  options: CensusOptions,
): CensusResult => {
  const resolved = resolveOptions(options);
  const canonical = canonicalItems(items);
  if (canonical.length === 0) {
    return { clusters: [], unclassifiedIds: [] };
  }

  const dimensions = canonical[0].vector.length;
  const vectors = canonical.map((item) => toUnitVector(item.vector));

  const baseGroups = groupByAssignment(
    runKMeans({
      vectors,
      k: deriveBaseK(canonical.length, resolved),
      restarts: resolved.restarts,
      maxIterations: resolved.maxIterations,
      seed: `${resolved.seed}#base`,
    }).assignments,
    canonical.length,
  );

  // Recomputed from the members rather than taken from the k-means run, whose
  // centroids can be one iteration stale if it hit the iteration cap.
  const baseCentroids = baseGroups
    .map((group) => unitCentroid(vectors, group, dimensions));

  const topAssignments = baseGroups.length <= resolved.topicTarget
    ? baseGroups.map((_unused, index) => index)
    : runKMeans({
      vectors: baseCentroids,
      k: resolved.topicTarget,
      restarts: resolved.restarts,
      maxIterations: resolved.maxIterations,
      seed: `${resolved.seed}#top`,
    }).assignments;

  const unclassifiedIndices: number[] = [];
  const drafts: TopLevelDraft[] = [];
  for (const topGroup of groupByAssignment(topAssignments, baseGroups.length)) {
    const memberIndices = topGroup
      .flatMap((baseIndex) => baseGroups[baseIndex])
      .sort((left, right) => left - right);
    const pruned = pruneOutliers(vectors, memberIndices, dimensions, resolved.marginFactor);
    unclassifiedIndices.push(...pruned.removedIndices);

    if (pruned.memberIndices.length < resolved.minClusterSize) {
      // Too small to be a topic once its outliers are gone.
      unclassifiedIndices.push(...pruned.memberIndices);
      continue;
    }

    const survivors = new Set(pruned.memberIndices);
    drafts.push({
      memberIndices: pruned.memberIndices,
      centroid: pruned.centroid,
      radius: pruned.radius,
      baseGroups: topGroup
        .map((baseIndex) => baseGroups[baseIndex].filter((member) => survivors.has(member)))
        .filter((group) => group.length > 0)
        .sort(compareGroups),
    });
  }

  drafts.sort((left, right) => compareGroups(left.memberIndices, right.memberIndices));

  const clusters: CensusCluster[] = drafts.map((draft, rank) => {
    const id = `cluster-${rank}`;
    const baseClusters: CensusSubcluster[] = draft.baseGroups.map((group, baseRank) => ({
      id: `${id}.base-${baseRank}`,
      memberIds: group.map((member) => canonical[member].id),
      centroid: unitCentroid(vectors, group, dimensions),
    }));
    return {
      id,
      memberIds: draft.memberIndices.map((member) => canonical[member].id),
      centroid: [...draft.centroid],
      radius: draft.radius,
      baseClusters,
    };
  });

  return {
    clusters,
    unclassifiedIds: unclassifiedIndices
      .sort((left, right) => left - right)
      .map((member) => canonical[member].id),
  };
};
