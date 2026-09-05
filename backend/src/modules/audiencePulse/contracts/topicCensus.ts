/**
 * Persistence contract for the topic census: batch clustering of recent question
 * facets into workspace-scoped topics. Topics persist across runs (dissolved topics
 * are retained, not deleted) so a returning topic is recognizable, and every run
 * records which topics it saw, how, and why (`topic_transitions`).
 */

export interface CreateTopicCensusRunInput {
  workspaceId: string;
  windowStart: Date;
  windowEnd: Date;
  questionCount: number;
  unclassifiedCount: number;
  seed: string;
  params: Record<string, unknown>;
}

/**
 * A workspace's currently-tracked topic, as identity matching against the next run
 * needs it. `memberIds` is the message ids the topic claimed in its `lastSeenRunId`
 * run -- the exact membership `@radioso/census`'s `matchTopicIdentities` compares
 * against the new run's clusters (`algorithm.md` "Topic identity across analyses").
 * Structurally satisfies `@radioso/census`'s `TopicMembership` (`id`, `memberIds`,
 * `centroid`), so an `ActiveTopicRecord[]` passes straight in as `priorTopics`.
 */
export interface ActiveTopicRecord {
  id: string;
  workspaceId: string;
  centroid: number[];
  radius: number;
  title: string;
  description: string;
  createdRunId: string;
  lastSeenRunId: string;
  /** Null while active; set when a prior run dissolved the topic. */
  dissolvedAt: Date | null;
  memberIds: string[];
}

/**
 * One topic's contribution to a run's save. `id` is always caller-supplied: a fresh
 * `randomUUID()` for a newly emerged topic, or the existing topic id for one that
 * survived. `title`/`description` are optional — omit them to keep the topic's
 * current name, which is how a topic that hasn't been (re)named this run keeps its
 * prior name. A brand-new topic with no name supplied is stored with an empty title
 * and description pending naming.
 */
export interface TopicSaveInput {
  id: string;
  workspaceId: string;
  centroid: number[];
  radius: number;
  title?: string;
  description?: string;
}

export interface TopicMembershipInput {
  topicId: string;
  messageId: string;
  distance: number;
}

export type TopicTransitionKind = "survived" | "split" | "merged" | "emerged" | "dissolved";

export interface TopicTransition {
  kind: TopicTransitionKind;
  parentTopicIds: string[];
  viaCentroidFallback: boolean;
  /**
   * Mutual containment over the prior and current topic's full memberships:
   * `intersection / max(prior size, current size)`. Null when this is not a
   * one-to-one containment-derived survival.
   */
  membershipOverlap: number | null;
}

export interface TopicTransitionInput {
  topicId: string;
  kind: TopicTransitionKind;
  parentTopicIds: string[];
  /**
   * Whether this transition was decided by centroid similarity because the run and
   * its prior shared no members, rather than by membership containment. Optional,
   * defaulting to `false` (the stronger, containment-derived signal), so a caller
   * that has no notion of the fallback path -- a direct repository test, say --
   * doesn't have to supply it.
   */
  viaCentroidFallback?: boolean;
  /** See {@link TopicTransition.membershipOverlap}. */
  membershipOverlap?: number | null;
}

export interface TopicCensusRunTopicSummary {
  id: string;
  title: string;
  description: string;
  centroid: number[];
  radius: number;
  dissolvedAt: Date | null;
  memberCount: number;
  /** The identity classification recorded for this topic in this run, if one exists. */
  transition: TopicTransition | null;
}

export interface TopicCensusRunDissolvedTopic {
  id: string;
  title: string;
}

export interface TopicCensusRunDetail {
  id: string;
  workspaceId: string;
  windowStart: Date;
  windowEnd: Date;
  questionCount: number;
  unclassifiedCount: number;
  seed: string;
  params: Record<string, unknown>;
  createdAt: Date;
  /** Topics with at least one membership in this run, richest first. */
  topics: TopicCensusRunTopicSummary[];
  /** Topics retired by this run. They have no current-run membership or member count. */
  dissolvedTopics: TopicCensusRunDissolvedTopic[];
}

/**
 * One census run's full write, atomic: the run row, its topics, their memberships,
 * and the identity transitions the run classified against the workspace's prior
 * matchable topics (`algorithm.md` "Topic identity across analyses"). A run whose topics
 * saved but whose transitions or dissolutions did not would corrupt the next run's
 * matching, so all of it lands in one transaction.
 */
export interface SaveTopicCensusRunInput {
  run: CreateTopicCensusRunInput;
  topics: TopicSaveInput[];
  memberships: TopicMembershipInput[];
  /**
   * Optional: a caller with nothing to report (no prior topics existed to match
   * against) omits it and gets an empty list.
   */
  transitions?: TopicTransitionInput[];
  /**
   * Prior topic ids retired this run -- matched to nothing, or fully absorbed into a
   * split or merge. Marked dissolved via {@link TopicRepositoryPort.markDissolved},
   * never deleted, so a topic that returns is recognizable. Optional, defaulting to
   * none retired.
   */
  dissolvedTopicIds?: string[];
}

export interface TopicRepositoryPort {
  createRun(input: CreateTopicCensusRunInput): Promise<string>;
  listActiveTopics(workspaceId: string): Promise<ActiveTopicRecord[]>;
  /**
   * Prior topics used for identity matching, including retained dissolved topics so
   * a topic that returns can reuse its prior identity. Read paths that render the
   * current report should use {@link listActiveTopics}; this is for the next census
   * run's matcher only.
   */
  listMatchableTopics(workspaceId: string): Promise<ActiveTopicRecord[]>;
  /**
   * Insert newly emerged topics and update surviving ones. Callers that need this
   * atomic with {@link saveMemberships} and {@link saveTransitions} construct the
   * repository over a shared `Transaction<DB>` and call all three against it.
   */
  saveTopics(runId: string, topics: TopicSaveInput[]): Promise<void>;
  saveMemberships(runId: string, memberships: TopicMembershipInput[]): Promise<void>;
  saveTransitions(runId: string, transitions: TopicTransitionInput[]): Promise<void>;
  markDissolved(runId: string, topicIds: string[]): Promise<void>;
  loadRun(runId: string): Promise<TopicCensusRunDetail | null>;
  loadLatestRun(workspaceId: string): Promise<TopicCensusRunDetail | null>;
  /**
   * Composes {@link createRun}, {@link saveTopics}, {@link saveMemberships},
   * {@link saveTransitions}, and {@link markDissolved} in one transaction.
   */
  saveRun(input: SaveTopicCensusRunInput): Promise<string>;
}
