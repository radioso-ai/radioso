import { randomUUID } from "node:crypto";

import {
  computeCensus,
  DEFAULT_CENSUS_OPTIONS,
  matchTopicIdentities,
  toUnitVector,
  unitCosineDistance,
} from "@radioso/census";
import type {
  CensusCluster,
  CensusItem,
  CensusOptions,
  TopicMembership,
  TopicTransition,
  TopicTransitionKind as CensusTopicTransitionKind,
} from "@radioso/census";

import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import { deriveCensusSeed } from "../domain/censusSeed.js";
import type { AudiencePulseHistorySource } from "../contracts/history.js";
import type {
  ActiveTopicRecord,
  CreateTopicCensusRunInput,
  SaveTopicCensusRunInput,
  TopicMembershipInput,
  TopicRepositoryPort,
  TopicSaveInput,
  TopicTransitionInput,
  TopicTransitionKind,
} from "../contracts/topicCensus.js";
import type {
  TopicLabel,
  TopicLabelPrivacyAuditPort,
  TopicNamingExemplars,
  TopicNamingPort,
} from "../contracts/topicLabel.js";
import { resolveAuditedTopicLabel } from "./topicLabelPrivacyAudit.js";
import {
  TOPIC_NAMING_MAX_PERIPHERAL_EXEMPLARS,
  TOPIC_NAMING_MAX_PROTOTYPICAL_EXEMPLARS,
} from "./topicNamingPrompt.js";

const TOPIC_TRANSITION_KIND_PARITY = {
  survived: "survived",
  split: "split",
  merged: "merged",
  emerged: "emerged",
  dissolved: "dissolved",
} satisfies Record<CensusTopicTransitionKind, TopicTransitionKind>
  & Record<TopicTransitionKind, CensusTopicTransitionKind>;

const toPersistedTransitionKind = (kind: CensusTopicTransitionKind): TopicTransitionKind =>
  TOPIC_TRANSITION_KIND_PARITY[kind];

/**
 * What `censusService` needs to read a stored facet: message id, facet text, its
 * embedding (`null` when not yet embedded), and the prompt version it was extracted
 * at. Declared locally and narrower than `MessageFacetRepositoryPort`
 * (`modules/facets/contracts.ts`) rather than importing it -- `audiencePulse` and
 * `facets` are peer modules, and cross-module imports must go through a
 * `public.ts`/`contracts/` surface (`scripts/validate-architecture-boundaries.mjs`),
 * which `facets` does not expose this behind today. Composition can satisfy this with
 * the same `MessageFacetRepository` instance `facets` already uses: its wider return
 * type structurally satisfies this narrower shape.
 */
export interface CensusFacetSource {
  listForWindow(input: { workspaceId: string; messageIds: string[] }): Promise<CensusFacetRecord[]>;
}

export interface CensusFacetRecord {
  messageId: string;
  facetText: string;
  embedding: number[] | null;
  promptVersion: string;
  embeddingProfileId: string | null;
}

export interface CensusEmbeddingSpaceResolver {
  resolveClusteringSpace(input: { workspaceId: string }): Promise<{ id: string }>;
}

export interface CensusRunTopicResult {
  topicId: string;
  title: string;
  description: string;
  memberIds: string[];
  memberCount: number;
  share: number;
}

export interface CensusRunResult {
  runId: string;
  populationSize: number;
  unclassifiedCount: number;
  /**
   * How many of `populationSize` questions had a current, embedded facet clustering
   * could actually use -- `clusterable.length` from `partitionEligibleQuestions`, before
   * k-means ever runs. Distinct from `unclassifiedCount`: a fully facet-ready population
   * can still classify into zero topics (every cluster below `minClusterSize`), so this
   * is the only field that tells "not yet computed" apart from "computed, no pattern
   * found" (spec 956 follow-up).
   */
  facetReadyQuestionCount: number;
  topics: CensusRunTopicResult[];
}

export interface CensusServiceDependencies {
  historySource: Pick<AudiencePulseHistorySource, "listEligibleQuestionIds">;
  facetSource: CensusFacetSource;
  topicRepository: Pick<TopicRepositoryPort, "saveRun" | "listActiveTopics">
    & Partial<Pick<TopicRepositoryPort, "listMatchableTopics">>;
  embeddingSpaceResolver: CensusEmbeddingSpaceResolver;
  namingPort: TopicNamingPort;
  privacyAuditPort: TopicLabelPrivacyAuditPort;
  /** The facet extraction prompt version a stored facet must carry to count as current. */
  currentFacetPromptVersion: string;
  telemetryService?: Pick<TelemetryService, "emit">;
}

interface ClusterableFacet {
  messageId: string;
  facetText: string;
  vector: number[];
}

