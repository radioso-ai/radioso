import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AuthFunnelRepository } from "../../src/db/repositories/authFunnelRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AuthFunnelRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new AuthFunnelRepository(database.kysely);
  const userId = randomUUID();
  const accountId = randomUUID();
  const membershipId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Auth Funnel", `auth-funnel-${userId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, `auth-funnel-user-${userId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [membershipId, accountId, userId],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("allows only one concurrent verification claim and session insert", async () => {
    const tokenId = randomUUID();
    const tokenHash = `verify-${randomUUID()}`;
    const now = new Date();
    await database.query(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenId, userId, tokenHash, new Date(now.getTime() + 60_000)],
    );

    const claims = await Promise.all([
      repository.verifyEmailAndCreateSession({
        verificationTokenHash: tokenHash,
        sessionId: randomUUID(),
        sessionTokenHash: `session-${randomUUID()}`,
        sessionExpiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
      repository.verifyEmailAndCreateSession({
        verificationTokenHash: tokenHash,
        sessionId: randomUUID(),
        sessionTokenHash: `session-${randomUUID()}`,
        sessionExpiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
    ]);

    const sessions = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1`,
      [userId],
    );
    expect(claims.map(Boolean).sort()).toEqual([false, true]);
    expect(sessions[0]?.count).toBe("1");
  });

  it("allows only one concurrent pending-ticket exchange", async () => {
    const tokenHash = `pending-${randomUUID()}`;
    const now = new Date();
    await database.query(
      `UPDATE users SET email_verified_at = $2 WHERE id = $1`,
      [userId, now],
    );
    await repository.createPendingTicket({
      id: randomUUID(),
      userId,
      accountId,
      tokenHash,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const sessionsBefore = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1`,
      [userId],
    );

    const exchanges = await Promise.all([
      repository.exchangePendingTicket({
        pendingTokenHash: tokenHash,
        sessionId: randomUUID(),
        sessionTokenHash: `session-${randomUUID()}`,
        sessionExpiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
      repository.exchangePendingTicket({
        pendingTokenHash: tokenHash,
        sessionId: randomUUID(),
        sessionTokenHash: `session-${randomUUID()}`,
        sessionExpiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
    ]);
    const sessionsAfter = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1`,
      [userId],
    );

    expect(exchanges.map(Boolean).sort()).toEqual([false, true]);
    expect(Number(sessionsAfter[0]?.count) - Number(sessionsBefore[0]?.count)).toBe(1);
  });
});
