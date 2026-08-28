import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Findings 3-4 (issue triage, next-ray-epic-issue): applyProposal's writes only translated the
// insert branch's workspace+name unique-constraint violation into a real `conflict`. Two other
// writes in the same transaction could raise a raw, untranslated persistence error instead:
//
// - Finding 3: renaming an existing variable onto another variable's name hits the identical
//   context_variables_workspace_id_name_key constraint, but through the update branch, which had
//   no translation at all - applyIfVersionMatches's isStale() check never recognizes a raw pg
//   driver error, so a rename collision that races Apply (the copilot adapter's own draft-time
//   name check closes the common case, but not a second proposal landing between draft and Apply)
//   surfaced as "failed" with the raw driver error instead of "stale".
// - Finding 4: an enablement-only proposal (no definition write to notice a missing row) whose
//   context variable was deleted between draft and Apply had nothing checking the variable still
//   exists before inserting into agent_context_variables, so the insert raised a raw
//   agent_context_variables_variable_id_fkey violation instead of a translated conflict.
//
// Both are exercised against a real Postgres transaction because the unique-constraint and
// foreign-key violations these tests assert against only ever occur once the driver, not this
// module's own code, rejects the write.
const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ContextVariableRepository.applyProposal conflict translation (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const contextVariableRepository = new ContextVariableRepository(database.kysely);
  const agentRepository = new AgentRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  let agentId: string;

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Apply Proposal Conflicts Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Apply Proposal Conflicts Workspace",
      `route-${workspaceId}`,
    ]);
    const agent = await agentRepository.create(workspaceId, { name: "Apply Proposal Conflicts Agent" });
    agentId = agent.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createVariable = (name: string) => contextVariableRepository.create({
    workspaceId,
    name,
    valueType: "string",
    trustTier: "unverified",
    sensitivity: "normal",
    defaultSurfacing: "on_reference",
  });

  it("translates a rename collision into a conflict, not a raw persistence error", async () => {
    const variableA = await createVariable(`var_a_${randomUUID().slice(0, 8)}`);
    const variableB = await createVariable(`var_b_${randomUUID().slice(0, 8)}`);

    await expect(contextVariableRepository.applyProposal({
      workspaceId,
      agentId,
      variableId: variableA.id,
      definition: {
        name: variableB.name,
        description: null,
        valueType: "string",
        trustTier: "unverified",
        sensitivity: "normal",
        defaultSurfacing: "on_reference",
      },
      expectedVariableUpdatedAt: variableA.updatedAt,
      enablement: null,
      expectedEnablementUpdatedAt: null,
    })).rejects.toMatchObject({ statusCode: 409 });

    // The rejected rename must not have landed - variableA still holds its original name.
    const reread = await contextVariableRepository.get(workspaceId, variableA.id);
    expect(reread?.name).toBe(variableA.name);
  });

  it("translates an enablement-only proposal's deleted variable target into a conflict, not a raw persistence error", async () => {
    const variable = await createVariable(`var_${randomUUID().slice(0, 8)}`);
    // The variable named at draft time is gone by the time Apply runs - the exact gap Finding 4
    // describes: nothing but this apply-time check stands between a deleted variable and an
    // enablement insert that violates agent_context_variables_variable_id_fkey.
    expect(await contextVariableRepository.delete(workspaceId, variable.id)).toBe(true);

    await expect(contextVariableRepository.applyProposal({
      workspaceId,
      agentId,
      variableId: variable.id,
      definition: null,
      expectedVariableUpdatedAt: null,
      enablement: { source: "pushed", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "on_reference", enabled: true },
      expectedEnablementUpdatedAt: null,
    })).rejects.toMatchObject({ statusCode: 409 });

    // No enablement row survives the rolled-back transaction.
    const enablements = await contextVariableRepository.listByAgent(workspaceId, agentId);
    expect(enablements.find((enablement) => enablement.variableId === variable.id)).toBeUndefined();
  });
});
