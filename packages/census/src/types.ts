/**
 * A single input to clustering: an identified text with a precomputed
 * embedding vector. Census does not compute vectors itself; callers own
 * embedding. Vectors need not be normalized; census normalizes on entry.
 */
export type CensusItem = {
  id: string;
  text: string;
  vector: readonly number[];
};

/**
 * One of the fine-grained clusters a top-level cluster was built from. Kept so
 * a caller can expose a drill-down without census owning a hierarchy API.
 * Members exclude anything the top-level cluster reported unclassified.
 */
export type CensusSubcluster = {
  id: string;
  memberIds: readonly string[];
  centroid: readonly number[];
};

/**
 * A group of item ids that clustered together, with the unit centroid that
 * describes it and the radius that bounds it. `memberIds` is ordered by id.
 */
export type CensusCluster = {
  id: string;
  memberIds: readonly string[];
  centroid: readonly number[];
  /** 90th percentile of member distance to `centroid`. */
  radius: number;
  baseClusters: readonly CensusSubcluster[];
};

/**
 * Tuning for a clustering run. Only `seed` is required; every other field has
 * a default in `DEFAULT_CENSUS_OPTIONS`.
 *
 * `seed` is derived by the caller from the input set -- workspace, window, and
 * the sorted item ids -- so identical input yields an identical seed, and
 * changed input correctly yields a changed result.
 */
export type CensusOptions = {
  seed: string;
  /** Average members per base cluster; drives `k`. */
  targetMembers?: number;
  /** Clusters smaller than this are dissolved into `unclassifiedIds`. */
  minClusterSize?: number;
  /** Independent k-means attempts; the lowest-inertia one wins. */
  restarts?: number;
  /** Iteration cap per attempt. */
  maxIterations?: number;
  /** A member beyond `radius * marginFactor` is reported unclassified. */
  marginFactor?: number;
  /** Lower bound on base `k`. */
  kMin?: number;
  /** Upper bound on base `k`. */
  kMax?: number;
  /** How many top-level clusters the base clusters are agglomerated into. */
  topicTarget?: number;
};

export type ResolvedCensusOptions = Required<CensusOptions>;

/**
 * Output of a clustering run: the top-level clusters, ordered by descending
 * size, plus the ids that no cluster claims. Every input id appears exactly
 * once across `clusters` and `unclassifiedIds`.
 */
export type CensusResult = {
  clusters: readonly CensusCluster[];
  unclassifiedIds: readonly string[];
};

/**
 * The membership of one topic or one cluster, as identity matching needs it:
 * an identifier, the ids it claims, and the centroid that describes it.
 *
 * `CensusCluster` satisfies this structurally, so a fresh clustering result can
 * be passed straight in. A stored prior topic only has to carry these three
 * fields -- identity matching has no use for a radius or a base-cluster
 * hierarchy, and asking a caller to reconstruct them would be a lie about what
 * the matcher reads.
 */
export type TopicMembership = {
  readonly id: string;
  readonly memberIds: readonly string[];
  readonly centroid: readonly number[];
};

/**
 * The cluster-tracking vocabulary. `survived` is the only kind that carries an
 * identifier forward; every other kind that names a cluster mints a new one.
 */
export type TopicTransitionKind = "survived" | "split" | "merged" | "emerged" | "dissolved";

/**
 * One relationship between the prior analysis and the new one.
 *
 * - `topicId` is the prior topic the transition is about, on the two kinds that
 *   name one: `survived` (the identity carried forward) and `dissolved` (the
 *   identity retired).
 * - `clusterId` is the new cluster, on every kind except `dissolved`.
 * - `parentTopicIds` is the prior topics the cluster descends from, ascending
 *   by id: the inherited topic for `survived`, the one ancestor for `split`,
 *   every ancestor for `merged`, and empty for `emerged` and `dissolved`.
 * - `viaCentroidFallback` marks a transition decided by centroid similarity
 *   instead of membership overlap. That path is weaker -- centroids drift for
 *   reasons unrelated to topic identity -- so callers can discount it.
 */
export type TopicTransition = {
  readonly kind: TopicTransitionKind;
  readonly topicId?: string;
  readonly clusterId?: string;
  readonly parentTopicIds: readonly string[];
  readonly viaCentroidFallback: boolean;
};

/**
 * Tuning for identity matching. Every threshold is a similarity that must be
 * *exceeded*, and every one has a default in `DEFAULT_TOPIC_IDENTITY_OPTIONS`.
 */
export type TopicIdentityOptions = {
  /** Both containments must exceed this for a cluster to inherit an identity. */
  tauSurvive?: number;
  /** One containment must exceed this for a cluster to descend from a topic. */
  tauPart?: number;
  /** Centroid cosine similarity to exceed when the two runs share no members. */
  tauCentroid?: number;
};

export type ResolvedTopicIdentityOptions = Required<TopicIdentityOptions>;