/**
 * Splits eligible question ids into what goes into clustering and what is
 * unclassified before clustering even runs (spec 956 FR-013): a question whose facet
 * is missing, extracted under a stale prompt version, or not yet embedded still
 * counts toward the population, just not toward any topic.
 */
const partitionEligibleQuestions = (input: {
  eligibleIds: readonly string[];
  facetsByMessageId: ReadonlyMap<string, CensusFacetRecord>;
  currentFacetPromptVersion: string;
  currentEmbeddingProfileId: string;
}): { clusterable: ClusterableFacet[]; excludedCount: number } => {
  const clusterable: ClusterableFacet[] = [];
  let excludedCount = 0;
  for (const messageId of input.eligibleIds) {
    const facet = input.facetsByMessageId.get(messageId);
    const isCurrent = facet !== undefined
      && facet.promptVersion === input.currentFacetPromptVersion
      && facet.embedding !== null
      && facet.embeddingProfileId === input.currentEmbeddingProfileId;
    if (!isCurrent) {
      excludedCount += 1;
      continue;
    }
    clusterable.push({ messageId, facetText: facet.facetText, vector: facet.embedding! });
  }
  return { clusterable, excludedCount };
};

/**
 * Exemplars for naming one cluster (algorithm.md "Naming"): the members nearest the
 * centroid show what the topic is about, the members farthest from it -- while still
 * inside the cluster `@radioso/census` already pruned outliers from -- show how wide
 * the topic is. The same distances double as `topic_memberships.distance`.
 */
const selectExemplars = (input: {
  cluster: CensusCluster;
  facetTextById: ReadonlyMap<string, string>;
  unitVectorById: ReadonlyMap<string, number[]>;
}): { exemplars: TopicNamingExemplars; distanceByMessageId: Map<string, number> } => {
  const ranked = input.cluster.memberIds
    .map((messageId) => ({
      messageId,
      distance: unitCosineDistance(input.unitVectorById.get(messageId)!, input.cluster.centroid),
    }))
    .sort((left, right) => left.distance - right.distance);

  const distanceByMessageId = new Map(ranked.map((member) => [member.messageId, member.distance]));
  const prototypical = ranked
    .slice(0, TOPIC_NAMING_MAX_PROTOTYPICAL_EXEMPLARS)
    .map((member) => input.facetTextById.get(member.messageId)!);
  const peripheral = ranked
    .slice(-TOPIC_NAMING_MAX_PERIPHERAL_EXEMPLARS)
    .map((member) => input.facetTextById.get(member.messageId)!);

  return { exemplars: { prototypical, peripheral }, distanceByMessageId };
};

/**
 * Assigns a persistent identity to a cluster produced by this run, from the
 * transition `@radioso/census`'s `matchTopicIdentities` classified it under
 * (`algorithm.md` "Topic identity across analyses"). A `survived` cluster inherits
 * its prior topic's id -- and, by returning `undefined` label fields, its label --
 * with no naming call. Every other kind (`split`, `merged`, `emerged`) mints a fresh
 * id and is named from this cluster's own exemplars, recording `parentTopicIds` from
 * the transition.
 */
const resolveClusterIdentity = (
  transition: TopicTransition,
  priorTopicsById: ReadonlyMap<string, ActiveTopicRecord>,
): { topicId: string; parentTopicIds: string[]; survivedLabel?: { title: string; description: string } } => {
  if (transition.kind === "survived") {
    const topicId = transition.topicId!;
    const priorTopic = priorTopicsById.get(topicId);
    return {
      topicId,
      parentTopicIds: [...transition.parentTopicIds],
      survivedLabel: priorTopic ? { title: priorTopic.title, description: priorTopic.description } : undefined,
    };
  }
  return { topicId: randomUUID(), parentTopicIds: [...transition.parentTopicIds] };
};

/**
 * Orchestrates one topic census run (spec 956, `algorithm.md`): resolves the exact
 * eligible-question population for a window, loads the facets already extracted for
 * it and the workspace's prior active topics, clusters the current facets via
 * `@radioso/census`, matches the resulting clusters against those prior topics to
 * carry identity across runs, names only the clusters that did not survive, and
 * persists the run atomically. Topic sizes and shares are always computed here from
 * cluster membership -- the naming call never partitions the population and has no
 * field through which it could.
 */
export class CensusService {
  constructor(private readonly dependencies: CensusServiceDependencies) {}

