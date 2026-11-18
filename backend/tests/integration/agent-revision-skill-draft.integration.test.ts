import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { presentRevisionDetail } from "../../src/app/http/routes/agentRevisionPresenters.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { AgentRevisionRuntimeRepository } from "../../src/db/repositories/agentRevisionRuntimeRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/repository.js";
import { AgentRevisionRuntimeResolver, AgentRevisionService } from "../../src/modules/agents/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

// Skill writes go into the agent's draft and conversations read skills from the published
// release, so a skills-only edit has to count as a draft change: otherwise Publish stays off,
// Test Chat runs the published release, and the edit ships unreviewed with an unrelated publish.
describeDb("a skills-only edit across an agent's draft and releases", () => {
  const accountId = randomUUID(), workspaceId = randomUUID();
  let database: Database;
  let agents: AgentRepository;
  let skills: AgentSkillRepository;
  let revisions: AgentRevisionRepository;
  let service: AgentRevisionService;
  let resolver: AgentRevisionRuntimeResolver;

  beforeAll(async () => {
    database = new Database(url!);
    await runAllTestMigrations(database);
    agents = new AgentRepository(database.kysely);
    skills = new AgentSkillRepository(database.kysely);
    revisions = new AgentRevisionRepository(database.kysely);
    service = new AgentRevisionService(revisions, randomUUID);
    resolver = new AgentRevisionRuntimeResolver(new AgentRevisionRuntimeRepository(database.kysely));
    await database.query("INSERT INTO accounts (id,name,email,password_hash) VALUES ($1,$2,$3,$4)", [accountId, "skill draft test", `skill-draft-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id,account_id,name,public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "skill draft", `skill-draft-${workspaceId}`]);
  });
  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id=$1", [accountId]).catch(() => undefined);
    await database.close();
  });

  const publishDraft = async (agentId: string) => {
    const state = await service.state(workspaceId, agentId);
    const candidate = await service.createCandidate(workspaceId, agentId, state.draft.generation);
    await service.publish(workspaceId, agentId, null, {
      revisionId: candidate.id,
      expectedDraftGeneration: state.draft.generation,
      expectedPublishedRevisionId: state.publishedRevision?.id ?? null,
      idempotencyKey: randomUUID(),
    });
    return candidate;
  };

  const visitorSkillNames = async (agentId: string): Promise<string[]> => {
    const agent = await agents.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) throw new Error("agent missing");
    const resolved = await resolver.resolveNew({ workspaceId, agent });
    return (resolved.agent.authoredAgentSkills ?? []).map((skill) => skill.skillName).sort();
  };

  const createLookupSkill = (agentId: string) => skills.create({
    workspaceId,
    agentId,
    skillName: "lookup_orders",
    kind: "notify",
    config: { delivery: { recipientEmails: ["orders@acme.example"] } },
    invocationMode: "agent_selectable",
    enabled: true,
  });

  it("marks the draft changed, lists the skill by name in the review, tests it, and reaches visitors only after publish", async () => {
    const agent = await agents.create(workspaceId, { name: "Skills draft", customInstruction: "Be brief." });
    await publishDraft(agent.id);
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_clean" });

    await createLookupSkill(agent.id);

    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_dirty" });
    expect(await visitorSkillNames(agent.id)).not.toContain("lookup_orders");

    const tested = await service.resolveDefaultTestRevision(workspaceId, agent.id);
    const candidate = await service.detail(workspaceId, agent.id, tested.revisionId);
    expect(candidate.snapshot.agentSkills?.map((skill) => skill.skillName)).toContain("lookup_orders");
    const base = await service.detail(workspaceId, agent.id, candidate.sourceBasePublishedRevisionId!);
    expect(presentRevisionDetail(candidate, base).scopedChanges.agentSkills).toEqual([
      expect.objectContaining({ skillName: "lookup_orders", change: "added" }),
    ]);

    await publishDraft(agent.id);

    expect(await visitorSkillNames(agent.id)).toContain("lookup_orders");
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_clean" });
  });

  it("keeps the draft clean when a skill save leaves it as published, though the row was rewritten", async () => {
    const agent = await agents.create(workspaceId, { name: "Skills unchanged", customInstruction: "Be brief." });
    const skill = await createLookupSkill(agent.id);
    await publishDraft(agent.id);

    await skills.update(workspaceId, agent.id, skill.id, { enabled: false });
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_dirty" });
    await skills.update(workspaceId, agent.id, skill.id, { enabled: true });

    const draft = await revisions.readDraft(workspaceId, agent.id);
    expect(draft?.snapshot.agentSkills?.find((entry) => entry.id === skill.id)?.updatedAt.getTime()).toBeGreaterThan(skill.updatedAt.getTime());
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_clean" });
  });
});
