import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ContextVariableRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new ContextVariableRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Context Variable Co",
      `context-variable-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Context Variable Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1,$2,$3)`, [
      agentId,
      workspaceId,
      "Context Variable Agent",
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM context_variables WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM agents WHERE id = $1`, [agentId]).catch(() => undefined);
    await database.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("creates, updates, lists, gets, and deletes host variable declarations and enablements", async () => {
    const variable = await repository.create({
      workspaceId,
      name: `cart_${randomUUID().replaceAll("-", "_")}`,
      description: "Current shopping cart",
      valueType: "json",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
    });

    expect(variable).toMatchObject({
      workspaceId,
      description: "Current shopping cart",
      valueType: "json",
      defaultSurfacing: "always",
    });
    expect(await repository.get(workspaceId, variable.id)).toMatchObject({ id: variable.id });
    expect((await repository.listByWorkspace(workspaceId)).map((row) => row.id)).toContain(variable.id);

    const updated = await repository.update(workspaceId, variable.id, {
      description: null,
      trustTier: "signed",
      sensitivity: "sensitive",
      defaultSurfacing: "on_reference",
    });
    expect(updated).toMatchObject({
      description: null,
      trustTier: "signed",
      sensitivity: "sensitive",
      defaultSurfacing: "on_reference",
    });

    const enablement = await repository.upsertEnablement({
      agentId,
      variableId: variable.id,
      source: "pushed",
      surfacing: "always",
      enabled: true,
    });
    expect(enablement).toMatchObject({ agentId, variableId: variable.id, source: "pushed", enabled: true });

    const reenabled = await repository.upsertEnablement({
      agentId,
      variableId: variable.id,
      source: "pushed",
      surfacing: "operator_only",
      enabled: false,
    });
    expect(reenabled).toMatchObject({ id: enablement.id, surfacing: "operator_only", enabled: false });

    const listed = await repository.listByAgent(workspaceId, agentId);
    expect(listed.find((row) => row.variableId === variable.id)).toMatchObject({
      id: enablement.id,
      variable: { id: variable.id, name: variable.name },
    });

    expect(await repository.deleteEnablement(agentId, variable.id)).toBe(true);
    expect(await repository.delete(workspaceId, variable.id)).toBe(true);
    expect(await repository.get(workspaceId, variable.id)).toBeNull();
  });

  it("upserts, reads, and deletes scoped JSON values", async () => {
    const variable = await repository.create({
      workspaceId,
      name: `order_status_${randomUUID().replaceAll("-", "_")}`,
      valueType: "json",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
    });
    const scope = { type: "session" as const, id: `session-${randomUUID()}` };

    const created = await repository.upsertValue(variable.id, scope, { status: "processing", lines: ["a", "b"] });
    expect(created).toMatchObject({ workspaceId, variableId: variable.id, scope });
    expect(created.data).toEqual({ status: "processing", lines: ["a", "b"] });

    const updated = await repository.upsertValue(variable.id, scope, { status: "shipped" });
    expect(updated.id).toBe(created.id);
    expect(await repository.readValue(variable.id, scope)).toMatchObject({ data: { status: "shipped" } });

    expect(await repository.deleteValue(variable.id, scope)).toBe(true);
    expect(await repository.readValue(variable.id, scope)).toBeNull();
  });

  it("resolves pushed values by scope ladder and maps resolved variable metadata", async () => {
    const variable = await repository.create({
      workspaceId,
      name: `profile_${randomUUID().replaceAll("-", "_")}`,
      description: "Verified visitor profile",
      valueType: "json",
      trustTier: "signed",
      sensitivity: "sensitive",
      defaultSurfacing: "on_reference",
    });
    await repository.upsertEnablement({
      agentId,
      variableId: variable.id,
      source: "pushed",
      surfacing: "on_reference",
      enabled: true,
    });

    const scopes = [
      { type: "session" as const, id: `session-${randomUUID()}` },
      { type: "customer" as const, id: `customer-${randomUUID()}` },
      { type: "agent" as const, id: agentId },
      { type: "workspace" as const, id: workspaceId },
    ];
    await repository.upsertValue(variable.id, scopes[3], { rung: "workspace" });
    await repository.upsertValue(variable.id, scopes[2], { rung: "agent" });
    await repository.upsertValue(variable.id, scopes[1], { rung: "customer" });
    await repository.upsertValue(variable.id, scopes[0], { rung: "session" });

    await expect(repository.resolveForAgent(workspaceId, agentId, scopes)).resolves.toEqual([
      {
        name: variable.name,
        description: "Verified visitor profile",
        value: { rung: "session" },
        surfacing: "on_reference",
        sensitive: true,
        trust: "verified",
      },
    ]);

    await repository.deleteValue(variable.id, scopes[0]);
    expect((await repository.resolveForAgent(workspaceId, agentId, scopes))[0]?.value).toEqual({ rung: "customer" });
    await repository.deleteValue(variable.id, scopes[1]);
    expect((await repository.resolveForAgent(workspaceId, agentId, scopes))[0]?.value).toEqual({ rung: "agent" });
    await repository.deleteValue(variable.id, scopes[2]);
    expect((await repository.resolveForAgent(workspaceId, agentId, scopes))[0]?.value).toEqual({ rung: "workspace" });
  });

  it("skips valueless, disabled, browser, and resolver enablements during pushed resolution", async () => {
    const isolatedAgentId = randomUUID();
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1,$2,$3)`, [
      isolatedAgentId,
      workspaceId,
      "Context Variable Skip Agent",
    ]);
    const scopes = [{ type: "workspace" as const, id: workspaceId }];
    const active = await repository.create({
      workspaceId,
      name: `active_${randomUUID().replaceAll("-", "_")}`,
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
    });
    const valueless = await repository.create({
      workspaceId,
      name: `valueless_${randomUUID().replaceAll("-", "_")}`,
      valueType: "json",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
    });
    const disabled = await repository.create({
      workspaceId,
      name: `disabled_${randomUUID().replaceAll("-", "_")}`,
      valueType: "json",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
    });
    const browser = await repository.create({
      workspaceId,
      name: `browser_${randomUUID().replaceAll("-", "_")}`,
      valueType: "json",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
    });
    const resolver = await repository.create({
      workspaceId,
      name: `resolver_${randomUUID().replaceAll("-", "_")}`,
      valueType: "json",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
    });

    await repository.upsertEnablement({ agentId: isolatedAgentId, variableId: active.id, source: "pushed", surfacing: "always" });
    await repository.upsertEnablement({ agentId: isolatedAgentId, variableId: valueless.id, source: "pushed", surfacing: "always" });
    await repository.upsertEnablement({
      agentId: isolatedAgentId,
      variableId: disabled.id,
      source: "pushed",
      surfacing: "always",
      enabled: false,
    });
    await repository.upsertEnablement({ agentId: isolatedAgentId, variableId: browser.id, source: "browser", surfacing: "always" });
    await repository.upsertEnablement({
      agentId: isolatedAgentId,
      variableId: resolver.id,
      source: "resolver",
      resolverSkillId: randomUUID(),
      maxAgeSeconds: 60,
      resolverTimeoutMs: 1000,
      surfacing: "always",
    });
    await repository.upsertValue(active.id, scopes[0], "active-value");
    await repository.upsertValue(disabled.id, scopes[0], "disabled-value");
    await repository.upsertValue(browser.id, scopes[0], "browser-value");
    await repository.upsertValue(resolver.id, scopes[0], "resolver-value");

    expect((await repository.resolveForAgent(workspaceId, isolatedAgentId, scopes)).map((row) => row.name)).toEqual([
      active.name,
    ]);
  });
});
