import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AuthFunnelRepository } from "../../src/db/repositories/authFunnelRepository.js";
import { EmailVerificationTokenRepository } from "../../src/db/repositories/emailVerificationTokenRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AuthFunnelRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new AuthFunnelRepository(database.kysely);
  const emailVerificationTokens = new EmailVerificationTokenRepository(database.kysely);
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
    await database.query(
      `UPDATE pending_registration_tickets SET activated_at = $2 WHERE token_hash = $1`,
      [tokenHash, now],
    );
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

  it("does not create a session when recovery consumes an outstanding verification link", async () => {
    const recoveryUserId = randomUUID();
    const recoveryAccountId = randomUUID();
    const now = new Date();
    const tokenHash = `recovery-verify-${randomUUID()}`;
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [recoveryAccountId, "Recovery", `recovery-${recoveryUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [recoveryUserId, `recovery-user-${recoveryUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [randomUUID(), recoveryAccountId, recoveryUserId],
    );
    await database.query(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), recoveryUserId, tokenHash, new Date(now.getTime() + 60_000)],
    );

    const [claim] = await Promise.all([
      repository.verifyEmailAndCreateSession({
        verificationTokenHash: tokenHash,
        sessionId: randomUUID(),
        sessionTokenHash: `session-${randomUUID()}`,
        sessionExpiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
      repository.revokePendingRegistrationCredentials({ userId: recoveryUserId, now }),
    ]);
    const activeSessions = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [recoveryUserId],
    );

    expect(claim === null || claim.userId === recoveryUserId).toBe(true);
    expect(activeSessions[0]?.count).toBe("0");
    await database.query(`DELETE FROM accounts WHERE id = $1`, [recoveryAccountId]);
  });

  it("does not let a resend race mint a session from the superseded link", async () => {
    const resendUserId = randomUUID();
    const resendAccountId = randomUUID();
    const now = new Date();
    const originalTokenHash = `resend-original-${randomUUID()}`;
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [resendAccountId, "Resend", `resend-${resendUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [resendUserId, `resend-user-${resendUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [randomUUID(), resendAccountId, resendUserId],
    );
    await database.query(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), resendUserId, originalTokenHash, new Date(now.getTime() + 60_000)],
    );

    const [claim, resent] = await Promise.all([
      repository.verifyEmailAndCreateSession({
        verificationTokenHash: originalTokenHash,
        sessionId: randomUUID(),
        sessionTokenHash: `session-${randomUUID()}`,
        sessionExpiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
      emailVerificationTokens.createIfUnverified({
        userId: resendUserId,
        tokenHash: `resend-new-${randomUUID()}`,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
    ]);

    expect(Boolean(claim) && Boolean(resent)).toBe(false);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [resendAccountId]);
  });

  it("keeps a pending ticket unusable when recovery races its exchange", async () => {
    const ticketUserId = randomUUID();
    const ticketAccountId = randomUUID();
    const now = new Date();
    const tokenHash = `recovery-pending-${randomUUID()}`;
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [ticketAccountId, "Pending recovery", `pending-${ticketUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, $4)`,
      [ticketUserId, `pending-user-${ticketUserId}@example.com`, "hash", now],
    );
    await database.query(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [randomUUID(), ticketAccountId, ticketUserId],
    );
    await repository.createPendingTicket({
      id: randomUUID(),
      userId: ticketUserId,
      accountId: ticketAccountId,
      tokenHash,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await database.query(
      `UPDATE pending_registration_tickets SET activated_at = $2 WHERE token_hash = $1`,
      [tokenHash, now],
    );

    const [exchange] = await Promise.all([
      repository.exchangePendingTicket({
        pendingTokenHash: tokenHash,
        sessionId: randomUUID(),
        sessionTokenHash: `session-${randomUUID()}`,
        sessionExpiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
      repository.revokePendingRegistrationCredentials({ userId: ticketUserId, now }),
    ]);
    const activeSessions = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [ticketUserId],
    );

    expect(exchange === null || exchange.userId === ticketUserId).toBe(true);
    expect(activeSessions[0]?.count).toBe("0");
    await database.query(`DELETE FROM accounts WHERE id = $1`, [ticketAccountId]);
  });
});
