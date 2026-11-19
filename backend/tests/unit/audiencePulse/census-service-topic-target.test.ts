import { describe, expect, it, vi } from "vitest";

import type { SaveTopicCensusRunInput } from "../../../src/modules/audiencePulse/contracts/topicCensus.js";
import { deriveTopicTarget } from "../../../src/modules/audiencePulse/domain/censusTopicTarget.js";
import {
  CensusService,
  type CensusServiceDependencies,
} from "../../../src/modules/audiencePulse/services/censusService.js";

const PROMPT_VERSION = "facet-extraction/1";
const EMBEDDING_PROFILE_ID = "embedding-space-current";
const workspaceId = "22222222-2222-2222-2222-222222222222";
const windowStart = new Date("2026-07-01T00:00:00.000Z");
const windowEnd = new Date("2026-07-31T00:00:00.000Z");

const GROUP_COUNT = 12;

/** Facets in `GROUP_COUNT` well-separated directions, so the merged topic count is decided by the target. */
const buildFacets = (count: number) =>
  Array.from({ length: count }, (_unused, index) => {
    const vector = new Array<number>(GROUP_COUNT).fill(0);
    vector[index % GROUP_COUNT] = 1;
    vector[(index + 1) % GROUP_COUNT] = ((index * 7919) % 100) / 10_000;
    return {
      messageId: `message-${String(index).padStart(5, "0")}`,
      facetText: `facet ${index}`,
      embedding: vector,
      promptVersion: PROMPT_VERSION,
      embeddingProfileId: EMBEDDING_PROFILE_ID,
    };
  });

const runCensus = async (facetCount: number) => {
  const facets = buildFacets(facetCount);
  const saveRun = vi.fn(async (_input: SaveTopicCensusRunInput) => "run-1");
  const dependencies: CensusServiceDependencies = {
    historySource: { listEligibleQuestionIds: vi.fn(async () => facets.map((facet) => facet.messageId)) },
    facetSource: { listForWindow: vi.fn(async () => facets) },
    topicRepository: {
      saveRun,
      listActiveTopics: vi.fn(async () => []),
      listMatchableTopics: vi.fn(async () => []),
    },
    embeddingSpaceResolver: { resolveClusteringSpace: vi.fn(async () => ({ id: EMBEDDING_PROFILE_ID })) },
    namingPort: {
      name: vi.fn(async () => ({ title: "Topic", description: "A topic" })),
      nameFallback: vi.fn(async () => ({ title: "General", description: "General questions" })),
    },
    privacyAuditPort: { review: vi.fn(async () => ({ flagged: false })) },
    currentFacetPromptVersion: PROMPT_VERSION,
  };
  const result = await new CensusService(dependencies).run({ workspaceId, windowStart, windowEnd });
  return { result, saved: saveRun.mock.calls[0][0] };
};

describe("CensusService.run topic target", () => {
  it("clusters toward a target derived from the facet-ready question count and persists it with the run", async () => {
    const { result, saved } = await runCensus(1_400);

    expect(deriveTopicTarget(1_400)).toBe(11);
    expect(saved.run.params.topicTarget).toBe(11);
    expect(result.topics).toHaveLength(11);
  });

  it("keeps the floor of 10 topics for a small population", async () => {
    const { result, saved } = await runCensus(240);

    expect(saved.run.params.topicTarget).toBe(10);
    expect(result.topics).toHaveLength(10);
  });
});
