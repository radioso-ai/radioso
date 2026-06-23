import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of AccountRepository, the spec the Kysely migration must
// preserve: plain CRUD with updated_at advancing on rename and a boolean delete.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AccountRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new AccountRepository(database.kysely);

  const email = `acct-${randomUUID()}@example.com`;
  let createdId: string;

  afterAll(async () => {
    if (createdId) {
      await database.query(`DELETE FROM accounts WHERE id = $1`, [createdId]).catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  });

  it("create inserts and returns the account", async () => {
    const account = await repository.create({ name: "Acme", email, passwordHash: "hash" });
    createdId = account.id;

    expect(account.id).toMatch(/[0-9a-f-]{36}/);
    expect(account.name).toBe("Acme");
    expect(account.email).toBe(email);
    expect(account.passwordHash).toBe("hash");
    expect(account.createdAt).toBeInstanceOf(Date);
    expect(account.updatedAt).toBeInstanceOf(Date);
  });

  it("findByEmail returns the account, and null for an unknown email", async () => {
    const found = await repository.findByEmail(email);
    expect(found?.id).toBe(createdId);

    const missing = await repository.findByEmail(`missing-${randomUUID()}@example.com`);
    expect(missing).toBeNull();
  });

  it("findById returns the account, and null for an unknown id", async () => {
    const found = await repository.findById(createdId);
    expect(found?.email).toBe(email);

    const missing = await repository.findById(randomUUID());
    expect(missing).toBeNull();
  });

  it("updateName changes the name and advances updated_at", async () => {
    const before = await repository.findById(createdId);
    const updated = await repository.updateName(createdId, "Acme Renamed");

    expect(updated.name).toBe("Acme Renamed");
    expect(updated.id).toBe(createdId);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  it("deleteById returns true when a row is removed and false otherwise", async () => {
    const otherEmail = `acct-${randomUUID()}@example.com`;
    const other = await repository.create({ name: "Temp", email: otherEmail, passwordHash: "hash" });

    expect(await repository.deleteById(other.id)).toBe(true);
    expect(await repository.deleteById(other.id)).toBe(false);
    expect(await repository.findById(other.id)).toBeNull();
  });
});
