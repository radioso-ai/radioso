import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WebhookDestinationRepository } from "../../src/db/repositories/webhookDestinationRepository.js";
import { Database } from "../../src/shared/infra/database.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = (await canReach(integrationDatabaseUrl)) ? describe : describe.skip;

describeIfDatabase("WebhookDestinationRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new WebhookDestinationRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Webhook Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Webhook Workspace",
      `route-${workspaceId}`,
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const create = (name: string) =>
    repository.create({ workspaceId, name, url: "https://hooks.example.com", secretCiphertext: "enc", encryptionKeyId: "key-1" });

  it("creates, finds (workspace-scoped), and returns null for a non-uuid id", async () => {
    const created = await create("Hook A");
    expect(created).toMatchObject({ workspaceId, name: "Hook A", lastDeliveryStatus: null });
    expect((await repository.findByIdAndWorkspace(created.id, workspaceId))?.id).toBe(created.id);
    expect(await repository.findByIdAndWorkspace(created.id, randomUUID())).toBeNull();
    expect(await repository.findByIdAndWorkspace("not-a-uuid", workspaceId)).toBeNull();
  });

  it("lists ordered case-insensitively by name", async () => {
    await create("zebra");
    await create("Apple");
    const names = (await repository.listByWorkspace(workspaceId)).map((d) => d.name);
    expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });

  it("updates fields, secret, delivery outcome, and deletes", async () => {
    const created = await create("To Update");
    expect((await repository.update(created.id, workspaceId, { name: "Updated", url: "https://x.example.com" }))?.name).toBe("Updated");
    expect((await repository.updateSecret(created.id, workspaceId, { secretCiphertext: "enc-2", encryptionKeyId: "key-2" }))?.secretCiphertext).toBe("enc-2");

    await repository.recordDeliveryOutcome(created.id, workspaceId, "success");
    expect((await repository.findByIdAndWorkspace(created.id, workspaceId))?.lastDeliveryStatus).toBe("success");

    expect(await repository.delete(created.id, workspaceId)).toBe(true);
    expect(await repository.delete(created.id, workspaceId)).toBe(false);
    expect(await repository.delete("not-a-uuid", workspaceId)).toBe(false);
  });
});
