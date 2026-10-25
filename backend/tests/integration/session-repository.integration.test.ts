import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AuthFunnelRepository } from "../../src/db/repositories/authFunnelRepository.js";
import { SessionRepository } from "../../src/db/repositories/sessionRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of the SessionRepository. The auth "integration" test
// uses an in-memory fake, so this is the only coverage that exercises the actual SQL
// (now Kysely). Behaviour here is the spec the Kysely migration must preserve.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("SessionRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new SessionRepository(database.kysely);
  // Sessions are written only through the credential-guarded writer.
  const writer = new AuthFunnelRepository(database.kysely);

  const accountId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Session Test Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, `user-${userId}@example.com`, "hash"],
    );
  });

  afterAll(async () => {
    // ON DELETE CASCADE removes the sessions created during the test.
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const currentGeneration = async (): Promise<number> => {
    const [user] = await database.query<{ credential_generation: number }>(
      `SELECT credential_generation FROM users WHERE id = $1`,
      [userId],
    );
    return user?.credential_generation ?? -1;
  };

  const createSession = async (overrides: { expiresAt?: Date } = {}) => {
    const session = { id: randomUUID(), sessionTokenHash: `hash-${randomUUID()}` };
    const written = await writer.createSessionForCredential({
      credential: { userId, generation: await currentGeneration() },
      accountId,
      sessionId: session.id,
      sessionTokenHash: session.sessionTokenHash,
      sessionExpiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(written).toBe(true);
    return session;
  };

  it("reads a live session's full record with the credential generation its user holds", async () => {
    const created = await createSession();
    await database.query(`UPDATE users SET credential_generation = 4 WHERE id = $1`, [userId]);

    const found = await repository.findActiveByTokenHash(created.sessionTokenHash, new Date());

    expect(found).toMatchObject({
      id: created.id,
      userId,
      accountId,
      revokedAt: null,
      userCredentialGeneration: 4,
    });
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.lastSeenAt).toBeInstanceOf(Date);
  });

  it("finds an active session by token hash", async () => {
    const created = await createSession();

    const found = await repository.findActiveByTokenHash(created.sessionTokenHash, new Date());

    expect(found?.id).toBe(created.id);
  });

  it("does not return an expired session", async () => {
    const expired = await createSession({ expiresAt: new Date(Date.now() - 1000) });

    const found = await repository.findActiveByTokenHash(expired.sessionTokenHash, new Date());

    expect(found).toBeNull();
  });

  it("does not return a revoked session", async () => {
    const created = await createSession();

    await repository.revokeAllForUser(userId, new Date());

    const found = await repository.findActiveByTokenHash(created.sessionTokenHash, new Date());
    expect(found).toBeNull();
  });

  it("touch updates last_seen_at", async () => {
    const created = await createSession();
    const later = new Date(Date.now() + 5 * 60 * 1000);

    await repository.touch(created.id, later);

    const found = await repository.findActiveByTokenHash(created.sessionTokenHash, new Date());
    expect(found?.lastSeenAt.getTime()).toBe(later.getTime());
  });

  it("revokeAllForUser returns the number of sessions revoked and is idempotent", async () => {
    await createSession();
    await createSession();

    const firstRevoke = await repository.revokeAllForUser(userId, new Date());
    expect(firstRevoke).toBeGreaterThanOrEqual(2);

    const secondRevoke = await repository.revokeAllForUser(userId, new Date());
    expect(secondRevoke).toBe(0);
  });
});
