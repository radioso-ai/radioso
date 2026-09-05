import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import { UserRepository } from "../../src/db/repositories/userRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("UserRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new UserRepository(database.kysely);
  const created: string[] = [];

  const newUser = () => {
    const id = randomUUID();
    created.push(id);
    return { id, email: `user-${id}@example.com`, passwordHash: "hash" };
  };

  afterAll(async () => {
    for (const id of created) {
      await database.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  });

  it("creates and finds by id and email", async () => {
    const u = newUser();
    const user = await repository.create(u);
    expect(user).toMatchObject({ id: u.id, email: u.email, emailVerifiedAt: null });
    expect((await repository.findById(u.id))?.email).toBe(u.email);
    expect((await repository.findByEmail(u.email))?.id).toBe(u.id);
    expect(await repository.findByEmail("missing@example.com")).toBeNull();
  });

  it("updatePassword changes the hash", async () => {
    const u = newUser();
    await repository.create(u);
    const updated = await repository.updatePassword(u.id, "hash-2");
    expect(updated.passwordHash).toBe("hash-2");
  });

  it("markEmailVerified is idempotent (keeps the first timestamp)", async () => {
    const u = newUser();
    await repository.create(u);
    const first = await repository.markEmailVerified(u.id, new Date("2026-01-01T00:00:00.000Z"));
    expect(first.emailVerifiedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    const second = await repository.markEmailVerified(u.id, new Date("2026-02-02T00:00:00.000Z"));
    expect(second.emailVerifiedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("deleteById returns whether a row was removed", async () => {
    const u = newUser();
    await repository.create(u);
    expect(await repository.deleteById(u.id)).toBe(true);
    expect(await repository.deleteById(u.id)).toBe(false);
  });
});
