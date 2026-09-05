import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  ActiveTopicRecord,
  SaveTopicCensusRunInput,
  TopicRepositoryPort,
} from "../../../src/modules/audiencePulse/contracts/topicCensus.js";
import type {
  TopicLabel,
  TopicLabelPrivacyAuditPort,
  TopicNamingExemplars,
  TopicNamingPort,
} from "../../../src/modules/audiencePulse/contracts/topicLabel.js";
import {
  CensusService,
  type CensusFacetSource,
  type CensusServiceDependencies,
} from "../../../src/modules/audiencePulse/services/censusService.js";

const CURRENT_PROMPT_VERSION = "facet-extraction/1";
const CURRENT_EMBEDDING_PROFILE_ID = "embedding-space-current";

const workspaceId = "11111111-1111-1111-1111-111111111111";
const windowStart = new Date("2026-07-01T00:00:00.000Z");
const windowEnd = new Date("2026-07-31T00:00:00.000Z");

interface FacetFixture {
  messageId: string;
  facetText: string;
  embedding: number[] | null;
  promptVersion: string;
  embeddingProfileId: string | null;
}

const groupAIds = Array.from({ length: 4 }, () => randomUUID());
const groupBIds = Array.from({ length: 4 }, () => randomUUID());

// Two well-separated groups so k-means assigns them deterministically regardless of
// which seed a given test uses -- packages/census's own suite already covers
// clustering correctness; these tests only need a predictable partition to check
// orchestration around it.
const groupAVectors: number[][] = [
  [1, 0, 0],
  [0.98, 0.02, 0],
  [0.97, 0, 0.03],
  [0.99, 0.01, 0.01],
];
const groupBVectors: number[][] = [
  [0, 1, 0],
  [0.02, 0.98, 0],
  [0, 0.97, 0.03],
  [0.01, 0.99, 0.01],
];

const buildClusterableFacets = (): FacetFixture[] => [
  ...groupAIds.map((messageId, index) => ({
    messageId,
    facetText: `group a facet ${index}`,
    embedding: groupAVectors[index]!,
    promptVersion: CURRENT_PROMPT_VERSION,
    embeddingProfileId: CURRENT_EMBEDDING_PROFILE_ID,
  })),
  ...groupBIds.map((messageId, index) => ({
    messageId,
    facetText: `group b facet ${index}`,
    embedding: groupBVectors[index]!,
    promptVersion: CURRENT_PROMPT_VERSION,
    embeddingProfileId: CURRENT_EMBEDDING_PROFILE_ID,
  })),
];

const buildNamingPort = (): TopicNamingPort & {
  name: ReturnType<typeof vi.fn>;
  nameFallback: ReturnType<typeof vi.fn>;
} => ({
  name: vi.fn(async (exemplars: TopicNamingExemplars): Promise<TopicLabel> => ({
    title: `Topic for ${exemplars.prototypical[0] ?? "unknown"}`,
    description: "A generated topic description",
  })),
  nameFallback: vi.fn(async (): Promise<TopicLabel> => ({
    title: "General inquiries",
    description: "A neutral fallback label",
  })),
});

const buildPrivacyAuditPort = (): TopicLabelPrivacyAuditPort & { review: ReturnType<typeof vi.fn> } => ({
  review: vi.fn(async () => ({ flagged: false })),
});

const buildTopicRepository = (
  priorTopics: ActiveTopicRecord[] = [],
): Pick<TopicRepositoryPort, "saveRun" | "listActiveTopics" | "listMatchableTopics"> & {
  saveRun: ReturnType<typeof vi.fn>;
  listActiveTopics: ReturnType<typeof vi.fn>;
  listMatchableTopics: ReturnType<typeof vi.fn>;
} => ({
  saveRun: vi.fn(async (_input: SaveTopicCensusRunInput) => randomUUID()),
  listActiveTopics: vi.fn(async () => priorTopics),
  listMatchableTopics: vi.fn(async () => priorTopics),
});

