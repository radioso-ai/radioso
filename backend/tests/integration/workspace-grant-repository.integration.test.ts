import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { WorkspaceGrantRepository } from "../../src/db/repositories/workspaceGrantRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("WorkspaceGrantRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new WorkspaceGrantRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Grant Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Grant Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)`, [
      userId,
      `user-${userId}@example.com`,
      "hash",
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("upsert derives account_id from the workspace and updates role on conflict", async () => {
    const created = await repository.upsert({ workspaceId, accountId, userId, role: "member" });
    expect(created).toMatchObject({ workspaceId, accountId, userId, role: "member" });

    const updated = await repository.upsert({ workspaceId, accountId, userId, role: "admin" });
    expect(updated.id).toBe(created.id);
    expect(updated.role).toBe("admin");
  });

  it("upsert throws notFound when the workspace is not owned by the account", async () => {
    await expect(
      repository.upsert({ workspaceId, accountId: randomUUID(), userId, role: "member" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("finds, lists by account and workspace", async () => {
    expect((await repository.findByWorkspaceAndUser(workspaceId, userId))?.role).toBe("admin");
    expect(await repository.findByWorkspaceAndUser(workspaceId, randomUUID())).toBeNull();
    expect(await repository.listByAccount(accountId)).toHaveLength(1);
    expect(await repository.listByWorkspace(workspaceId)).toHaveLength(1);
  });

  it("deletes by account+user (count) and by workspace+account+user (bool)", async () => {
    expect(await repository.deleteByWorkspaceAndUser(workspaceId, accountId, userId)).toBe(true);
    expect(await repository.deleteByWorkspaceAndUser(workspaceId, accountId, userId)).toBe(false);

    await repository.upsert({ workspaceId, accountId, userId, role: "member" });
    expect(await repository.deleteByAccountAndUser(accountId, userId)).toBe(1);
    expect(await repository.deleteByAccountAndUser(accountId, userId)).toBe(0);
  });
});
