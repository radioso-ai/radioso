import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EmailVerificationTokenRepository } from "../../src/db/repositories/emailVerificationTokenRepository.js";
import { Database } from "../../src/shared/infra/database.js";

// Real-Postgres characterization of EmailVerificationTokenRepository. The risky behaviour
// the Kysely migration must preserve: the active filter (used_at IS NULL AND expires_at >
// now) on findLatestActiveForUser, the idempotent markUsed (no-op once stamped, void
// return), and markAllActiveUsedForUser returning the affected count.

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) {
    return false;
  }
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

describeIfDatabase("EmailVerificationTokenRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new EmailVerificationTokenRepository(database.kysely);

  const userId = randomUUID();
  const now = new Date();
  const future = new Date(now.getTime() + 60 * 60 * 1000);
  const past = new Date(now.getTime() - 60 * 60 * 1000);

  beforeAll(async () => {
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
      userId,
      `evt-${userId}@example.com`,
      "hash",
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("create stores the token and optional request metadata", async () => {
    const token = await repository.create({
      userId,
      tokenHash: "evt-hash-1",
      expiresAt: future,
      requestIp: "127.0.0.1",
      requestUserAgent: "vitest",
    });

    expect(token.userId).toBe(userId);
    expect(token.tokenHash).toBe("evt-hash-1");
    expect(token.usedAt).toBeNull();
    expect(token.expiresAt).toBeInstanceOf(Date);
  });

  it("findByTokenHash returns the token and null when unknown", async () => {
    expect((await repository.findByTokenHash("evt-hash-1"))?.userId).toBe(userId);
    expect(await repository.findByTokenHash("nope")).toBeNull();
  });

  it("findLatestActiveForUser returns the newest unused unexpired token", async () => {
    await repository.create({ userId, tokenHash: "evt-hash-2", expiresAt: future });

    const latest = await repository.findLatestActiveForUser(userId, now);
    expect(latest?.tokenHash).toBe("evt-hash-2");
  });

  it("findLatestActiveForUser ignores expired tokens", async () => {
    const expiredUser = randomUUID();
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
      expiredUser,
      `evt-exp-${expiredUser}@example.com`,
      "hash",
    ]);
    await repository.create({ userId: expiredUser, tokenHash: "evt-expired", expiresAt: past });

    expect(await repository.findLatestActiveForUser(expiredUser, now)).toBeNull();
    await database.query(`DELETE FROM users WHERE id = $1`, [expiredUser]);
  });

  it("markUsed stamps used_at once and is idempotent", async () => {
    const token = await repository.findByTokenHash("evt-hash-1");
    await repository.markUsed(token!.id, now);

    const used = await repository.findByTokenHash("evt-hash-1");
    expect(used?.usedAt?.getTime()).toBe(now.getTime());

    // second call must not change the stored value
    await repository.markUsed(token!.id, new Date(now.getTime() + 5000));
    const again = await repository.findByTokenHash("evt-hash-1");
    expect(again?.usedAt?.getTime()).toBe(now.getTime());
  });

  it("markAllActiveUsedForUser returns the number of newly used tokens", async () => {
    const usedAt = new Date(now.getTime() + 1000);
    const count = await repository.markAllActiveUsedForUser(userId, usedAt);

    // only evt-hash-2 remained active (evt-hash-1 already used)
    expect(count).toBe(1);
    expect(await repository.findLatestActiveForUser(userId, now)).toBeNull();

    // calling again finds nothing active → 0
    expect(await repository.markAllActiveUsedForUser(userId, usedAt)).toBe(0);
  });
});