const buildDependencies = (input: {
  eligibleIds: string[];
  facets: FacetFixture[];
  topicRepository?: ReturnType<typeof buildTopicRepository>;
  namingPort?: ReturnType<typeof buildNamingPort>;
  privacyAuditPort?: ReturnType<typeof buildPrivacyAuditPort>;
}): CensusServiceDependencies & {
  topicRepository: ReturnType<typeof buildTopicRepository>;
  namingPort: ReturnType<typeof buildNamingPort>;
} => {
  const facetSource: CensusFacetSource = {
    listForWindow: vi.fn(async () => input.facets),
  };
  return {
    historySource: { listEligibleQuestionIds: vi.fn(async () => input.eligibleIds) },
    facetSource,
    topicRepository: input.topicRepository ?? buildTopicRepository(),
    embeddingSpaceResolver: {
      resolveClusteringSpace: vi.fn(async () => ({ id: CURRENT_EMBEDDING_PROFILE_ID })),
    },
    namingPort: input.namingPort ?? buildNamingPort(),
    privacyAuditPort: input.privacyAuditPort ?? buildPrivacyAuditPort(),
    currentFacetPromptVersion: CURRENT_PROMPT_VERSION,
  };
};

describe("CensusService.run (T020)", () => {
  it("reports every eligible question as a topic member or unclassified, summing to the population", async () => {
    const clusterableFacets = buildClusterableFacets();
    const missingFacetId = randomUUID();
    const staleFacetId = randomUUID();
    const nullEmbeddingId = randomUUID();
    const eligibleIds = [
      ...clusterableFacets.map((facet) => facet.messageId),
      missingFacetId,
      staleFacetId,
      nullEmbeddingId,
    ];
    const facets: FacetFixture[] = [
      ...clusterableFacets,
      {
        messageId: staleFacetId,
        facetText: "stale",
        embedding: [1, 1, 1],
        promptVersion: "facet-extraction/0",
        embeddingProfileId: CURRENT_EMBEDDING_PROFILE_ID,
      },
      {
        messageId: nullEmbeddingId,
        facetText: "not yet embedded",
        embedding: null,
        promptVersion: CURRENT_PROMPT_VERSION,
        embeddingProfileId: CURRENT_EMBEDDING_PROFILE_ID,
      },
      // missingFacetId has no row at all.
    ];
    const topicRepository = buildTopicRepository();
    const service = new CensusService(buildDependencies({ eligibleIds, facets, topicRepository }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(11);
    const totalTopicMembers = result.topics.reduce((sum, topic) => sum + topic.memberCount, 0);
    expect(totalTopicMembers + result.unclassifiedCount).toBe(result.populationSize);
    expect(result.unclassifiedCount).toBeGreaterThanOrEqual(3);

    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(saved.run.questionCount).toBe(11);
    expect(saved.run.unclassifiedCount).toBe(result.unclassifiedCount);
    const savedMessageIds = saved.memberships.map((membership) => membership.messageId);
    expect(savedMessageIds).not.toContain(missingFacetId);
    expect(savedMessageIds).not.toContain(staleFacetId);
    expect(savedMessageIds).not.toContain(nullEmbeddingId);
  });

  it("treats a missing facet as unclassified while keeping it in the population", async () => {
    const clusterableFacets = buildClusterableFacets();
    const missingFacetId = randomUUID();
    const eligibleIds = [...clusterableFacets.map((facet) => facet.messageId), missingFacetId];
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(9);
    expect(result.unclassifiedCount).toBeGreaterThanOrEqual(1);
  });

  it("treats a stale prompt version as missing", async () => {
    const clusterableFacets = buildClusterableFacets();
    const staleId = randomUUID();
    const eligibleIds = [...clusterableFacets.map((facet) => facet.messageId), staleId];
    const facets: FacetFixture[] = [
      ...clusterableFacets,
      {
        messageId: staleId,
        facetText: "outdated facet",
        embedding: [1, 1, 1],
        promptVersion: "facet-extraction/0",
        embeddingProfileId: CURRENT_EMBEDDING_PROFILE_ID,
      },
    ];
    const topicRepository = buildTopicRepository();
    const service = new CensusService(buildDependencies({ eligibleIds, facets, topicRepository }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(9);
    expect(result.unclassifiedCount).toBeGreaterThanOrEqual(1);
    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(saved.memberships.map((membership) => membership.messageId)).not.toContain(staleId);
  });

  it("treats a null embedding as missing", async () => {
    const clusterableFacets = buildClusterableFacets();
    const nullEmbeddingId = randomUUID();
    const eligibleIds = [...clusterableFacets.map((facet) => facet.messageId), nullEmbeddingId];
    const facets: FacetFixture[] = [
      ...clusterableFacets,
      {
        messageId: nullEmbeddingId,
        facetText: "no embedding yet",
        embedding: null,
        promptVersion: CURRENT_PROMPT_VERSION,
        embeddingProfileId: CURRENT_EMBEDDING_PROFILE_ID,
      },
    ];
    const topicRepository = buildTopicRepository();
    const service = new CensusService(buildDependencies({ eligibleIds, facets, topicRepository }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(9);
    expect(result.unclassifiedCount).toBeGreaterThanOrEqual(1);
    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(saved.memberships.map((membership) => membership.messageId)).not.toContain(nullEmbeddingId);
  });

  it("computes topic member counts and shares from membership, not from the naming model", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    const topicRepository = buildTopicRepository();
    // A naming port that returns identical labels for every cluster, carrying no
    // count or membership information at all.
    const namingPort = buildNamingPort();
    namingPort.name.mockImplementation(async () => ({ title: "Same title", description: "Same description" }));
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository, namingPort }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    for (const topic of result.topics) {
      const actualMemberCount = saved.memberships.filter((membership) => membership.topicId === topic.topicId).length;
      expect(topic.memberCount).toBe(actualMemberCount);
      expect(topic.share).toBeCloseTo(actualMemberCount / result.populationSize, 10);
    }
    expect(result.topics.reduce((sum, topic) => sum + topic.memberCount, 0)).toBe(clusterableFacets.length);
  });

  it("orders report member ids nearest the centroid first, breaking distance ties by id", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    const topicRepository = buildTopicRepository();
    const result = await new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository }))
      .run({ workspaceId, windowStart, windowEnd });
    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;

    for (const topic of result.topics) {
      const expected = saved.memberships
        .filter((membership) => membership.topicId === topic.topicId)
        .sort((left, right) => left.distance - right.distance || left.messageId.localeCompare(right.messageId))
        .map((membership) => membership.messageId);
      expect(topic.memberIds).toEqual(expected);
    }
  });

  it("derives a seed that does not depend on ids excluded before clustering", async () => {
    const clusterableFacets = buildClusterableFacets();
    const missingFacetId = randomUUID();
    const withExcludedId = buildTopicRepository();
    await new CensusService(buildDependencies({
      eligibleIds: [...clusterableFacets.map((facet) => facet.messageId), missingFacetId],
      facets: clusterableFacets,
      topicRepository: withExcludedId,
    })).run({ workspaceId, windowStart, windowEnd });

    const withoutExcludedId = buildTopicRepository();
    await new CensusService(buildDependencies({
      eligibleIds: clusterableFacets.map((facet) => facet.messageId),
      facets: clusterableFacets,
      topicRepository: withoutExcludedId,
    })).run({ workspaceId, windowStart, windowEnd });

    const savedWith = withExcludedId.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    const savedWithout = withoutExcludedId.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(savedWith.run.seed).toBe(savedWithout.run.seed);
  });

  it("derives a different seed when the clusterable facet id set changes", async () => {
    const clusterableFacets = buildClusterableFacets();
    const extraId = randomUUID();
    const extraFacet: FacetFixture = {
      messageId: extraId,
      facetText: "extra facet",
      embedding: [1, 0, 0],
      promptVersion: CURRENT_PROMPT_VERSION,
      embeddingProfileId: CURRENT_EMBEDDING_PROFILE_ID,
    };

    const base = buildTopicRepository();
    await new CensusService(buildDependencies({
      eligibleIds: clusterableFacets.map((facet) => facet.messageId),
      facets: clusterableFacets,
      topicRepository: base,
    })).run({ workspaceId, windowStart, windowEnd });

    const withExtra = buildTopicRepository();
    await new CensusService(buildDependencies({
      eligibleIds: [...clusterableFacets.map((facet) => facet.messageId), extraId],
      facets: [...clusterableFacets, extraFacet],
      topicRepository: withExtra,
    })).run({ workspaceId, windowStart, windowEnd });

    const savedBase = base.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    const savedWithExtra = withExtra.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(savedBase.run.seed).not.toBe(savedWithExtra.run.seed);
  });

  it("produces the same seed and membership shape across two runs over identical input", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);

    const first = buildTopicRepository();
    const firstResult = await new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository: first }))
      .run({ workspaceId, windowStart, windowEnd });
    const second = buildTopicRepository();
    const secondResult = await new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository: second }))
      .run({ workspaceId, windowStart, windowEnd });

    const savedFirst = first.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    const savedSecond = second.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(savedFirst.run.seed).toBe(savedSecond.run.seed);

    const groupsById = (input: SaveTopicCensusRunInput) => {
      const byTopic = new Map<string, string[]>();
      for (const membership of input.memberships) {
        const bucket = byTopic.get(membership.topicId) ?? [];
        bucket.push(membership.messageId);
        byTopic.set(membership.topicId, bucket);
      }
      return [...byTopic.values()].map((ids) => [...ids].sort()).sort();
    };
    expect(groupsById(savedFirst)).toEqual(groupsById(savedSecond));
    expect(firstResult.unclassifiedCount).toBe(secondResult.unclassifiedCount);
  });

  it("handles an empty window without calling the naming port", async () => {
    const namingPort = buildNamingPort();
    const service = new CensusService(buildDependencies({ eligibleIds: [], facets: [], namingPort }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(0);
    expect(result.unclassifiedCount).toBe(0);
    expect(result.facetReadyQuestionCount).toBe(0);
    expect(result.topics).toEqual([]);
    expect(namingPort.name).not.toHaveBeenCalled();
  });
});

