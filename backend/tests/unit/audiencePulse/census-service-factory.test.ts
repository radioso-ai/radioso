import { describe, expect, it, vi } from "vitest";

import { MessageFacetRepository } from "../../../src/db/repositories/messageFacetRepository.js";
import { TopicRepository } from "../../../src/db/repositories/topicRepository.js";
import { PostgresAudiencePulseHistorySource } from "../../../src/modules/chat/composition.js";
import { CensusService } from "../../../src/modules/audiencePulse/services/censusService.js";
import { ContextualCensusServiceFactory } from "../../../src/modules/audiencePulse/infra/censusServiceFactory.js";
import type { TopicNamingInferenceFactory } from "../../../src/modules/audiencePulse/infra/modelTopicNamingGateway.js";
import type { TopicLabelPrivacyAuditInferenceFactory } from "../../../src/modules/audiencePulse/infra/modelTopicLabelPrivacyAuditGateway.js";
import type { Db } from "../../../src/shared/infra/kysely/types.js";

// Construction-only: no method on `TopicRepository`, `MessageFacetRepository`, or
// `PostgresAudiencePulseHistorySource` runs until a `CensusService.run()` call, so a
// stand-in `Db` proves the real repository classes wire together without a live
// Postgres connection -- the same technique `audience-pulse-module.test.ts` already
// uses for this module's other Postgres-backed adapters.
const fakeDb = {} as unknown as Db;

const buildInferenceFactory = (): TopicNamingInferenceFactory & TopicLabelPrivacyAuditInferenceFactory => ({
  create: vi.fn(async () => ({
    metadata: { capability: "chat" as const, provider: "openai" as const, model: "test-model" },
    complete: vi.fn(),
    stream: vi.fn(),
  })),
});

const embeddingBindingResolver = {
  resolveBinding: vi.fn(async () => ({
    space: { id: "embedding-space-1", dimensions: 3, distanceMetric: "cosine" as const },
    model: "text-embedding-test",
    provider: "openai" as const,
    dimensions: 3,
  })),
};

describe("ContextualCensusServiceFactory (composition)", () => {
  it("constructs a real CensusService, wired with real repositories and gateways, for a workspace", () => {
    const factory = new ContextualCensusServiceFactory({
      historySource: new PostgresAudiencePulseHistorySource(fakeDb),
      facetSource: new MessageFacetRepository(fakeDb),
      topicRepository: new TopicRepository(fakeDb),
      embeddingBindingResolver,
      currentFacetPromptVersion: "facet-extraction/1",
      namingInferenceFactory: buildInferenceFactory(),
      privacyAuditInferenceFactory: buildInferenceFactory(),
    });

    const service = factory.create({ workspaceId: "33333333-3333-3333-3333-333333333333" });

    expect(service).toBeInstanceOf(CensusService);
  });

  it("builds an independent CensusService per workspace", () => {
    const factory = new ContextualCensusServiceFactory({
      historySource: new PostgresAudiencePulseHistorySource(fakeDb),
      facetSource: new MessageFacetRepository(fakeDb),
      topicRepository: new TopicRepository(fakeDb),
      embeddingBindingResolver,
      currentFacetPromptVersion: "facet-extraction/1",
      namingInferenceFactory: buildInferenceFactory(),
      privacyAuditInferenceFactory: buildInferenceFactory(),
    });

    const first = factory.create({ workspaceId: "11111111-1111-1111-1111-111111111111" });
    const second = factory.create({ workspaceId: "22222222-2222-2222-2222-222222222222" });

    expect(first).not.toBe(second);
  });
});
