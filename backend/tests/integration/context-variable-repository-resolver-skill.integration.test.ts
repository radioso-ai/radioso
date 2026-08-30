import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/repository.js";
import { ContextVariableService } from "../../src/modules/context-variables/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { notFound } from "../../src/shared/domain/errors.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ContextVariableService resolver skill validation (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const contextVariableRepository = new ContextVariableRepository(database.kysely);
  const agentRepository = new AgentRepository(database.kysely);
  const agentSkillRepository = new AgentSkillRepository(database.kysely);
  const contextVariableService = new ContextVariableService({
    repository: contextVariableRepository,
    agentReader: {
      async get(workspaceId, agentId) {
        const agent = await agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
        if (!agent) throw notFound("Agent not found");
        return agent;
      },
    },
    agentSkillsReader: { list: agentSkillRepository.listByAgent.bind(agentSkillRepository) },
  });

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  let agentId: string;

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Resolver Skill Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Resolver Skill Workspace",
      `route-${workspaceId}`,
    ]);
    const agent = await agentRepository.create(workspaceId, { name: "Resolver Agent" });
    agentId = agent.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createSkill = () => agentSkillRepository.create({
    workspaceId,
    agentId,
    skillName: `resolver_${randomUUID().slice(0, 8)}`,
    kind: "retrieve",
    invocationMode: "routine_named",
    config: {},
  });

  it("persists a resolver enablement whose skill exists on this agent", async () => {
    const skill = await createSkill();
    const variableName = `var_${randomUUID().slice(0, 8)}`;

    const result = await contextVariableService.applyProposal({
      workspaceId,
      agentId,
      variableId: null,
      definition: { name: variableName, description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference" },
      expectedVariableUpdatedAt: null,
      enablement: { source: "resolver", resolverSkillId: skill.id, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "operator_only", enabled: true },
      expectedEnablementUpdatedAt: null,
    });

    const enablements = await contextVariableRepository.listByAgent(workspaceId, agentId);
    expect(enablements.find((enablement) => enablement.variableId === result.variableId)?.resolverSkillId).toBe(skill.id);
  });

  it("rejects a direct resolver enablement once its skill is disabled", async () => {
    const skill = await createSkill();
    const variable = await contextVariableRepository.create({
      workspaceId,
      name: `direct_${randomUUID().slice(0, 8)}`,
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
    });
    expect(await agentSkillRepository.update(workspaceId, agentId, skill.id, { enabled: false })).not.toBeNull();

    await expect(contextVariableRepository.upsertEnablement({
      agentId,
      variableId: variable.id,
      source: "resolver",
      resolverSkillId: skill.id,
      maxAgeSeconds: null,
      resolverTimeoutMs: null,
      surfacing: "always",
      enabled: true,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("reports a direct proposal resolver-skill race as a conflict", async () => {
    const skill = await createSkill();
    expect(await agentSkillRepository.remove(workspaceId, agentId, skill.id)).toBe(true);

    await expect(contextVariableRepository.applyProposal({
      workspaceId,
      agentId,
      variableId: null,
      definition: {
        name: `proposal_${randomUUID().slice(0, 8)}`,
        description: null,
        valueType: "string",
        trustTier: "unverified",
        sensitivity: "normal",
        defaultSurfacing: "always",
      },
      expectedVariableUpdatedAt: null,
      enablement: {
        source: "resolver",
        resolverSkillId: skill.id,
        maxAgeSeconds: null,
        resolverTimeoutMs: null,
        surfacing: "always",
        enabled: true,
      },
      expectedEnablementUpdatedAt: null,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses to apply a resolver enablement once the named skill has been deleted, rather than persisting an inert one", async () => {
    const skill = await createSkill();
    const variableName = `var_${randomUUID().slice(0, 8)}`;
    // The skill named at draft time is gone by the time Apply runs - the exact gap Finding 2
    // describes: nothing but this apply-time check stands between a deleted skill and a
    // resolver enablement that will never resolve anything.
    expect(await agentSkillRepository.remove(workspaceId, agentId, skill.id)).toBe(true);

    await expect(contextVariableService.applyProposal({
      workspaceId,
      agentId,
      variableId: null,
      definition: { name: variableName, description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference" },
      expectedVariableUpdatedAt: null,
      enablement: { source: "resolver", resolverSkillId: skill.id, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "operator_only", enabled: true },
      expectedEnablementUpdatedAt: null,
    })).rejects.toMatchObject({ statusCode: 409 });

    // Proposal preflight reports the changed resolver dependency as stale before the repository
    // is asked to write, so it cannot leave a definition-only row behind.
    const variables = await database.query(`SELECT id FROM context_variables WHERE workspace_id = $1 AND name = $2`, [workspaceId, variableName]);
    expect(variables).toHaveLength(0);
  });

  it("refuses to apply a resolver enablement once the named skill has been disabled, rather than persisting an inert one", async () => {
    const skill = await createSkill();
    const variableName = `var_${randomUUID().slice(0, 8)}`;
    expect(await agentSkillRepository.update(workspaceId, agentId, skill.id, { enabled: false })).not.toBeNull();

    await expect(contextVariableService.applyProposal({
      workspaceId,
      agentId,
      variableId: null,
      definition: { name: variableName, description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference" },
      expectedVariableUpdatedAt: null,
      enablement: { source: "resolver", resolverSkillId: skill.id, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "operator_only", enabled: true },
      expectedEnablementUpdatedAt: null,
    })).rejects.toMatchObject({ statusCode: 409 });

    const variables = await database.query(`SELECT id FROM context_variables WHERE workspace_id = $1 AND name = $2`, [workspaceId, variableName]);
    expect(variables).toHaveLength(0);
  });
});