describe("CensusService.run facet readiness (spec 956 follow-up)", () => {
  it("reports zero facet-ready questions when none of the population has a current, embedded facet yet", async () => {
    const eligibleIds = [randomUUID(), randomUUID(), randomUUID()];
    const namingPort = buildNamingPort();
    // No facet rows at all -- a historical population predating the extraction hook,
    // or a backfill still draining.
    const service = new CensusService(buildDependencies({ eligibleIds, facets: [], namingPort }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(3);
    expect(result.facetReadyQuestionCount).toBe(0);
    expect(result.fullyFacetReady).toBe(false);
    expect(result.unclassifiedCount).toBe(3);
    expect(result.topics).toEqual([]);
    expect(namingPort.name).not.toHaveBeenCalled();
  });

  it("reports every population question as facet-ready when all have a current, embedded facet", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(8);
    expect(result.facetReadyQuestionCount).toBe(8);
    expect(result.fullyFacetReady).toBe(true);
  });

  it("treats an embedding from a stale clustering space as not facet-ready", async () => {
    const clusterableFacets = buildClusterableFacets();
    const staleSpaceId = randomUUID();
    const staleFacet = {
      ...clusterableFacets[0]!,
      embeddingProfileId: staleSpaceId,
    };
    const facets = [staleFacet, ...clusterableFacets.slice(1)];
    const eligibleIds = facets.map((facet) => facet.messageId);
    const topicRepository = buildTopicRepository();
    const service = new CensusService(buildDependencies({ eligibleIds, facets, topicRepository }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(8);
    expect(result.facetReadyQuestionCount).toBe(7);
    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(saved.memberships.map((membership) => membership.messageId)).not.toContain(staleFacet.messageId);
  });

  it("keeps facet-ready count distinct from unclassifiedQuestionCount: a fully facet-ready population can still classify into zero topics", async () => {
    // A single facet-ready question is real input to clustering -- every eligible
    // question has a current, embedded facet -- but one item can never satisfy
    // `minClusterSize` (3), so it dissolves into "unclassified" too. If a caller read
    // `unclassifiedCount === populationSize` as "nothing has been computed", it would
    // be wrong here: this population is 100% facet-ready, and clustering ran on it.
    const onlyId = randomUUID();
    const facets: FacetFixture[] = [{
      messageId: onlyId,
      facetText: "a single ready facet",
      embedding: [1, 0, 0],
      promptVersion: CURRENT_PROMPT_VERSION,
      embeddingProfileId: CURRENT_EMBEDDING_PROFILE_ID,
    }];
    const service = new CensusService(buildDependencies({ eligibleIds: [onlyId], facets }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(1);
    expect(result.facetReadyQuestionCount).toBe(1);
    expect(result.fullyFacetReady).toBe(true);
    expect(result.unclassifiedCount).toBe(1);
    expect(result.topics).toEqual([]);
  });

  it("computes a partial facet-ready count when some eligible questions are missing a facet and others are current and embedded", async () => {
    const clusterableFacets = buildClusterableFacets();
    const missingFacetIds = [randomUUID(), randomUUID()];
    const eligibleIds = [...clusterableFacets.map((facet) => facet.messageId), ...missingFacetIds];
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(10);
    expect(result.facetReadyQuestionCount).toBe(8);
    expect(result.unclassifiedCount).toBeGreaterThanOrEqual(2);
  });
});

const buildPriorTopic = (overrides: Partial<ActiveTopicRecord> & { id?: string }): ActiveTopicRecord => ({
  id: overrides.id ?? randomUUID(),
  workspaceId,
  centroid: overrides.centroid ?? [0, 0, 0],
  radius: overrides.radius ?? 0.1,
  title: overrides.title ?? "Prior title",
  description: overrides.description ?? "Prior description",
  createdRunId: overrides.createdRunId ?? randomUUID(),
  lastSeenRunId: overrides.lastSeenRunId ?? randomUUID(),
  dissolvedAt: overrides.dissolvedAt ?? null,
  memberIds: overrides.memberIds ?? [],
});

describe("CensusService.run identity matching (T028+T029)", () => {
  it("names every cluster and records an emerged transition when there are no prior topics", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    const topicRepository = buildTopicRepository([]);
    const namingPort = buildNamingPort();
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository, namingPort }));

    await service.run({ workspaceId, windowStart, windowEnd });

    expect(topicRepository.listMatchableTopics).toHaveBeenCalledWith(workspaceId);
    expect(namingPort.name).toHaveBeenCalledTimes(2);
    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(saved.transitions).toHaveLength(2);
    for (const transition of saved.transitions!) {
      expect(transition.kind).toBe("emerged");
      expect(transition.parentTopicIds).toEqual([]);
      expect(transition.viaCentroidFallback).toBe(false);
    }
    expect(saved.dissolvedTopicIds).toEqual([]);
  });

  it("does not dissolve prior active topics while the current window is only partially facet-ready", async () => {
    const clusterableFacets = buildClusterableFacets();
    const missingFacetId = randomUUID();
    const eligibleIds = [...clusterableFacets.map((facet) => facet.messageId), missingFacetId];
    const priorTopic = buildPriorTopic({
      memberIds: [missingFacetId],
      centroid: [0, 1, 0],
      title: "Waiting on backfill",
      description: "A topic whose current member has not been processed yet.",
    });
    const topicRepository = buildTopicRepository([priorTopic]);
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository }));

    await service.run({ workspaceId, windowStart, windowEnd });

    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(saved.topics).toEqual([]);
    expect(saved.memberships).toEqual([]);
    expect(saved.dissolvedTopicIds).toEqual([]);
    expect(saved.transitions).toEqual([]);
    expect(saved.transitions?.some((transition) =>
      transition.kind === "dissolved" && transition.topicId === priorTopic.id)).toBe(false);
  });

  it("keeps a survived topic's id and label and issues no naming call for it", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    const priorTopic = buildPriorTopic({
      memberIds: [...groupAIds, randomUUID()],
      centroid: [1, 0, 0],
      title: "Existing title",
      description: "Existing description",
    });
    const topicRepository = buildTopicRepository([priorTopic]);
    const namingPort = buildNamingPort();
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository, namingPort }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    // Only group B's cluster is unmatched and needs a name; group A survived as
    // `priorTopic` and must not trigger a second naming call.
    expect(namingPort.name).toHaveBeenCalledTimes(1);

    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    const survivedTopic = saved.topics.find((topic) => topic.id === priorTopic.id);
    expect(survivedTopic).toBeDefined();
    expect(survivedTopic!.title).toBeUndefined();
    expect(survivedTopic!.description).toBeUndefined();
    const survivedMembers = saved.memberships
      .filter((membership) => membership.topicId === priorTopic.id)
      .map((membership) => membership.messageId)
      .sort();
    expect(survivedMembers).toEqual([...groupAIds].sort());

    const survivedTransition = saved.transitions!.find((transition) => transition.topicId === priorTopic.id);
    expect(survivedTransition).toEqual({
      topicId: priorTopic.id,
      kind: "survived",
      parentTopicIds: [priorTopic.id],
      viaCentroidFallback: false,
      membershipOverlap: 0.8,
    });
    expect(saved.dissolvedTopicIds).toEqual([]);

    const reportedTopic = result.topics.find((topic) => topic.topicId === priorTopic.id);
    expect(reportedTopic?.title).toBe("Existing title");
    expect(reportedTopic?.description).toBe("Existing description");
    expect(reportedTopic?.transition?.membershipOverlap).toBe(0.8);
    expect(result.namingCallsIssued).toBe(1);
  });

  it("marks a topic with no counterpart in the new run as dissolved rather than deleting it", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    const survivor = buildPriorTopic({ memberIds: [...groupAIds], centroid: [1, 0, 0] });
    const doomed = buildPriorTopic({
      memberIds: [randomUUID(), randomUUID()],
      centroid: [0, 0, 1],
      title: "One-off topic",
    });
    const topicRepository = buildTopicRepository([survivor, doomed]);
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(saved.dissolvedTopicIds).toEqual([doomed.id]);
    expect(result.dissolvedTopicIds).toEqual([doomed.id]);
    expect(result.dissolvedTopics).toEqual([{ id: doomed.id, title: doomed.title }]);
    expect(saved.topics.some((topic) => topic.id === doomed.id)).toBe(false);
    expect(saved.transitions).toContainEqual({
      topicId: doomed.id,
      kind: "dissolved",
      parentTopicIds: [],
      viaCentroidFallback: false,
    });
  });

  it("does not emit another dissolved transition for a topic that was already dissolved", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    const survivor = buildPriorTopic({ memberIds: [...groupAIds], centroid: [1, 0, 0] });
    const alreadyDissolved = buildPriorTopic({
      memberIds: [],
      centroid: [0, 0, 1],
      dissolvedAt: new Date("2026-07-15T00:00:00.000Z"),
      title: "Previously dissolved topic",
    });
    const topicRepository = buildTopicRepository([survivor, alreadyDissolved]);
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository }));

    const result = await service.run({ workspaceId, windowStart, windowEnd });

    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    expect(saved.dissolvedTopicIds).not.toContain(alreadyDissolved.id);
    expect(result.dissolvedTopicIds).not.toContain(alreadyDissolved.id);
    expect(result.dissolvedTopics).not.toContainEqual(expect.objectContaining({ id: alreadyDissolved.id }));
    expect(saved.transitions).not.toContainEqual(expect.objectContaining({
      topicId: alreadyDissolved.id,
      kind: "dissolved",
    }));
  });

  it("records a split with the prior topic as parent and names both descendants", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    const priorTopic = buildPriorTopic({
      memberIds: [...groupAIds, ...groupBIds],
      centroid: [0.5, 0.5, 0],
      title: "Old combined topic",
    });
    const topicRepository = buildTopicRepository([priorTopic]);
    const namingPort = buildNamingPort();
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository, namingPort }));

    await service.run({ workspaceId, windowStart, windowEnd });

    expect(namingPort.name).toHaveBeenCalledTimes(2);
    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    const splitTransitions = saved.transitions!.filter((transition) => transition.kind === "split");
    expect(splitTransitions).toHaveLength(2);
    for (const transition of splitTransitions) {
      expect(transition.parentTopicIds).toEqual([priorTopic.id]);
      expect(transition.topicId).not.toBe(priorTopic.id);
    }
    const descendantIds = new Set(splitTransitions.map((transition) => transition.topicId));
    expect(descendantIds.size).toBe(2);
    expect(saved.dissolvedTopicIds).toEqual([priorTopic.id]);
    expect(saved.transitions).toContainEqual({
      topicId: priorTopic.id,
      kind: "dissolved",
      parentTopicIds: [],
      viaCentroidFallback: false,
    });
  });

  it("records a merge with both prior topics as parents", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    const parentOne = buildPriorTopic({ memberIds: groupAIds.slice(0, 2), centroid: [1, 0, 0], title: "Parent one" });
    const parentTwo = buildPriorTopic({ memberIds: groupAIds.slice(2, 4), centroid: [1, 0, 0], title: "Parent two" });
    const topicRepository = buildTopicRepository([parentOne, parentTwo]);
    const namingPort = buildNamingPort();
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository, namingPort }));

    await service.run({ workspaceId, windowStart, windowEnd });

    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    const mergedTransitions = saved.transitions!.filter((transition) => transition.kind === "merged");
    expect(mergedTransitions).toHaveLength(1);
    expect(new Set(mergedTransitions[0]!.parentTopicIds)).toEqual(new Set([parentOne.id, parentTwo.id]));
    expect(new Set(saved.dissolvedTopicIds)).toEqual(new Set([parentOne.id, parentTwo.id]));
    expect(saved.transitions!.filter((transition) => transition.kind === "dissolved").map((transition) => transition.topicId).sort())
      .toEqual([parentOne.id, parentTwo.id].sort());
    // Group B never overlapped either parent, so its cluster is unrelated to the merge.
    expect(saved.transitions!.some((transition) => transition.kind === "emerged")).toBe(true);
  });

  it("persists viaCentroidFallback when identity matching falls back to centroid similarity", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    // No overlap at all with this run's population, so identity matching cannot use
    // containment and falls back to centroid similarity; this centroid is close to
    // group A's.
    const priorTopic = buildPriorTopic({ memberIds: [randomUUID(), randomUUID()], centroid: [1, 0, 0] });
    const topicRepository = buildTopicRepository([priorTopic]);
    const namingPort = buildNamingPort();
    const service = new CensusService(buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository, namingPort }));

    await service.run({ workspaceId, windowStart, windowEnd });

    const saved = topicRepository.saveRun.mock.calls[0]![0] as SaveTopicCensusRunInput;
    const survivedTransition = saved.transitions!.find((transition) => transition.topicId === priorTopic.id);
    expect(survivedTransition?.kind).toBe("survived");
    expect(survivedTransition?.viaCentroidFallback).toBe(true);
    expect(survivedTransition?.membershipOverlap).toBeNull();
    // The surviving cluster still gets no naming call; only group B's does.
    expect(namingPort.name).toHaveBeenCalledTimes(1);
  });
});

