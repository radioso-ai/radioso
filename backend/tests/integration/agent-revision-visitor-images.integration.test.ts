import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createVisitorImageAvailability } from "../../src/app/composition/visitorImages.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { AgentRevisionRuntimeRepository } from "../../src/db/repositories/agentRevisionRuntimeRepository.js";
import { AgentRevisionService } from "../../src/modules/agents/agentRevision.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("the photo switch across an agent's draft and releases", () => {
  const accountId = randomUUID(), workspaceId = randomUUID();
  let database: Database;
  let agents: AgentRepository;
  let revisions: AgentRevisionRepository;
  let service: AgentRevisionService;
  let takesPhotos: (agentId: string, revision?: { visitorImagesEnabled?: boolean }) => Promise<string>;

  beforeAll(async () => {
    database = new Database(url!);
    await runAllTestMigrations(database);
    agents = new AgentRepository(database.kysely);
    revisions = new AgentRevisionRepository(database.kysely);
    service = new AgentRevisionService(revisions, randomUUID);
    const availability = createVisitorImageAvailability({
      agents,
      publishedRevisions: new AgentRevisionRuntimeRepository(database.kysely),
      modelReading: { readsImages: async () => true },
    });
    takesPhotos = (agentId, revision) => availability.forAgent({ workspaceId, agentId, ...(revision ? { revision } : {}) });
    await database.query("INSERT INTO accounts (id,name,email,password_hash) VALUES ($1,$2,$3,$4)", [accountId, "photo switch test", `photo-switch-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id,account_id,name,public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "photo switch", `photo-switch-${workspaceId}`]);
  });
  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id=$1", [accountId]).catch(() => undefined);
    await database.close();
  });

  const publishDraft = async (agentId: string) => {
    const { draft } = await service.state(workspaceId, agentId);
    const candidate = await service.createCandidate(workspaceId, agentId, draft.generation);
    const current = await revisions.readState(workspaceId, agentId);
    const published = await revisions.publish({ workspaceId, agentId, actorAccountId: null, revisionId: candidate.id, expectedDraftGeneration: draft.generation, expectedPublishedRevisionId: current?.publishedRevision?.id ?? null, idempotencyKey: randomUUID() });
    if (published === "conflict" || published === "idempotency_mismatch") throw new Error(`publication failed: ${published}`);
    return candidate;
  };

  it("lets the draft turn photos on for Test Chat while visitors keep the published switch, until it is published", async () => {
    const agent = await agents.create(workspaceId, { name: "Photos", customInstruction: "Be brief.", visitorImagesEnabled: false });
    await publishDraft(agent.id);
    expect(await takesPhotos(agent.id)).toBe("disabled");

    await agents.update(agent.id, workspaceId, { visitorImagesEnabled: true });

    const draft = await revisions.readDraft(workspaceId, agent.id);
    expect(draft?.snapshot.visitorImagesEnabled).toBe(true);
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_dirty" });
    expect(await takesPhotos(agent.id)).toBe("disabled");
    const tested = await service.resolveDefaultTestRevision(workspaceId, agent.id);
    const testedRevision = await service.detail(workspaceId, agent.id, tested.revisionId);
    expect(testedRevision.snapshot.visitorImagesEnabled).toBe(true);
    expect(await takesPhotos(agent.id, testedRevision.snapshot)).toBe("available");

    await publishDraft(agent.id);

    expect(await takesPhotos(agent.id)).toBe("available");
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_clean" });
  });

  it("leaves the draft as it was when a save does not change the switch", async () => {
    const agent = await agents.create(workspaceId, { name: "Photos unchanged", customInstruction: "Be brief.", visitorImagesEnabled: true });
    const before = await revisions.readDraft(workspaceId, agent.id);

    await agents.update(agent.id, workspaceId, { visitorImagesEnabled: true, name: "Photos, renamed" });

    expect((await revisions.readDraft(workspaceId, agent.id))?.generation).toBe(before?.generation);
  });

  it("writes the switch into the draft when Ray's change is applied", async () => {
    const agent = await agents.create(workspaceId, { name: "Photos by Ray", customInstruction: "Be brief.", visitorImagesEnabled: false });

    const applied = await agents.applyProposalPatch(agent.id, workspaceId, { visitorImagesEnabled: true }, { expectedFields: [{ key: "visitorImagesEnabled", value: false }] });

    expect(applied.outcome).toBe("applied");
    expect((await revisions.readDraft(workspaceId, agent.id))?.snapshot.visitorImagesEnabled).toBe(true);
  });

  it("follows the agent's setting for a release frozen before the switch was part of a revision, and freezes it into the next candidate", async () => {
    const agentId = randomUUID();
    const snapshot = JSON.stringify({ customInstruction: "Be brief.", directives: [], routines: [], contextVariableEnablements: [] });
    await database.query("INSERT INTO agents (id,workspace_id,name,behavior_settings) VALUES ($1,$2,$3,$4::jsonb)", [agentId, workspaceId, "Older release", JSON.stringify({ visitorImagesEnabled: true })]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,1,$3::jsonb)", [agentId, workspaceId, snapshot]);
    const releaseId = randomUUID();
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation,source_base_published_revision_id) VALUES ($1,$2,$3,$4::jsonb,1,NULL)", [releaseId, agentId, workspaceId, snapshot]);
    const published = await revisions.publish({ workspaceId, agentId, actorAccountId: null, revisionId: releaseId, expectedDraftGeneration: 1, expectedPublishedRevisionId: null, idempotencyKey: `older-${agentId}` });
    if (published === "conflict" || published === "idempotency_mismatch") throw new Error("first publication failed");

    expect(await takesPhotos(agentId)).toBe("available");
    await expect(revisions.readState(workspaceId, agentId)).resolves.toMatchObject({ status: "draft_clean" });

    const candidate = await service.createCandidate(workspaceId, agentId, 1);
    expect(candidate.snapshot.visitorImagesEnabled).toBe(true);
  });
});
