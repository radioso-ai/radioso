import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { WorkspaceProviderCredentialsRepository } from "../../src/db/repositories/workspaceProviderCredentialsRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("WorkspaceProviderCredentialsRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new WorkspaceProviderCredentialsRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Cred Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Cred Workspace",
      `route-${workspaceId}`,
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("upsert inserts then updates ciphertext on conflict (workspace_id, provider)", async () => {
    const created = await repository.upsert({ workspaceId, provider: "openai", ciphertext: "enc-1" });
    expect(created).toMatchObject({ workspaceId, provider: "openai", ciphertext: "enc-1" });

    const updated = await repository.upsert({ workspaceId, provider: "openai", ciphertext: "enc-2" });
    expect(updated.ciphertext).toBe("enc-2");
    expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it("finds by workspace+provider and returns null when absent", async () => {
    await repository.upsert({ workspaceId, provider: "gemini", ciphertext: "g-1" });
    expect((await repository.findByWorkspaceAndProvider(workspaceId, "gemini"))?.ciphertext).toBe("g-1");
    expect(await repository.findByWorkspaceAndProvider(workspaceId, "claude")).toBeNull();
  });

  it("lists summaries ordered by provider and removes", async () => {
    const summaries = await repository.listByWorkspace(workspaceId);
    const providers = summaries.map((s) => s.provider);
    expect(providers).toEqual([...providers].sort());
    expect(summaries.some((s) => "ciphertext" in s)).toBe(false);

    expect(await repository.remove(workspaceId, "openai")).toBe(true);
    expect(await repository.remove(workspaceId, "openai")).toBe(false);
    expect(await repository.findByWorkspaceAndProvider(workspaceId, "openai")).toBeNull();
  });
});
