import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { PasswordResetTokenRepository } from "../../src/db/repositories/passwordResetTokenRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of PasswordResetTokenRepository. The risky behaviour the
// Kysely migration must preserve: the active filter on findLatestActiveForUser, markUsed
// returning the affected count (1 first call, 0 once already used), and
// markAllActiveUsedForUser returning the count of newly used tokens.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("PasswordResetTokenRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new PasswordResetTokenRepository(database.kysely);

  const userId = randomUUID();
  const now = new Date();
  const future = new Date(now.getTime() + 60 * 60 * 1000);
  const past = new Date(now.getTime() - 60 * 60 * 1000);

  beforeAll(async () => {
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
      userId,
      `prt-${userId}@example.com`,
      "hash",
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("create stores the token", async () => {
    const token = await repository.create({ userId, tokenHash: "prt-hash-1", expiresAt: future });
    expect(token.userId).toBe(userId);
    expect(token.usedAt).toBeNull();
  });

  it("findByTokenHash returns the token and null when unknown", async () => {
    expect((await repository.findByTokenHash("prt-hash-1"))?.userId).toBe(userId);
    expect(await repository.findByTokenHash("nope")).toBeNull();
  });

  it("findLatestActiveForUser returns the newest unused unexpired token", async () => {
    await repository.create({ userId, tokenHash: "prt-hash-2", expiresAt: future });
    const latest = await repository.findLatestActiveForUser(userId, now);
    expect(latest?.tokenHash).toBe("prt-hash-2");
  });

  it("findLatestActiveForUser ignores expired tokens", async () => {
    const expiredUser = randomUUID();
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
      expiredUser,
      `prt-exp-${expiredUser}@example.com`,
      "hash",
    ]);
    await repository.create({ userId: expiredUser, tokenHash: "prt-expired", expiresAt: past });

    expect(await repository.findLatestActiveForUser(expiredUser, now)).toBeNull();
    await database.query(`DELETE FROM users WHERE id = $1`, [expiredUser]);
  });

  it("markUsed returns 1 the first time and 0 afterwards", async () => {
    const token = await repository.findByTokenHash("prt-hash-1");
    expect(await repository.markUsed(token!.id, now)).toBe(1);
    expect(await repository.markUsed(token!.id, now)).toBe(0);

    const used = await repository.findByTokenHash("prt-hash-1");
    expect(used?.usedAt?.getTime()).toBe(now.getTime());
  });

  it("markAllActiveUsedForUser returns the count of newly used tokens", async () => {
    const usedAt = new Date(now.getTime() + 1000);
    // prt-hash-1 already used; only prt-hash-2 remains active
    expect(await repository.markAllActiveUsedForUser(userId, usedAt)).toBe(1);
    expect(await repository.markAllActiveUsedForUser(userId, usedAt)).toBe(0);
    expect(await repository.findLatestActiveForUser(userId, now)).toBeNull();
  });
});