  async run(input: {
    workspaceId: string;
    windowStart: Date;
    windowEnd: Date;
    signal?: AbortSignal;
  }): Promise<CensusRunResult> {
    const { workspaceId, windowStart, windowEnd, signal } = input;

    // Loaded alongside the eligible-question fetch so it is ready by the time
    // clustering completes and identity matching needs it.
    const [eligibleIds, priorTopics, currentEmbeddingSpace] = await Promise.all([
      this.dependencies.historySource.listEligibleQuestionIds({
        workspaceId,
        analysisStart: windowStart,
        analysisEnd: windowEnd,
      }),
      this.dependencies.topicRepository.listMatchableTopics?.(workspaceId)
        ?? this.dependencies.topicRepository.listActiveTopics(workspaceId),
      this.dependencies.embeddingSpaceResolver.resolveClusteringSpace({ workspaceId }),
    ]);
    const priorTopicsById = new Map(priorTopics.map((topic) => [topic.id, topic]));
    // SQL-computed and authoritative: the exact denominator the dashboard shows.
    const populationSize = eligibleIds.length;

    const facetRecords = eligibleIds.length === 0
      ? []
      : await this.dependencies.facetSource.listForWindow({ workspaceId, messageIds: [...eligibleIds] });
    const facetsByMessageId = new Map(facetRecords.map((record) => [record.messageId, record]));

    const { clusterable, excludedCount } = partitionEligibleQuestions({
      eligibleIds,
      facetsByMessageId,
      currentFacetPromptVersion: this.dependencies.currentFacetPromptVersion,
      currentEmbeddingProfileId: currentEmbeddingSpace.id,
    });

    const censusItems: CensusItem[] = clusterable.map((facet) => ({
      id: facet.messageId,
      text: facet.facetText,
      vector: facet.vector,
    }));
    const facetTextById = new Map(clusterable.map((facet) => [facet.messageId, facet.facetText]));
    const unitVectorById = new Map(clusterable.map((facet) => [facet.messageId, toUnitVector(facet.vector)]));

    const seed = deriveCensusSeed({
      workspaceId,
      windowStart,
      windowEnd,
      facetIds: censusItems.map((item) => item.id),
    });
    const censusOptions: CensusOptions = { ...DEFAULT_CENSUS_OPTIONS, seed };
    // `computeCensus` returns only `clusters`/`unclassifiedIds` (`@radioso/census`
    // `CensusResult`): it does not surface k-means iteration count or final inertia,
    // so this service cannot report them without inventing values. If that changes,
    // report them here alongside `clusteringDurationMs`.
    const clusteringStartedAtMs = Date.now();
    const census = computeCensus(censusItems, censusOptions);

    const unclassifiedCount = excludedCount + census.unclassifiedIds.length;

    // Anonymous, run-scoped clusters become topics here: matched against the
    // workspace's prior active topics (survived/split/merged/emerged/dissolved,
    // `algorithm.md` "Topic identity across analyses"). `census.clusters` already
    // carries the `id`/`memberIds`/`centroid` shape identity matching needs.
    const fullyFacetReady = populationSize > 0 && clusterable.length === populationSize;
    const priorTopicMemberships = priorTopics.map((topic) => topic satisfies TopicMembership);
    const clusterTransitions = matchTopicIdentities(priorTopicMemberships, census.clusters);
    const transitionByClusterId = new Map(
      clusterTransitions
        .filter((transition): transition is TopicTransition & { clusterId: string } => transition.clusterId !== undefined)
        .map((transition) => [transition.clusterId, transition]),
    );
    const clusteringDurationMs = Date.now() - clusteringStartedAtMs;

    const topics: TopicSaveInput[] = [];
    const memberships: TopicMembershipInput[] = [];
    const reportTopics: CensusRunTopicResult[] = [];
    const transitions: TopicTransitionInput[] = [];

    // Naming issued vs. reused is the cost story (spec 956 Observability Review): a
    // survived cluster reuses its stored label and never reaches `nameCluster`.
    let namingCallsIssued = 0;
    let namingCallsReused = 0;
    const namingStartedAtMs = Date.now();

    await Promise.all(census.clusters.map(async (cluster) => {
      const transition = transitionByClusterId.get(cluster.id);
      if (!transition) {
        throw new Error(`census: identity matching produced no transition for cluster ${cluster.id}`);
      }
      const { topicId, parentTopicIds, survivedLabel } = resolveClusterIdentity(transition, priorTopicsById);
      const { exemplars, distanceByMessageId } = selectExemplars({ cluster, facetTextById, unitVectorById });

      if (survivedLabel) {
        namingCallsReused += 1;
      } else {
        namingCallsIssued += 1;
      }
      // A survived topic keeps the label already on file -- no naming call, so an
      // operator watching a digest never sees a topic reworded on a refresh where
      // nothing about it changed (spec 956 US3).
      const label = survivedLabel ?? await this.nameCluster({ workspaceId, topicId, exemplars, signal });

      topics.push({
        id: topicId,
        workspaceId,
        centroid: [...cluster.centroid],
        radius: cluster.radius,
        // Omitted for a survived topic: no naming call ran, so the repository
        // preserves the title/description already stored for this id.
        ...(survivedLabel ? {} : { title: label.title, description: label.description }),
      });
      for (const messageId of cluster.memberIds) {
        memberships.push({ topicId, messageId, distance: distanceByMessageId.get(messageId)! });
      }
      reportTopics.push({
        topicId,
        title: label.title,
        description: label.description,
        memberIds: [...cluster.memberIds],
        memberCount: cluster.memberIds.length,
        share: populationSize === 0 ? 0 : cluster.memberIds.length / populationSize,
      });
      transitions.push({
        topicId,
        kind: toPersistedTransitionKind(transition.kind),
        parentTopicIds,
        viaCentroidFallback: transition.viaCentroidFallback,
      });
    }));

    const namingDurationMs = Date.now() - namingStartedAtMs;

    // Transitions with no `clusterId` -- a prior topic matching nothing in this run.
    // Recorded and marked dissolved, never deleted, so a topic that returns is
    // recognizable.
    const dissolvedTopicIds = new Set<string>();
    for (const transition of clusterTransitions) {
      if (transition.kind === "split" || transition.kind === "merged") {
        for (const parentTopicId of transition.parentTopicIds) {
          dissolvedTopicIds.add(parentTopicId);
        }
        continue;
      }
      if (transition.kind !== "dissolved") {
        continue;
      }
      if (!fullyFacetReady) {
        continue;
      }
      const topicId = transition.topicId!;
      dissolvedTopicIds.add(topicId);
      transitions.push({
        topicId,
        kind: toPersistedTransitionKind(transition.kind),
        parentTopicIds: [],
        viaCentroidFallback: transition.viaCentroidFallback,
      });
    }

    const run: CreateTopicCensusRunInput = {
      workspaceId,
      windowStart,
      windowEnd,
      questionCount: populationSize,
      unclassifiedCount,
      seed,
      params: { ...censusOptions },
    };
    const saveInput: SaveTopicCensusRunInput = {
      run,
      // A partial run can render a useful "topics cover part of this period" report,
      // but it must not mutate the durable topic registry: split/merge decisions over
      // an incomplete population would leave stale parents and transient children
      // active together for the next matcher.
      topics: fullyFacetReady ? topics : [],
      memberships: fullyFacetReady ? memberships : [],
      transitions: fullyFacetReady ? transitions : [],
      dissolvedTopicIds: fullyFacetReady ? [...dissolvedTopicIds] : [],
    };
    const runId = await this.dependencies.topicRepository.saveRun(saveInput);

    const transitionCountsByKind: Record<TopicTransitionKind, number> = {
      survived: 0,
      split: 0,
      merged: 0,
      emerged: 0,
      dissolved: 0,
    };
    for (const transition of transitions) {
      transitionCountsByKind[transition.kind] += 1;
    }

    await this.dependencies.telemetryService?.emit({
      eventType: "audience_pulse.census_run_completed",
      severity: "info",
      correlation: { workspaceId },
      tags: { runId },
      // Identifiers, counts, and durations only -- never facet text, question text,
      // topic labels, or vectors (spec 956 Observability Review).
      metrics: {
        populationSize,
        unclassifiedCount,
        facetReadyQuestionCount: clusterable.length,
        topicCount: topics.length,
        clusteringDurationMs,
        namingDurationMs,
        namingCallsIssued,
        namingCallsReused,
        transitionsSurvivedCount: transitionCountsByKind.survived,
        transitionsSplitCount: transitionCountsByKind.split,
        transitionsMergedCount: transitionCountsByKind.merged,
        transitionsEmergedCount: transitionCountsByKind.emerged,
        transitionsDissolvedCount: transitionCountsByKind.dissolved,
      },
    }).catch(() => undefined);

    reportTopics.sort((a, b) => b.memberCount - a.memberCount || a.topicId.localeCompare(b.topicId));

    return {
      runId,
      populationSize,
      unclassifiedCount,
      facetReadyQuestionCount: clusterable.length,
      topics: reportTopics,
    };
  }

  /** Names one cluster that did not survive from a prior topic, and runs its label through privacy review. */
  private async nameCluster(input: {
    workspaceId: string;
    topicId: string;
    exemplars: TopicNamingExemplars;
    signal?: AbortSignal;
  }): Promise<TopicLabel> {
    const candidate = await this.dependencies.namingPort.name(input.exemplars, input.signal);
    return resolveAuditedTopicLabel({
      workspaceId: input.workspaceId,
      topicId: input.topicId,
      candidate,
      exemplars: input.exemplars,
      namingPort: this.dependencies.namingPort,
      privacyAuditPort: this.dependencies.privacyAuditPort,
      telemetryService: this.dependencies.telemetryService,
      signal: input.signal,
    });
  }
}
