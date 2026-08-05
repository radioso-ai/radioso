import { maxWeightBipartiteMatching } from "./matching.js";
import type {
  ResolvedTopicIdentityOptions,
  TopicIdentityOptions,
  TopicMembership,
  TopicTransition,
  TopicTransitionKind,
} from "./types.js";
import { toUnitVector, unitCosineSimilarity } from "./vector.js";

/**
 * Carrying a topic's identity from one analysis to the next.
 *
 * Clusters are anonymous: nothing in a clustering run says that this run's
 * cluster 3 is last run's cluster 7. Without an answer to that, a dashboard can
 * only ever show a snapshot, and "is this growing?" is unanswerable. Successive
 * analyses run over overlapping windows and therefore share members, so the
 * primary signal is membership overlap, not centroid distance -- a topic can
 * drift a long way in embedding space while still being made of the same
 * questions, and two unrelated topics can sit close together.
 *
 * For a prior topic `A` and a new cluster `B`, over the member ids the two runs
 * have in common:
 *
 *     containment(A -> B) = |A ∩ B| / |A|
 *     containment(B -> A) = |A ∩ B| / |B|
 *
 * Restricting to the shared ids matters. A window that has rolled forward drops
 * old members and adds new ones; counting those against the denominators would
 * make every topic look like it half-dissolved every run, purely from the
 * window moving.
 *
 * Two thresholds classify a pair. Both containments exceeding `tauSurvive`
 * means the cluster *is* the topic and inherits its identifier and label.
 * Either containment exceeding `tauPart` means the two are related but not the
 * same, which is what a split or a merge is made of.
 *
 * Two design choices are worth naming because neither is forced:
 *
 *  - **Survival consumes both endpoints.** A prior topic whose identity has
 *    been carried onto a cluster is not also reported as splitting, and the
 *    fragments it left behind are reported as emerged. A topic that survives
 *    intact is not simultaneously breaking apart; allowing both would let one
 *    prior topic appear in contradictory transitions in the same run.
 *  - **A sub-threshold one-to-one link is a split.** When `A` and `B` are
 *    related but too weakly for `B` to inherit the identity, `B` is a new topic
 *    recording `A` as its parent -- a split that happens to have one piece.
 *    The alternative, silently promoting it to a survival, would let identity
 *    walk from topic to topic over enough runs.
 */

export const DEFAULT_TOPIC_IDENTITY_OPTIONS: ResolvedTopicIdentityOptions = {
  tauSurvive: 0.5,
  tauPart: 0.3,
  // Deliberately far stricter than the containment thresholds. Centroid
  // similarity is the weak path, and unrelated topics in the same workspace
  // routinely sit at 0.5-0.7 cosine because they share a domain vocabulary.
  tauCentroid: 0.85,
};

/** Ordering of the returned transitions, before the id tiebreaks. */
const KIND_RANK: Record<TopicTransitionKind, number> = {
  survived: 0,
  split: 1,
  merged: 2,
  emerged: 3,
  dissolved: 4,
};

/**
 * Code-unit comparison, matching `cluster.ts`. `localeCompare` would make the
 * output depend on the host's locale data.
 */
const compareStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const resolveOptions = (options: TopicIdentityOptions): ResolvedTopicIdentityOptions => {
  const resolved: ResolvedTopicIdentityOptions = { ...DEFAULT_TOPIC_IDENTITY_OPTIONS, ...options };
  for (const name of ["tauSurvive", "tauPart", "tauCentroid"] as const) {
    const value = resolved[name];
    // A threshold of 1 can never be exceeded by a similarity, so it would
    // silently disable the rule it configures rather than tighten it.
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new Error(
        `census: ${name} must be a number in [0, 1), received ${value}`,
      );
    }
  }
  return resolved;
};

/** Sorts by id and rejects duplicates, so downstream work is positional. */
const canonicalMemberships = (
  memberships: readonly TopicMembership[],
  label: string,
): TopicMembership[] => {
  const sorted = [...memberships].sort((left, right) => compareStrings(left.id, right.id));
  for (let index = 1; index < sorted.length; index += 1) {
    // Duplicates are adjacent after sorting. They are rejected rather than
    // merged because two rows claiming one identity make the transition for
    // that identity ambiguous, and picking one silently would lose a topic.
    if (sorted[index].id === sorted[index - 1].id) {
      throw new Error(`census: duplicate ${label} id ${JSON.stringify(sorted[index].id)}`);
    }
  }
  return sorted;
};

