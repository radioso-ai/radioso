import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaceRepository.js";
import { AgentRetrievalAuthoringService } from "../../../src/modules/agentSkills/retrievalAuthoring.js";
import { AgentSkillRepository } from "../../../src/modules/agentSkills/repository.js";
import { AgentSkillsService } from "../../../src/modules/agentSkills/service.js";
import { createDefaultSkillCapabilityRegistry } from "../../../src/modules/skills/public.js";
import { Database } from "../../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("Operator MCP retrieval authoring (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const accountRepository = new AccountRepository(database.kysely);
  const workspaceRepository = new WorkspaceRepository(database.kysely);
  const agentRepository = new AgentRepository(database.kysely);
  const repository = new AgentSkillRepository(database.kysely);
  const skills = new AgentSkillsService({ repository, capabilities: createDefaultSkillCapabilityRegistry() });
  const authoring = new AgentRetrievalAuthoringService({
    agentSkills: skills,
    defaults: { getDefaults: (workspaceId) => ({ workspaceId }) as never },
  });
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    await runAllTestMigrations(database);
    const account = await accountRepository.create({ name: "MCP retrieval authoring", email: `mcp-retrieval-${randomUUID()}@example.com`, passwordHash: "hash" });
    const workspace = await workspaceRepository.create(account.id, "MCP retrieval authoring");
    workspaceId = workspace.id;
    agentId = (await agentRepository.create(workspace.id, { name: "MCP retrieval authoring agent" })).id;
    // AgentRepository.create() already seeded this agent's default-answer retrieve skill
    // (named "answer"); configure that one instead of creating a second - the schema allows
    // exactly one default-answer skill per agent.
    const defaultAnswerSkill = await repository.findDefaultAnswer(workspaceId, agentId);
    if (!defaultAnswerSkill) {
      throw new Error("expected AgentRepository.create() to seed a default-answer retrieve skill");
    }
    await skills.update(workspaceId, agentId, defaultAnswerSkill.id, {
      replaceConfig: { sourceScope: "all", vectorTopK: 12, rerankEnabled: true, rerankTopK: 8, exposedInputs: { query: true } },
    });
  });

  afterAll(async () => {
    await database.close().catch(() => undefined);
  });

  it("prepares one reviewed full config while preserving omitted fields", async () => {
    const reviewed = await authoring.preparePatch({ workspaceId, agentId, patch: { vectorTopK: 36 } });
    expect(reviewed.before).toMatchObject({ vectorTopK: 12, rerankTopK: 8 });
    expect(reviewed.after).toMatchObject({ vectorTopK: 36, rerankTopK: 8 });

  });

  it("does not persist a rejected unsupported/default patch", async () => {
    const before = await authoring.inspect({ workspaceId, agentId });

    await expect(authoring.preparePatch({
      workspaceId,
      agentId,
      patch: { similarityThreshold: 0.9 },
    })).rejects.toThrow();

    await expect(authoring.inspect({ workspaceId, agentId })).resolves.toMatchObject({
      agent: { settings: before.agent.settings },
    });
  });
});
