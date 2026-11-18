import { describe, expect, it } from "vitest";

import { AgentRevisionService, type AgentRevisionSnapshot } from "../../src/modules/agents/public.js";
import { InMemoryAgentRevisionRepository } from "../support/agentRevisionFakes.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const lookupOrdersId = "33333333-3333-4333-8333-333333333333";
const notifyTeamId = "44444444-4444-4444-8444-444444444444";
const answerId = "55555555-5555-4555-8555-555555555555";

type FrozenSkill = NonNullable<AgentRevisionSnapshot["agentSkills"]>[number];

const skill = (overrides: Partial<FrozenSkill> = {}): FrozenSkill => ({
  id: lookupOrdersId,
  agentId,
  workspaceId,
  skillName: "lookup_orders",
  kind: "mcp_tool",
  invocationMode: "agent_selectable",
  enabled: true,
  targetType: "mcp_connection",
  targetId: "66666666-6666-4666-8666-666666666666",
  config: { toolName: "lookup_orders", description: "Looks up an order by number." },
  createdAt: new Date("2026-11-01T09:00:00.000Z"),
  updatedAt: new Date("2026-11-01T09:00:00.000Z"),
  ...overrides,
});

const notifyTeam = (overrides: Partial<FrozenSkill> = {}): FrozenSkill => skill({
  id: notifyTeamId,
  skillName: "notify_team",
  kind: "notify",
  targetType: null,
  targetId: null,
  config: { delivery: { recipientEmails: ["team@acme.example"] } },
  ...overrides,
});

const answer = (config: Record<string, unknown>): FrozenSkill => skill({
  id: answerId,
  skillName: "answer",
  kind: "retrieve",
  invocationMode: "default_answer",
  targetType: "source_scope",
  targetId: null,
  config,
});

const withSkills = (agentSkills: FrozenSkill[] | undefined) => (snapshot: AgentRevisionSnapshot): AgentRevisionSnapshot => {
  const { agentSkills: _previous, ...rest } = snapshot;
  return agentSkills === undefined ? rest : { ...rest, agentSkills };
};

/** A service over a repository whose agent has published a first release holding `publishedSkills`
 * (`"none recorded"` for a release frozen before skills were tracked). */
const publishedAgent = async (publishedSkills: FrozenSkill[] | "none recorded") => {
  const repository = new InMemoryAgentRevisionRepository();
  let nextId = 0;
  const service = new AgentRevisionService(repository, () => `candidate-${++nextId}`);
  await service.initializeDraft(workspaceId, agentId, "Be brief.");
  const draft = await service.mutateDraft(workspaceId, agentId, withSkills(publishedSkills === "none recorded" ? undefined : publishedSkills));
  const first = await service.createCandidate(workspaceId, agentId, draft.generation);
  await service.publish(workspaceId, agentId, null, {
    revisionId: first.id,
    expectedDraftGeneration: first.sourceDraftGeneration,
    expectedPublishedRevisionId: null,
    idempotencyKey: "first",
  });
  return { service, first };
};

const publishDraft = async (service: AgentRevisionService, idempotencyKey: string) => {
  const state = await service.state(workspaceId, agentId);
  const candidate = await service.createCandidate(workspaceId, agentId, state.draft.generation);
  await service.publish(workspaceId, agentId, null, {
    revisionId: candidate.id,
    expectedDraftGeneration: state.draft.generation,
    expectedPublishedRevisionId: state.publishedRevision?.id ?? null,
    idempotencyKey,
  });
};

describe("agent revision status for a skills-only draft", () => {
  it("is dirty once the draft adds a skill the published version lacks, so it can be reviewed and published", async () => {
    const { service } = await publishedAgent([]);

    await service.mutateDraft(workspaceId, agentId, withSkills([skill()]));

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_dirty");
  });

  it("is dirty when only a skill's switch changes", async () => {
    const { service } = await publishedAgent([skill()]);

    await service.mutateDraft(workspaceId, agentId, withSkills([skill({ enabled: false, updatedAt: new Date("2026-11-02T09:00:00.000Z") })]));

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_dirty");
  });

  it("is dirty when a skill is removed", async () => {
    const { service } = await publishedAgent([skill(), notifyTeam()]);

    await service.mutateDraft(workspaceId, agentId, withSkills([notifyTeam()]));

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_dirty");
  });

  it("tests a candidate carrying the new skill, not the published version that lacks it", async () => {
    const { service, first } = await publishedAgent([]);
    await service.mutateDraft(workspaceId, agentId, withSkills([skill()]));

    const resolved = await service.resolveDefaultTestRevision(workspaceId, agentId);

    expect(resolved.revisionId).not.toBe(first.id);
    expect((await service.detail(workspaceId, agentId, resolved.revisionId)).snapshot.agentSkills)
      .toEqual([expect.objectContaining({ id: lookupOrdersId, skillName: "lookup_orders" })]);
  });

  it("stays clean when the draft holds the same skills, rewritten later and in another order", async () => {
    const { service } = await publishedAgent([skill(), notifyTeam()]);

    // A save that restores what is published moves `updatedAt`; a reseed from the live table
    // lists skills by name and a JSONB round trip may reorder config keys. None of it is a change.
    await service.mutateDraft(workspaceId, agentId, withSkills([
      notifyTeam({ updatedAt: new Date("2026-11-05T09:00:00.000Z") }),
      skill({
        updatedAt: new Date("2026-11-05T09:00:00.000Z"),
        config: { description: "Looks up an order by number.", toolName: "lookup_orders" },
      }),
    ]));

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_clean");
  });

  it("goes clean again when a skill is switched back to what is published", async () => {
    const { service } = await publishedAgent([skill()]);
    await service.mutateDraft(workspaceId, agentId, withSkills([skill({ enabled: false })]));

    await service.mutateDraft(workspaceId, agentId, withSkills([skill({ enabled: true, updatedAt: new Date("2026-11-03T09:00:00.000Z") })]));

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_clean");
  });

  it("stays clean against a version that records no skills, which serves the live skills the draft holds", async () => {
    const { service } = await publishedAgent("none recorded");

    await service.mutateDraft(workspaceId, agentId, withSkills([skill()]));

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_clean");
  });

  it("stays clean when only the default-answer skill differs, because retrieval settings apply live", async () => {
    const { service } = await publishedAgent([answer({ sourceScope: "all" })]);

    await service.mutateDraft(workspaceId, agentId, withSkills([answer({ sourceScope: { sourceIds: ["77777777-7777-4777-8777-777777777777"] } })]));

    expect((await service.state(workspaceId, agentId)).status).toBe("draft_clean");
  });

  it("is clean again after the skill is published", async () => {
    const { service } = await publishedAgent([]);
    await service.mutateDraft(workspaceId, agentId, withSkills([skill()]));

    await publishDraft(service, "second");

    const state = await service.state(workspaceId, agentId);
    expect(state.status).toBe("draft_clean");
    expect(state.publishedRevision?.snapshot.agentSkills).toEqual([expect.objectContaining({ skillName: "lookup_orders" })]);
  });
});