/**
 * Member ids restricted to those the other run also saw, as a set per topic
 * plus the population across all of them. Members outside the shared window
 * carry no information about identity in either direction.
 */
const restrictToShared = (
  memberships: readonly TopicMembership[],
  shared: ReadonlySet<string>,
): Set<string>[] =>
  memberships.map((membership) => {
    const restricted = new Set<string>();
    for (const memberId of membership.memberIds) {
      if (shared.has(memberId)) {
        restricted.add(memberId);
      }
    }
    return restricted;
  });

const unionOfMembers = (memberships: readonly TopicMembership[]): Set<string> => {
  const union = new Set<string>();
  for (const membership of memberships) {
    for (const memberId of membership.memberIds) {
      union.add(memberId);
    }
  }
  return union;
};

const intersectionSize = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  // Iterating the smaller set keeps this linear in the smaller membership.
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const value of small) {
    if (large.has(value)) {
      shared += 1;
    }
  }
  return shared;
};

type Scores = {
  /** `containment(prior -> cluster)`, indexed `[priorIndex][clusterIndex]`. */
  readonly fromPrior: readonly (readonly number[])[];
  /** `containment(cluster -> prior)`, indexed the same way. */
  readonly fromCluster: readonly (readonly number[])[];
};

const containmentScores = (
  priorMembers: readonly ReadonlySet<string>[],
  clusterMembers: readonly ReadonlySet<string>[],
): Scores => {
  const fromPrior: number[][] = [];
  const fromCluster: number[][] = [];
  for (let prior = 0; prior < priorMembers.length; prior += 1) {
    const priorRow: number[] = [];
    const clusterRow: number[] = [];
    for (let cluster = 0; cluster < clusterMembers.length; cluster += 1) {
      const overlap = intersectionSize(priorMembers[prior], clusterMembers[cluster]);
      // A topic with nothing in the shared window has an undefined containment
      // rather than a zero one; reporting zero is right either way, because it
      // is evidence of nothing, and it keeps the division total.
      priorRow.push(priorMembers[prior].size === 0 ? 0 : overlap / priorMembers[prior].size);
      clusterRow.push(clusterMembers[cluster].size === 0 ? 0 : overlap / clusterMembers[cluster].size);
    }
    fromPrior.push(priorRow);
    fromCluster.push(clusterRow);
  }
  return { fromPrior, fromCluster };
};

/**
 * Cosine similarity between every prior centroid and every cluster centroid.
 * Only reached when the two runs share no members at all.
 */
const centroidScores = (
  priors: readonly TopicMembership[],
  clusters: readonly TopicMembership[],
): number[][] => {
  const dimensions = priors[0].centroid.length;
  const requireDimension = (membership: TopicMembership): readonly number[] => {
    if (membership.centroid.length !== dimensions) {
      throw new Error(
        "census: every centroid must have the same dimension; "
        + `${JSON.stringify(membership.id)} has ${membership.centroid.length}, `
        + `expected ${dimensions}`,
      );
    }
    return membership.centroid;
  };
  // Normalized defensively: a stored centroid may have been rounded on its way
  // through a database column, and a similarity computed from a vector that is
  // no longer unit length is not a cosine.
  const priorUnits = priors.map((prior) => toUnitVector(requireDimension(prior)));
  const clusterUnits = clusters.map((cluster) => toUnitVector(requireDimension(cluster)));
  return priorUnits.map((priorUnit) =>
    clusterUnits.map((clusterUnit) => unitCosineSimilarity(priorUnit, clusterUnit)));
};

/** Total order over transitions; no two transitions of a run can tie on it. */
const compareTransitions = (left: TopicTransition, right: TopicTransition): number => {
  const byKind = KIND_RANK[left.kind] - KIND_RANK[right.kind];
  if (byKind !== 0) {
    return byKind;
  }
  const byTopic = compareStrings(left.topicId ?? "", right.topicId ?? "");
  if (byTopic !== 0) {
    return byTopic;
  }
  return compareStrings(left.clusterId ?? "", right.clusterId ?? "");
};

