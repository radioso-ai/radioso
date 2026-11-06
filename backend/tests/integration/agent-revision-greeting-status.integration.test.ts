import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { AgentRevisionService } from "../../src/modules/agents/agentRevision.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const greeting = (chipLabels: Record<string, string>) => ({
  exactWordsEnabled: true,
  exactContent: { chips: ["plans", "sales"], variants: [{ locale: "en", body: "Welcome!", chipLabels }] },
});

describeDb("agent revision status for a greeting-only draft", () => {
  const accountId = randomUUID(), workspaceId = randomUUID();
  let database: Database;
  let revisions: AgentRevisionRepository;
  let agents: AgentRepository;
  let service: AgentRevisionService;

  /** An agent whose draft and first published release hold the same instruction, so only the greeting can differ. */
  const publishedAgent = async (publishedSnapshotJson?: string) => {
    const agentId = randomUUID();
    const snapshot = JSON.stringify({ customInstruction: "Be brief.", directives: [], routines: [], contextVariableEnablements: [] });
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [agentId, workspaceId, `greeting ${agentId}`]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,1,$3::jsonb)", [agentId, workspaceId, snapshot]);
    const candidateId = randomUUID();
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation,source_base_published_revision_id) VALUES ($1,$2,$3,$4::jsonb,1,NULL)", [candidateId, agentId, workspaceId, publishedSnapshotJson ?? snapshot]);
    const published = await revisions.publish({ workspaceId, agentId, actorAccountId: null, revisionId: candidateId, expectedDraftGeneration: 1, expectedPublishedRevisionId: null, idempotencyKey: `first-${agentId}` });
    if (published === "conflict" || published === "idempotency_mismatch") throw new Error("first publication failed");
    return { agentId, candidateId };
  };

  beforeAll(async () => {
    database = new Database(url!);
    await runAllTestMigrations(database);
    revisions = new AgentRevisionRepository(database.kysely);
    agents = new AgentRepository(database.kysely);
    service = new AgentRevisionService(revisions, randomUUID);
    await database.query("INSERT INTO accounts (id,name,email,password_hash) VALUES ($1,$2,$3,$4)", [accountId, "greeting status test", `greeting-status-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id,account_id,name,public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "greeting status", `greeting-status-${workspaceId}`]);
  });
  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id=$1", [accountId]).catch(() => undefined);
    await database.close();
  });

  it("is dirty once the greeting is saved through the draft writer, can be tested, and is clean again after it is published", async () => {
    const { agentId, candidateId } = await publishedAgent();
    await expect(revisions.readState(workspaceId, agentId)).resolves.toMatchObject({ status: "draft_clean" });

    await agents.updateDraftGreeting(agentId, workspaceId, greeting({ plans: "Compare plans", sales: "Talk to sales" }));

    const dirty = await revisions.readState(workspaceId, agentId);
    expect(dirty).toMatchObject({ status: "draft_dirty" });
    const testRevision = await service.resolveDefaultTestRevision(workspaceId, agentId);
    expect(testRevision.revisionId).not.toBe(candidateId);
    expect((await service.detail(workspaceId, agentId, testRevision.revisionId)).snapshot.greeting).toEqual(greeting({ plans: "Compare plans", sales: "Talk to sales" }));

    const published = await revisions.publish({ workspaceId, agentId, actorAccountId: null, revisionId: testRevision.revisionId, expectedDraftGeneration: testRevision.expectedDraftGeneration, expectedPublishedRevisionId: candidateId, idempotencyKey: `second-${agentId}` });
    expect(published).toMatchObject({ idempotentReplay: false });
    await expect(revisions.readState(workspaceId, agentId)).resolves.toMatchObject({ status: "draft_clean" });
  });

  it("reads a draft and a published revision as the same greeting when their chip labels were written in another key order", async () => {
    const stored = JSON.stringify({ customInstruction: "Be brief.", directives: [], routines: [], contextVariableEnablements: [], greeting: greeting({ plans: "Compare plans", sales: "Talk to sales" }) });
    const { agentId } = await publishedAgent(stored);
    await expect(revisions.readState(workspaceId, agentId)).resolves.toMatchObject({ status: "draft_dirty" });

    await agents.updateDraftGreeting(agentId, workspaceId, greeting({ sales: "Talk to sales", plans: "Compare plans" }));

    await expect(revisions.readState(workspaceId, agentId)).resolves.toMatchObject({ status: "draft_clean" });
  });

  it("reads a draft with no greeting as equal to a published revision that carries the default one", async () => {
    const stored = JSON.stringify({ customInstruction: "Be brief.", directives: [], routines: [], contextVariableEnablements: [], greeting: { exactWordsEnabled: false, exactContent: null } });
    const { agentId } = await publishedAgent(stored);

    await expect(revisions.readState(workspaceId, agentId)).resolves.toMatchObject({ status: "draft_clean" });
  });
});
