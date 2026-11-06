import { describe, expect, it } from "vitest";

import { AgentRevisionService } from "../../src/modules/agents/public.js";
import { InMemoryAgentRevisionRepository } from "../support/agentRevisionFakes.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const exactContent = { chips: [], variants: [{ locale: "en", body: "Welcome!", chipLabels: {} }] };

/** A service over a repository whose agent has published its first release, so what changes
 * afterwards is the draft alone. */
const publishedAgent = async () => {
  const repository = new InMemoryAgentRevisionRepository();
  let nextId = 0;
  const service = new AgentRevisionService(repository, () => `candidate-${++nextId}`);
  await service.initializeDraft(workspaceId, agentId, "Be brief.");
  const first = await service.createCandidate(workspaceId, agentId, (await service.state(workspaceId, agentId)).draft.generation);
  await service.publish(workspaceId, agentId, null, {
    revisionId: first.id,
    expectedDraftGeneration: first.sourceDraftGeneration,
    expectedPublishedRevisionId: null,
    idempotencyKey: "first",
  });
  return { repository, service, first };
};

describe("agent revision status for a greeting-only draft", () => {
  it("is clean until the greeting changes", async () => {
    const { service } = await publishedAgent();

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_clean");
  });

  it("is dirty once the draft holds a greeting the published revision lacks, so it can be reviewed and published", async () => {
    const { service } = await publishedAgent();

    await service.mutateDraft(workspaceId, agentId, (snapshot) => ({ ...snapshot, greeting: { exactWordsEnabled: true, exactContent } }));

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_dirty");
  });

  it("tests a candidate carrying the new wording, not the published revision that lacks it", async () => {
    const { service, first } = await publishedAgent();
    await service.mutateDraft(workspaceId, agentId, (snapshot) => ({ ...snapshot, greeting: { exactWordsEnabled: true, exactContent } }));

    const resolved = await service.resolveDefaultTestRevision(workspaceId, agentId);

    expect(resolved.revisionId).not.toBe(first.id);
    expect((await service.detail(workspaceId, agentId, resolved.revisionId)).snapshot.greeting).toEqual({ exactWordsEnabled: true, exactContent });
  });

  it("goes clean again when the greeting is put back to what is published", async () => {
    const { service } = await publishedAgent();
    await service.mutateDraft(workspaceId, agentId, (snapshot) => ({ ...snapshot, greeting: { exactWordsEnabled: true, exactContent } }));

    await service.mutateDraft(workspaceId, agentId, (snapshot) => ({ ...snapshot, greeting: { exactWordsEnabled: false, exactContent: null } }));

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_clean");
  });

  it("is clean again after the greeting is published", async () => {
    const { service } = await publishedAgent();
    await service.mutateDraft(workspaceId, agentId, (snapshot) => ({ ...snapshot, greeting: { exactWordsEnabled: true, exactContent } }));
    const state = await service.state(workspaceId, agentId);
    const candidate = await service.createCandidate(workspaceId, agentId, state.draft.generation);

    await service.publish(workspaceId, agentId, null, {
      revisionId: candidate.id,
      expectedDraftGeneration: state.draft.generation,
      expectedPublishedRevisionId: state.publishedRevision?.id ?? null,
      idempotencyKey: "second",
    });

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_clean");
  });
});
