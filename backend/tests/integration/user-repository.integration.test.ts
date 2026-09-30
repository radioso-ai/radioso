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

  it("finds several users by id in one read, skipping ids with no user", async () => {
    const named = newUser();
    const unnamed = newUser();
    await repository.create({ ...named, displayName: "Ada Lovelace" });
    await repository.create(unnamed);

    const found = await repository.findByIds([named.id, unnamed.id, randomUUID()]);

    expect(found.map((user) => ({ id: user.id, email: user.email, displayName: user.displayName }))
      .sort((left, right) => left.id.localeCompare(right.id)))
      .toEqual([
        { id: named.id, email: named.email, displayName: "Ada Lovelace" },
        { id: unnamed.id, email: unnamed.email, displayName: null },
      ].sort((left, right) => left.id.localeCompare(right.id)));
    await expect(repository.findByIds([])).resolves.toEqual([]);
    // A malformed id read from stored JSON is skipped, not cast into a failed query.
    await expect(repository.findByIds(["not-a-uuid", named.id])).resolves.toHaveLength(1);
  });

  it("stores a display name on create and leaves it null when none is given", async () => {
    const named = newUser();
    const unnamed = newUser();

    expect((await repository.create({ ...named, displayName: "Ada Lovelace" })).displayName).toBe("Ada Lovelace");
    expect((await repository.create(unnamed)).displayName).toBeNull();
    expect((await repository.findById(named.id))?.displayName).toBe("Ada Lovelace");
  });

  it("updateDisplayName sets and clears the name", async () => {
    const u = newUser();
    await repository.create(u);

    expect((await repository.updateDisplayName(u.id, "山田 太郎")).displayName).toBe("山田 太郎");
    expect((await repository.findByEmail(u.email))?.displayName).toBe("山田 太郎");
    expect((await repository.updateDisplayName(u.id, null)).displayName).toBeNull();
  });

  it("refuses a blank display name at the database", async () => {
    const u = newUser();
    await repository.create(u);

    await expect(repository.updateDisplayName(u.id, "   ")).rejects.toThrow();
    expect((await repository.findById(u.id))?.displayName).toBeNull();
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
