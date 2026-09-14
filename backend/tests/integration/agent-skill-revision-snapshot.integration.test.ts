import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/repository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) return false;
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = (await canReachIntegrationDatabase(integrationDatabaseUrl)) ? describe : describe.skip;

// Finding 2 (agent-revision-versioning audit): agent-selectable skills (the MCP-tool /
// webhook / etc. rows an operator wires up) never fed the agent-revision draft snapshot,
// unlike directives, routines, and context-variable enablements. A turn on an old pinned
// revision therefore always read *live* skill config, defeating the whole point of pinning.
// These tests exercise the real Postgres-backed AgentSkillRepository (not the in-memory
// fake other agentSkills tests use) because the fix's correctness hinges on it writing the
// skill row and projecting it into `agent_drafts.snapshot` inside the same transaction.
describeIfDatabase("agent skill writes sync the draft revision snapshot (finding 2)", () => {
  let database: Database;
  let agentSkillRepository: AgentSkillRepository;
  let agentRevisionRepository: AgentRevisionRepository;
  let workspaceId: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    agentSkillRepository = new AgentSkillRepository(database.kysely);
    agentRevisionRepository = new AgentRevisionRepository(database.kysely);

    const accountRepository = new AccountRepository(database.kysely);
    const workspaceRepository = new WorkspaceRepository(database.kysely);
    const account = await accountRepository.create({
      name: "Agent Skill Revision Snapshot IT",
      email: `agent-skill-revision-snapshot-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Agent Skill Revision Snapshot IT");
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
  });

  const createTestAgent = async (name: string): Promise<string> => {
    const agentRepository = new AgentRepository(database.kysely);
    const agent = await agentRepository.create(workspaceId, { name });
    return agent.id;
  };

  it("create/update/remove keep the draft snapshot's agentSkills in lockstep with the live row", async () => {
    const agentId = await createTestAgent("Skill Sync Agent");

    const created = await agentSkillRepository.create({
      workspaceId,
      agentId,
      skillName: "lookup_orders",
      kind: "notify",
      config: { toolName: "lookup_orders" },
      invocationMode: "agent_selectable",
      enabled: true,
    });

    const draftAfterCreate = await agentRevisionRepository.readDraft(workspaceId, agentId);
    expect(draftAfterCreate?.snapshot.agentSkills).toContainEqual(
      expect.objectContaining({ id: created.id, skillName: "lookup_orders", enabled: true }),
    );

    const updated = await agentSkillRepository.update(workspaceId, agentId, created.id, { enabled: false });
    expect(updated?.enabled).toBe(false);

    const draftAfterUpdate = await agentRevisionRepository.readDraft(workspaceId, agentId);
    expect(draftAfterUpdate?.snapshot.agentSkills).toContainEqual(
      expect.objectContaining({ id: created.id, enabled: false }),
    );
    expect(draftAfterUpdate?.snapshot.agentSkills).toHaveLength(1);

    const removed = await agentSkillRepository.remove(workspaceId, agentId, created.id);
    expect(removed).toBe(true);

    const draftAfterRemove = await agentRevisionRepository.readDraft(workspaceId, agentId);
    expect(draftAfterRemove?.snapshot.agentSkills).toEqual([]);
  });

  it("seeds the full live skill list on first write instead of dropping skills that predate snapshot tracking", async () => {
    const agentId = await createTestAgent("Legacy Draft Agent");

    // Simulate a draft persisted before this fix shipped: no `agentSkills` key at all.
    await database.query(
      "UPDATE agent_drafts SET snapshot = snapshot - 'agentSkills' WHERE workspace_id = $1 AND agent_id = $2",
      [workspaceId, agentId],
    );
    const legacyDraft = await agentRevisionRepository.readDraft(workspaceId, agentId);
    expect(legacyDraft?.snapshot.agentSkills).toBeUndefined();

    // A skill created directly against the live table (as if it predates this fix) must not
    // be silently dropped when the first post-fix write seeds the snapshot from live state.
    const preexisting = await agentSkillRepository.create({
      workspaceId,
      agentId,
      skillName: "preexisting_skill",
      kind: "notify",
      invocationMode: "agent_selectable",
      enabled: true,
    });
    // Revert that create's own sync so the draft again looks untouched-since-legacy, isolating
    // what the *next* write has to reconstruct.
    await database.query(
      "UPDATE agent_drafts SET snapshot = snapshot - 'agentSkills' WHERE workspace_id = $1 AND agent_id = $2",
      [workspaceId, agentId],
    );

    const secondSkill = await agentSkillRepository.create({
      workspaceId,
      agentId,
      skillName: "new_skill",
      kind: "notify",
      invocationMode: "agent_selectable",
      enabled: true,
    });

    const draft = await agentRevisionRepository.readDraft(workspaceId, agentId);
    const skillNames = (draft?.snapshot.agentSkills ?? []).map((skill) => skill.skillName).sort();
    expect(skillNames).toEqual(["new_skill", "preexisting_skill"].sort());
    expect(draft?.snapshot.agentSkills).toContainEqual(expect.objectContaining({ id: preexisting.id }));
    expect(draft?.snapshot.agentSkills).toContainEqual(expect.objectContaining({ id: secondSkill.id }));
  });

  it("createCandidate seeds agentSkills from live state when the draft predates tracking", async () => {
    const agentId = await createTestAgent("Candidate Seed Agent");
    const skill = await agentSkillRepository.create({
      workspaceId,
      agentId,
      skillName: "candidate_seed_skill",
      kind: "notify",
      invocationMode: "agent_selectable",
      enabled: true,
    });
    // Make the draft look like it predates skill tracking again, so createCandidate is the
    // one responsible for reconstructing agentSkills for this candidate.
    await database.query(
      "UPDATE agent_drafts SET snapshot = snapshot - 'agentSkills' WHERE workspace_id = $1 AND agent_id = $2",
      [workspaceId, agentId],
    );

    const draftBeforeCandidate = await agentRevisionRepository.readDraft(workspaceId, agentId);
    if (!draftBeforeCandidate) throw new Error("draft unavailable");
    const candidate = await agentRevisionRepository.createCandidate(workspaceId, agentId, {
      id: randomUUID(),
      expectedDraftGeneration: draftBeforeCandidate.generation,
    });
    if (candidate === "conflict") throw new Error("candidate creation conflicted");
    expect(candidate.snapshot.agentSkills).toContainEqual(expect.objectContaining({ id: skill.id }));
  });
});
