import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { IdentityNonceRepository } from "../../src/db/repositories/identityNonceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("IdentityNonceRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new IdentityNonceRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const now = new Date("2026-11-13T10:00:00.000Z");
  const minutesFromNow = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Nonce Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Nonce Workspace",
      `route-${workspaceId}`,
    ]);
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM context_identity_nonces WHERE workspace_id = $1`, [workspaceId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
    await database.close();
  });

  const remaining = async (): Promise<string[]> => {
    const rows = await database.query<{ nonce: string }>(
      `SELECT nonce FROM context_identity_nonces WHERE workspace_id = $1 ORDER BY nonce`,
      [workspaceId],
    );
    return rows.map((row) => row.nonce);
  };

  it("deletes the nonces whose window has passed and keeps the ones still deciding a replay", async () => {
    await repository.markUsed("expired-1", workspaceId, minutesFromNow(-10));
    await repository.markUsed("expired-2", workspaceId, minutesFromNow(-1));
    await repository.markUsed("expiring-now", workspaceId, now);
    await repository.markUsed("live", workspaceId, minutesFromNow(4));

    await expect(repository.deleteExpired(now, 100)).resolves.toBe(3);

    await expect(remaining()).resolves.toEqual(["live"]);
  });

  it("deletes at most one batch, oldest first, and a second call takes the rest", async () => {
    await repository.markUsed("a-oldest", workspaceId, minutesFromNow(-30));
    await repository.markUsed("b-older", workspaceId, minutesFromNow(-20));
    await repository.markUsed("c-old", workspaceId, minutesFromNow(-10));

    await expect(repository.deleteExpired(now, 2)).resolves.toBe(2);
    await expect(remaining()).resolves.toEqual(["c-old"]);

    await expect(repository.deleteExpired(now, 2)).resolves.toBe(1);
    await expect(remaining()).resolves.toEqual([]);
  });

  it("refuses a batch size that is not a positive whole number", async () => {
    await expect(repository.deleteExpired(now, 0)).rejects.toThrow("positive integer");
    await expect(repository.deleteExpired(now, 1.5)).rejects.toThrow("positive integer");
  });
});