describe("CensusService.run observability (T033)", () => {
  it("emits duration, naming issued/reused, and transition-kind counts on the run-completed event", async () => {
    const clusterableFacets = buildClusterableFacets();
    const eligibleIds = clusterableFacets.map((facet) => facet.messageId);
    // Group A survived from a prior topic (reused, no naming call); group B has no
    // prior counterpart and emerges fresh (issued, one naming call).
    const priorTopic = buildPriorTopic({
      memberIds: [...groupAIds],
      centroid: [1, 0, 0],
      title: "Existing title",
      description: "Existing description",
    });
    const topicRepository = buildTopicRepository([priorTopic]);
    const namingPort = buildNamingPort();
    const emit = vi.fn().mockResolvedValue(undefined);
    const service = new CensusService({
      ...buildDependencies({ eligibleIds, facets: clusterableFacets, topicRepository, namingPort }),
      telemetryService: { emit },
    });

    await service.run({ workspaceId, windowStart, windowEnd });

    const completedCalls = emit.mock.calls.filter(([event]) => event.eventType === "audience_pulse.census_run_completed");
    expect(completedCalls).toHaveLength(1);
    const event = completedCalls[0]![0];

    expect(event.metrics).toEqual(expect.objectContaining({
      populationSize: 8,
      unclassifiedCount: 0,
      facetReadyQuestionCount: 8,
      topicCount: 2,
      clusteringDurationMs: expect.any(Number),
      namingDurationMs: expect.any(Number),
      namingCallsIssued: 1,
      namingCallsReused: 1,
      transitionsSurvivedCount: 1,
      transitionsSplitCount: 0,
      transitionsMergedCount: 0,
      transitionsEmergedCount: 1,
      transitionsDissolvedCount: 0,
    }));
    expect(event.metrics.clusteringDurationMs).toBeGreaterThanOrEqual(0);
    expect(event.metrics.namingDurationMs).toBeGreaterThanOrEqual(0);

    // Identifiers, counts, and durations only -- never facet text, question text, or
    // topic labels (spec 956 Observability Review).
    const payload = JSON.stringify(event);
    expect(payload).not.toContain("group a facet");
    expect(payload).not.toContain("group b facet");
    expect(payload).not.toContain("Existing title");
    expect(payload).not.toContain("Existing description");
    expect(payload).not.toContain("Topic for");
    expect(payload).not.toContain("generated topic description");
  });

  it("reports every transition kind at zero when a run produces no transitions", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const service = new CensusService({
      ...buildDependencies({ eligibleIds: [], facets: [] }),
      telemetryService: { emit },
    });

    await service.run({ workspaceId, windowStart, windowEnd });

    const completedCalls = emit.mock.calls.filter(([event]) => event.eventType === "audience_pulse.census_run_completed");
    expect(completedCalls).toHaveLength(1);
    expect(completedCalls[0]![0].metrics).toEqual(expect.objectContaining({
      facetReadyQuestionCount: 0,
      namingCallsIssued: 0,
      namingCallsReused: 0,
      transitionsSurvivedCount: 0,
      transitionsSplitCount: 0,
      transitionsMergedCount: 0,
      transitionsEmergedCount: 0,
      transitionsDissolvedCount: 0,
    }));
  });
});