/**
 * Matches a new clustering run against the previous one and classifies every
 * relationship between them as survived, split, merged, emerged, or dissolved.
 *
 * Determinism: both sides are sorted by id before anything else runs, every
 * threshold comparison is a strict `>` so a score exactly at a threshold has
 * one answer rather than an order-dependent one, ambiguity is resolved by an
 * exact matching whose tiebreak is the lowest cluster id, and the returned
 * array is sorted on a key that no two transitions of a run can share. Sets are
 * used for membership tests only and never iterated into the output. The same
 * input therefore yields the same transitions in the same order, whatever order
 * the caller supplied its topics in.
 */
export const matchTopicIdentities = (
  priorTopics: readonly TopicMembership[],
  newClusters: readonly TopicMembership[],
  options: TopicIdentityOptions = {},
): TopicTransition[] => {
  const resolved = resolveOptions(options);
  const priors = canonicalMemberships(priorTopics, "prior topic");
  const clusters = canonicalMemberships(newClusters, "cluster");

  const priorPopulation = unionOfMembers(priors);
  const clusterPopulation = unionOfMembers(clusters);

  // With one side empty there is nothing to match against, and no fallback to
  // reach for: every cluster is new and every prior topic is gone. Flagging
  // these as centroid-derived would misreport a first run as a weak guess. An
  // empty *population* counts as an empty side: the centroid fallback answers
  // "these two windows do not overlap", which needs two windows to be true of.
  if (priorPopulation.size === 0 || clusterPopulation.size === 0) {
    return [
      ...clusters.map((cluster) => emerged(cluster.id, false)),
      ...priors.map((prior) => dissolved(prior.id, false)),
    ].sort(compareTransitions);
  }

  const shared = new Set<string>();
  for (const memberId of priorPopulation) {
    if (clusterPopulation.has(memberId)) {
      shared.add(memberId);
    }
  }

  return shared.size === 0
    ? matchByCentroid(priors, clusters, resolved)
    : matchByContainment(priors, clusters, shared, resolved);
};

const survived = (topicId: string, clusterId: string, viaCentroidFallback: boolean)
: TopicTransition => ({
  kind: "survived",
  topicId,
  clusterId,
  parentTopicIds: [topicId],
  viaCentroidFallback,
});

const emerged = (clusterId: string, viaCentroidFallback: boolean): TopicTransition => ({
  kind: "emerged",
  clusterId,
  parentTopicIds: [],
  viaCentroidFallback,
});

const dissolved = (topicId: string, viaCentroidFallback: boolean): TopicTransition => ({
  kind: "dissolved",
  topicId,
  parentTopicIds: [],
  viaCentroidFallback,
});

const descended = (
  clusterId: string,
  parentTopicIds: readonly string[],
): TopicTransition => ({
  // One parent is a split with a single piece; several is a merge. Both mint a
  // new identifier and record their ancestry, so the shape is the same.
  kind: parentTopicIds.length > 1 ? "merged" : "split",
  clusterId,
  parentTopicIds,
  viaCentroidFallback: false,
});

/**
 * Pairs the survivors by maximum-weight matching, then classifies whatever the
 * matching left over from the part-strength links between them.
 */
