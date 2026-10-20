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

  it("holds a voice vendor key beside the model provider keys", async () => {
    await repository.upsert({ workspaceId, provider: "elevenlabs", ciphertext: "xi-1" });

    expect((await repository.findByWorkspaceAndProvider(workspaceId, "elevenlabs"))?.ciphertext).toBe("xi-1");
    expect(await repository.remove(workspaceId, "elevenlabs")).toBe(true);
  });

  it("refuses a provider outside the model providers and voice vendors", async () => {
    await expect(database.query(
      `INSERT INTO workspace_provider_credentials (workspace_id, provider, ciphertext) VALUES ($1, 'vapi', 'x')`,
      [workspaceId],
    )).rejects.toThrow(/workspace_provider_credentials_provider_check/);
  });

  it("defaults residency to global and lets an upsert set it on a new row", async () => {
    const defaulted = await repository.upsert({ workspaceId, provider: "openai", ciphertext: "res-1" });
    expect(defaulted.residency).toBe("global");

    await repository.remove(workspaceId, "openai");
    const created = await repository.upsert({ workspaceId, provider: "openai", ciphertext: "res-2", residency: "eu" });
    expect(created.residency).toBe("eu");
    expect((await repository.findByWorkspaceAndProvider(workspaceId, "openai"))?.residency).toBe("eu");
  });

  it("keeps an existing residency when a key replace omits it, and lets an explicit value change it", async () => {
    await repository.upsert({ workspaceId, provider: "openai", ciphertext: "res-3", residency: "us" });

    const replaced = await repository.upsert({ workspaceId, provider: "openai", ciphertext: "res-4" });
    expect(replaced.residency).toBe("us");
    expect(replaced.ciphertext).toBe("res-4");

    const changed = await repository.upsert({ workspaceId, provider: "openai", ciphertext: "res-5", residency: "eu" });
    expect(changed.residency).toBe("eu");
    expect(changed.ciphertext).toBe("res-5");
  });

  it("changes residency alone through updateResidency, leaving the key untouched", async () => {
    await repository.upsert({ workspaceId, provider: "openai", ciphertext: "res-6", residency: "global" });

    const updated = await repository.updateResidency(workspaceId, "openai", "us");
    expect(updated).toMatchObject({ residency: "us", ciphertext: "res-6" });
    expect((await repository.findByWorkspaceAndProvider(workspaceId, "openai"))?.residency).toBe("us");
  });

  it("returns null from updateResidency when no credential is stored for the provider", async () => {
    await repository.remove(workspaceId, "openai");
    expect(await repository.updateResidency(workspaceId, "openai", "eu")).toBeNull();
  });

  it("refuses a residency outside global, us, and eu", async () => {
    await expect(database.query(
      `INSERT INTO workspace_provider_credentials (workspace_id, provider, ciphertext, residency) VALUES ($1, 'claude', 'x', 'in')`,
      [workspaceId],
    )).rejects.toThrow(/workspace_provider_credentials_residency_check/);
  });
});
