import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/repository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Finding 2 (issue triage, next-ray-epic-issue): a resolver-sourced context-variable
// enablement's resolverSkillId is validated only when the copilot proposal is drafted
// (copilotProposalAdapters.ts's resolveProposal). agent_context_variables.resolver_skill_id
// carries no foreign key (migration 112), and a proposal can sit pending indefinitely, so a
// skill deleted after drafting and before Apply previously persisted an enablement pointing at
// nothing - inert at runtime (SkillBackedContextResolver.resolve silently returns null for an
// id it cannot find), with no error anywhere. This exercises the real Postgres transaction
// applyProposal now runs the same check inside, so a deleted skill turns Apply into a real
// conflict instead.
const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ContextVariableRepository.applyProposal resolver skill existence (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const contextVariableRepository = new ContextVariableRepository(database.kysely);
  const agentRepository = new AgentRepository(database.kysely);
  const agentSkillRepository = new AgentSkillRepository(database.kysely);

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

  const createVariable = () => contextVariableRepository.create({
    workspaceId,
    name: `var_${randomUUID().slice(0, 8)}`,
    valueType: "string",
    trustTier: "unverified",
    sensitivity: "normal",
    defaultSurfacing: "on_reference",
  });

  it("refuses direct resolver enablement when the named skill is missing", async () => {
    const variable = await createVariable();

    await expect(contextVariableRepository.upsertEnablement({
      agentId,
      variableId: variable.id,
      source: "resolver",
      resolverSkillId: randomUUID(),
      maxAgeSeconds: null,
      resolverTimeoutMs: null,
      surfacing: "operator_only",
      enabled: true,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses direct resolver enablement when the named skill is disabled", async () => {
    const skill = await createSkill();
    const variable = await createVariable();
    expect(await agentSkillRepository.update(workspaceId, agentId, skill.id, { enabled: false })).not.toBeNull();

    await expect(contextVariableRepository.upsertEnablement({
      agentId,
      variableId: variable.id,
      source: "resolver",
      resolverSkillId: skill.id,
      maxAgeSeconds: null,
      resolverTimeoutMs: null,
      surfacing: "operator_only",
      enabled: true,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("persists a resolver enablement whose skill exists on this agent", async () => {
    const skill = await createSkill();
    const variableName = `var_${randomUUID().slice(0, 8)}`;

    const result = await contextVariableRepository.applyProposal({
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

  it("refuses to apply a resolver enablement once the named skill has been deleted, rather than persisting an inert one", async () => {
    const skill = await createSkill();
    const variableName = `var_${randomUUID().slice(0, 8)}`;
    // The skill named at draft time is gone by the time Apply runs - the exact gap Finding 2
    // describes: nothing but this apply-time check stands between a deleted skill and a
    // resolver enablement that will never resolve anything.
    expect(await agentSkillRepository.remove(workspaceId, agentId, skill.id)).toBe(true);

    await expect(contextVariableRepository.applyProposal({
      workspaceId,
      agentId,
      variableId: null,
      definition: { name: variableName, description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference" },
      expectedVariableUpdatedAt: null,
      enablement: { source: "resolver", resolverSkillId: skill.id, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "operator_only", enabled: true },
      expectedEnablementUpdatedAt: null,
    })).rejects.toMatchObject({ statusCode: 409 });

    // The whole write rolled back, not just the enablement half: the variable definition this
    // same transaction would have created never persisted either, so retrying the proposal from
    // scratch (rather than landing on a half-created, un-enabled variable) is what "stale" means
    // here.
    const variables = await database.query(`SELECT id FROM context_variables WHERE workspace_id = $1 AND name = $2`, [workspaceId, variableName]);
    expect(variables).toHaveLength(0);
  });

  // Finding 2 (issue triage, next-ray-epic-issue): SkillBackedContextResolver.resolve silently
  // returns null for a disabled skill (contextResolverModule.ts checks agentSkill.enabled), and
  // the skill row itself carries no foreign key, so a skill disabled after drafting and before
  // Apply previously still passed this existence check and persisted an enablement that would
  // never resolve anything - the same inert-configuration gap the deleted-skill case above
  // already covers, just for "disabled" rather than "gone".
  it("refuses to apply a resolver enablement once the named skill has been disabled, rather than persisting an inert one", async () => {
    const skill = await createSkill();
    const variableName = `var_${randomUUID().slice(0, 8)}`;
    expect(await agentSkillRepository.update(workspaceId, agentId, skill.id, { enabled: false })).not.toBeNull();

    await expect(contextVariableRepository.applyProposal({
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