const matchByContainment = (
  priors: readonly TopicMembership[],
  clusters: readonly TopicMembership[],
  shared: ReadonlySet<string>,
  options: ResolvedTopicIdentityOptions,
): TopicTransition[] => {
  const scores = containmentScores(
    restrictToShared(priors, shared),
    restrictToShared(clusters, shared),
  );

  // Weight is the sum of the two containments, which is the natural strength of
  // a pair: it rewards agreement in both directions, so a pair that is mutually
  // most of each other outranks one where a fragment is merely fully contained.
  //
  // At `tauSurvive >= 0.5` over disjoint clusters this relation is already a
  // matching -- no cluster can hold over half of two disjoint prior topics --
  // and the solver has nothing to decide. It earns its place below that
  // threshold, and on input whose clusters overlap, which the type permits and
  // a caller assembling prior topics by hand can produce.
  const surviveWeights = scores.fromPrior.map((row, prior) =>
    row.map((toCluster, cluster) => {
      const toPrior = scores.fromCluster[prior][cluster];
      const bothExceed = toCluster > options.tauSurvive && toPrior > options.tauSurvive;
      return bothExceed ? toCluster + toPrior : 0;
    }));

  const matchedCluster = maxWeightBipartiteMatching(
    surviveWeights,
    priors.length,
    clusters.length,
  );
  const claimedPrior = new Array<boolean>(priors.length).fill(false);
  const claimedCluster = new Array<boolean>(clusters.length).fill(false);
  const transitions: TopicTransition[] = [];
  for (let prior = 0; prior < priors.length; prior += 1) {
    const cluster = matchedCluster[prior];
    if (cluster < 0) {
      continue;
    }
    claimedPrior[prior] = true;
    claimedCluster[cluster] = true;
    transitions.push(survived(priors[prior].id, clusters[cluster].id, false));
  }

  // Part-strength links, over what survival did not consume. Ascending indices
  // over id-sorted inputs, so every parent list comes out sorted by id.
  const parentsOfCluster: number[][] = clusters.map(() => []);
  const childrenOfPrior: number[][] = priors.map(() => []);
  for (let prior = 0; prior < priors.length; prior += 1) {
    if (claimedPrior[prior]) {
      continue;
    }
    for (let cluster = 0; cluster < clusters.length; cluster += 1) {
      if (claimedCluster[cluster]) {
        continue;
      }
      // One direction suffices: a fragment fully inside a topic and a topic
      // fully inside a bigger cluster are both real relationships, and each
      // shows up in only one of the two containments.
      const strongest = Math.max(
        scores.fromPrior[prior][cluster],
        scores.fromCluster[prior][cluster],
      );
      if (strongest > options.tauPart) {
        parentsOfCluster[cluster].push(prior);
        childrenOfPrior[prior].push(cluster);
      }
    }
  }

  for (let cluster = 0; cluster < clusters.length; cluster += 1) {
    if (claimedCluster[cluster]) {
      continue;
    }
    const parents = parentsOfCluster[cluster];
    transitions.push(parents.length === 0
      ? emerged(clusters[cluster].id, false)
      : descended(clusters[cluster].id, parents.map((prior) => priors[prior].id)));
  }
  for (let prior = 0; prior < priors.length; prior += 1) {
    // A prior topic with descendants is accounted for by them; only one that
    // matched nothing at all is dissolved.
    if (!claimedPrior[prior] && childrenOfPrior[prior].length === 0) {
      transitions.push(dissolved(priors[prior].id, false));
    }
  }

  return transitions.sort(compareTransitions);
};

/**
 * The fallback for runs whose windows do not overlap at all, where containment
 * is undefined because there is nothing to contain.
 *
 * Only survival, emergence, and dissolution are decided here. Centroid
 * similarity says how alike two directions are and nothing about how a
 * population was divided, so it cannot distinguish a merge from two topics that
 * were always similar, and inventing splits and merges from it would put
 * ancestry a caller will persist behind a guess.
 */
const matchByCentroid = (
  priors: readonly TopicMembership[],
  clusters: readonly TopicMembership[],
  options: ResolvedTopicIdentityOptions,
): TopicTransition[] => {
  const similarities = centroidScores(priors, clusters);
  const weights = similarities.map((row) =>
    row.map((similarity) => (similarity > options.tauCentroid ? similarity : 0)));

  const matchedCluster = maxWeightBipartiteMatching(weights, priors.length, clusters.length);
  const claimedCluster = new Array<boolean>(clusters.length).fill(false);
  const transitions: TopicTransition[] = [];
  for (let prior = 0; prior < priors.length; prior += 1) {
    const cluster = matchedCluster[prior];
    if (cluster < 0) {
      transitions.push(dissolved(priors[prior].id, true));
      continue;
    }
    claimedCluster[cluster] = true;
    transitions.push(survived(priors[prior].id, clusters[cluster].id, true));
  }
  for (let cluster = 0; cluster < clusters.length; cluster += 1) {
    if (!claimedCluster[cluster]) {
      transitions.push(emerged(clusters[cluster].id, true));
    }
  }
  return transitions.sort(compareTransitions);
};
