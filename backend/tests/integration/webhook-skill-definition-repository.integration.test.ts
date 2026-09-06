import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { WebhookSkillDefinitionRepository } from "../../src/db/repositories/webhookSkillDefinitionRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("WebhookSkillDefinitionRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new WebhookSkillDefinitionRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const destinationId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "WHSkill Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "WHSkill Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO agents (id, workspace_id) VALUES ($1,$2)`, [agentId, workspaceId]);
    // agent_skills has a trigger validating webhook target_id → a real destination.
    await database.query(
      `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [destinationId, workspaceId, "Dest", "https://hooks.example.com", "enc", "key-1"],
    );
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM agent_skills WHERE agent_id = $1`, [agentId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const create = (skillName: string, enabled = true) =>
    repository.create({
      workspaceId,
      agentId,
      destinationId,
      skillName,
      boundPayload: { channel: "ops" },
      exposedPayload: { message: { type: "string" } } as never,
      enabled,
    });

  it("creates and reads back bound/exposed payloads", async () => {
    const created = await create("notify_ops");
    expect(created).toMatchObject({ workspaceId, agentId, destinationId, skillName: "notify_ops", enabled: true });
    expect(created.boundPayload).toEqual({ channel: "ops" });

    expect((await repository.findById(workspaceId, agentId, created.id))?.id).toBe(created.id);
    expect((await repository.findEnabledByName(workspaceId, agentId, "notify_ops"))?.id).toBe(created.id);
  });

  it("findEnabledByName ignores disabled definitions", async () => {
    await create("disabled_skill", false);
    expect(await repository.findEnabledByName(workspaceId, agentId, "disabled_skill")).toBeNull();
  });

  it("update merges config sub-keys and toggles enabled", async () => {
    const created = await create("merge_me");
    const updated = await repository.update(workspaceId, agentId, created.id, {
      boundPayload: { channel: "alerts" },
      enabled: false,
    });
    expect(updated?.boundPayload).toEqual({ channel: "alerts" });
    // exposedPayload was not in the update → preserved via jsonb merge
    expect(updated?.exposedPayload).toEqual({ message: { type: "string" } });
    expect(updated?.enabled).toBe(false);
  });

  it("lists by agent ordered by name; counts and names by destination; removes", async () => {
    await create("zeta");
    await create("alpha");
    const names = (await repository.listByAgent(workspaceId, agentId)).map((d) => d.skillName);
    expect(names).toEqual(["alpha", "zeta"]);

    expect(await repository.countByDestination(workspaceId, destinationId)).toBe(2);
    expect(await repository.listSkillNamesByDestination(workspaceId, destinationId)).toEqual(["alpha", "zeta"]);

    const target = (await repository.listByAgent(workspaceId, agentId))[0];
    expect(await repository.remove(workspaceId, agentId, target.id)).toBe(true);
    expect(await repository.remove(workspaceId, agentId, target.id)).toBe(false);
  });
});
