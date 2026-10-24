import { randomUUID } from "node:crypto";

import { sql } from "kysely";
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
    await database.query(
      `INSERT INTO pending_registration_tickets (id, user_id, account_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), userId, accountId, tokenHash, new Date(now.getTime() + 60_000)],
    );
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

    const [claim, recovery] = await Promise.all([
      repository.verifyEmailAndCreateSession({
        verificationTokenHash: tokenHash,
        sessionId: randomUUID(),
        sessionTokenHash: `session-${randomUUID()}`,
        sessionExpiresAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
      repository.recoverFederatedUser({
        userId: recoveryUserId,
        passwordHash: "recovered-hash",
        displayName: null,
        now,
      }),
    ]);
    const activeSessions = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [recoveryUserId],
    );

    expect(claim === null || claim.userId === recoveryUserId).toBe(true);
    expect(activeSessions[0]?.count).toBe(recovery?.recovered ? "0" : "1");
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
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [ticketUserId, `pending-user-${ticketUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [randomUUID(), ticketAccountId, ticketUserId],
    );
    await database.query(
      `INSERT INTO pending_registration_tickets (id, user_id, account_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), ticketUserId, ticketAccountId, tokenHash, new Date(now.getTime() + 60_000)],
    );
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
      repository.recoverFederatedUser({
        userId: ticketUserId,
        passwordHash: "recovered-hash",
        displayName: null,
        now,
      }),
    ]);
    const activeSessions = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [ticketUserId],
    );

    expect(exchange === null || exchange.userId === ticketUserId).toBe(true);
    expect(activeSessions[0]?.count).toBe("0");
    await database.query(`DELETE FROM accounts WHERE id = $1`, [ticketAccountId]);
  });

  it("rolls back every password-reset mutation when funnel invalidation fails", async () => {
    const resetUserId = randomUUID();
    const resetAccountId = randomUUID();
    const resetTokenHash = `reset-${randomUUID()}`;
    const verificationTokenHash = `reset-verification-${randomUUID()}`;
    const pendingTokenHash = `reset-pending-${randomUUID()}`;
    const now = new Date();
    const triggerSuffix = randomUUID().replaceAll("-", "");
    const triggerName = `fail_funnel_invalidation_${triggerSuffix}`;
    const functionName = `fail_funnel_invalidation_fn_${triggerSuffix}`;
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [resetAccountId, "Atomic reset", `reset-${resetUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [resetUserId, `reset-user-${resetUserId}@example.com`, "old-password-hash"],
    );
    await database.query(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [randomUUID(), resetAccountId, resetUserId],
    );
    await database.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), resetUserId, resetTokenHash, new Date(now.getTime() + 60_000)],
    );
    await database.query(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), resetUserId, verificationTokenHash, new Date(now.getTime() + 60_000)],
    );
    await database.query(
      `INSERT INTO sessions (id, user_id, account_id, session_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), resetUserId, resetAccountId, `reset-session-${randomUUID()}`, new Date(now.getTime() + 60_000)],
    );
    await database.query(
      `INSERT INTO user_federated_identities
         (id, user_id, provider, subject, provider_email, last_authenticated_at)
       VALUES ($1, $2, 'google', $3, $4, $5)`,
      [randomUUID(), resetUserId, `reset-subject-${randomUUID()}`, `reset-${resetUserId}@example.com`, now],
    );
    await database.query(
      `INSERT INTO pending_registration_tickets (id, user_id, account_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), resetUserId, resetAccountId, pendingTokenHash, new Date(now.getTime() + 60_000)],
    );
    await database.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'injected invalidation failure'; END $$`,
    );
    await database.query(
      `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON pending_registration_tickets
       FOR EACH ROW WHEN (OLD.user_id = '${resetUserId}'::uuid) EXECUTE FUNCTION ${functionName}()`,
    );

    await expect(repository.completePasswordReset({
      resetTokenHash,
      passwordHash: "new-password-hash",
      now,
    })).rejects.toThrow("injected invalidation failure");

    const [user] = await database.query<{
      password_hash: string;
      email_verified_at: Date | null;
    }>(`SELECT password_hash, email_verified_at FROM users WHERE id = $1`, [resetUserId]);
    const [resetToken] = await database.query<{ used_at: Date | null }>(
      `SELECT used_at FROM password_reset_tokens WHERE token_hash = $1`, [resetTokenHash],
    );
    const [rollbackState] = await database.query<{
      active_sessions: string;
      active_verification_tokens: string;
      active_pending_tickets: string;
      federated_identities: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM sessions WHERE user_id = $1 AND revoked_at IS NULL) AS active_sessions,
         (SELECT COUNT(*)::text FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL)
           AS active_verification_tokens,
         (SELECT COUNT(*)::text FROM pending_registration_tickets WHERE user_id = $1 AND used_at IS NULL)
           AS active_pending_tickets,
         (SELECT COUNT(*)::text FROM user_federated_identities WHERE user_id = $1) AS federated_identities`,
      [resetUserId],
    );
    expect(user).toMatchObject({ password_hash: "old-password-hash", email_verified_at: null });
    expect(resetToken?.used_at).toBeNull();
    expect(rollbackState).toEqual({
      active_sessions: "1",
      active_verification_tokens: "1",
      active_pending_tickets: "1",
      federated_identities: "1",
    });

    await database.query(`DROP TRIGGER ${triggerName} ON pending_registration_tickets`);
    await database.query(`DROP FUNCTION ${functionName}()`);
    await expect(repository.completePasswordReset({
      resetTokenHash,
      passwordHash: "new-password-hash",
      now: new Date(now.getTime() + 1),
    })).resolves.toMatchObject({ userId: resetUserId });
    await database.query(`DELETE FROM accounts WHERE id = $1`, [resetAccountId]);
  });

  it("creates a registration verification token and pending ticket in one transaction", async () => {
    const challengeUserId = randomUUID();
    const challengeAccountId = randomUUID();
    const now = new Date();
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [challengeAccountId, "Atomic registration", `challenge-${challengeUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [challengeUserId, `challenge-user-${challengeUserId}@example.com`, "hash"],
    );

    await expect(repository.createRegistrationChallenge({
      verificationTokenId: randomUUID(),
      verificationTokenHash: `challenge-verification-${randomUUID()}`,
      verificationExpiresAt: new Date(now.getTime() + 60_000),
      pendingTicketId: randomUUID(),
      pendingTokenHash: `challenge-pending-${randomUUID()}`,
      pendingExpiresAt: new Date(now.getTime() + 60_000),
      userId: challengeUserId,
      accountId: challengeAccountId,
      requestIp: "127.0.0.1",
      requestUserAgent: "integration-test",
    })).resolves.toBe(true);

    const [counts] = await database.query<{ verification_count: string; pending_count: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM email_verification_tokens WHERE user_id = $1) AS verification_count,
         (SELECT COUNT(*)::text FROM pending_registration_tickets WHERE user_id = $1) AS pending_count`,
      [challengeUserId],
    );
    expect(counts).toEqual({ verification_count: "1", pending_count: "1" });
    await database.query(`DELETE FROM accounts WHERE id = $1`, [challengeAccountId]);
  });

  it("treats Google as an ordinary login when link verification wins first", async () => {
    const googleUserId = randomUUID();
    const googleAccountId = randomUUID();
    const now = new Date();
    const tokenHash = `google-order-verify-${randomUUID()}`;
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [googleAccountId, "Google order", `google-order-${googleUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)`,
      [googleUserId, `google-order-user-${googleUserId}@example.com`, "original-hash", "Original"],
    );
    await database.query(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [randomUUID(), googleAccountId, googleUserId],
    );
    await database.query(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), googleUserId, tokenHash, new Date(now.getTime() + 60_000)],
    );
    await repository.verifyEmailAndCreateSession({
      verificationTokenHash: tokenHash,
      sessionId: randomUUID(),
      sessionTokenHash: `session-${randomUUID()}`,
      sessionExpiresAt: new Date(now.getTime() + 3_600_000),
      now,
    });

    await expect(repository.recoverFederatedUser({
      userId: googleUserId,
      passwordHash: "rotated-hash",
      displayName: "Provider",
      now: new Date(now.getTime() + 1),
    })).resolves.toEqual({ recovered: false, displayName: "Original" });
    const [user] = await database.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`, [googleUserId],
    );
    expect(user?.password_hash).toBe("original-hash");
    await database.query(`DELETE FROM accounts WHERE id = $1`, [googleAccountId]);
  });

  it("makes a verification link unusable when Google recovery wins first", async () => {
    const googleUserId = randomUUID();
    const googleAccountId = randomUUID();
    const now = new Date();
    const tokenHash = `google-order-recovery-${randomUUID()}`;
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [googleAccountId, "Google recovery first", `google-recovery-first-${googleUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [googleUserId, `google-recovery-first-user-${googleUserId}@example.com`, "original-hash"],
    );
    await database.query(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [randomUUID(), googleAccountId, googleUserId],
    );
    await database.query(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), googleUserId, tokenHash, new Date(now.getTime() + 60_000)],
    );

    await expect(repository.recoverFederatedUser({
      userId: googleUserId,
      passwordHash: "rotated-hash",
      displayName: "Provider",
      now,
    })).resolves.toEqual({ recovered: true, displayName: "Provider", credentialGeneration: 1 });
    await expect(repository.verifyEmailAndCreateSession({
      verificationTokenHash: tokenHash,
      sessionId: randomUUID(),
      sessionTokenHash: `session-${randomUUID()}`,
      sessionExpiresAt: new Date(now.getTime() + 3_600_000),
      now: new Date(now.getTime() + 1),
    })).resolves.toBeNull();
    await database.query(`DELETE FROM accounts WHERE id = $1`, [googleAccountId]);
  });

  const seedCredentialUser = async (label: string): Promise<{ userId: string; accountId: string }> => {
    const seededUserId = randomUUID();
    const seededAccountId = randomUUID();
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [seededAccountId, label, `${label}-${seededUserId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, NOW())`,
      [seededUserId, `${label}-user-${seededUserId}@example.com`, "old-password-hash"],
    );
    await database.query(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [randomUUID(), seededAccountId, seededUserId],
    );
    return { userId: seededUserId, accountId: seededAccountId };
  };

  const credentialWrites = (input: {
    userId: string;
    accountId: string;
    generation: number;
    subject: string;
  }) => ({
    session: () => repository.createSessionForCredential({
      credential: { userId: input.userId, generation: input.generation },
      accountId: input.accountId,
      sessionId: randomUUID(),
      sessionTokenHash: `session-${randomUUID()}`,
      sessionExpiresAt: new Date(Date.now() + 3_600_000),
    }),
    link: () => repository.linkFederatedIdentityForCredential({
      credential: { userId: input.userId, generation: input.generation },
      provider: "google",
      subject: input.subject,
      providerEmail: `provider-${input.subject}@example.com`,
      authenticatedAt: new Date(),
    }),
  });

  const countCredentialRows = async (seededUserId: string) => {
    const [counts] = await database.query<{ sessions: string; links: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM sessions WHERE user_id = $1 AND revoked_at IS NULL) AS sessions,
         (SELECT COUNT(*)::text FROM user_federated_identities WHERE user_id = $1) AS links`,
      [seededUserId],
    );
    return counts;
  };

  /** Resolves once a statement inserting into `table` is waiting on the given backend's locks. */
  const waitForInsertBlockedBy = async (
    blockerPid: number,
    table: "sessions" | "user_federated_identities",
  ): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [row] = await database.query<{ waiting: number }>(
        `SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
         WHERE pg_blocking_pids(pid) @> ARRAY[$1::int] AND query LIKE $2`,
        [blockerPid, `insert into "${table}"%`],
      );
      if ((row?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No insert into ${table} waited on backend ${blockerPid} within 10s`);
  };

  it("advances the credential generation on password reset and writes nothing at the generation it replaced", async () => {
    const { userId: resetUserId, accountId: resetAccountId } = await seedCredentialUser("generation-reset");
    const resetTokenHash = `generation-reset-${randomUUID()}`;
    await database.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), resetUserId, resetTokenHash, new Date(Date.now() + 60_000)],
    );
    const subject = `generation-reset-${randomUUID()}`;

    await expect(repository.completePasswordReset({
      resetTokenHash,
      passwordHash: "new-password-hash",
      now: new Date(),
    })).resolves.toMatchObject({ userId: resetUserId, credentialGeneration: 1 });

    const replaced = credentialWrites({ userId: resetUserId, accountId: resetAccountId, generation: 0, subject });
    await expect(replaced.session()).resolves.toBe(false);
    await expect(replaced.link()).resolves.toBe(false);
    expect(await countCredentialRows(resetUserId)).toEqual({ sessions: "0", links: "0" });

    const current = credentialWrites({ userId: resetUserId, accountId: resetAccountId, generation: 1, subject });
    await expect(current.session()).resolves.toBe(true);
    await expect(current.link()).resolves.toBe(true);
    // A repeat sign-in refreshes the link it already holds rather than adding a row.
    await expect(current.link()).resolves.toBe(true);
    expect(await countCredentialRows(resetUserId)).toEqual({ sessions: "1", links: "1" });
    await database.query(`DELETE FROM accounts WHERE id = $1`, [resetAccountId]);
  });

  it("makes session and link writes queued behind an in-flight reset write nothing once it commits", async () => {
    const { userId: racedUserId, accountId: racedAccountId } = await seedCredentialUser("generation-race");
    const writes = credentialWrites({
      userId: racedUserId,
      accountId: racedAccountId,
      generation: 0,
      subject: `generation-race-${randomUUID()}`,
    });
    let queued: Promise<[boolean, boolean]> | null = null;

    // Stands in for a password reset that has locked the user, advanced the generation and
    // revoked sessions and links, but not committed: the writes must wait for it, then see it.
    await database.kysely.transaction().execute(async (transaction) => {
      const { rows: [backend] } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(transaction);
      if (!backend) throw new Error("The reset transaction has no backend pid");
      await transaction.selectFrom("users").select("id").where("id", "=", racedUserId).forUpdate().execute();
      await transaction.updateTable("users")
        .set((expression) => ({ credential_generation: expression("credential_generation", "+", 1) }))
        .where("id", "=", racedUserId)
        .execute();
      await transaction.updateTable("sessions").set({ revoked_at: new Date() })
        .where("user_id", "=", racedUserId)
        .execute();
      await transaction.deleteFrom("user_federated_identities").where("user_id", "=", racedUserId).execute();
      const session = writes.session();
      await waitForInsertBlockedBy(backend.pid, "sessions");
      const link = writes.link();
      await waitForInsertBlockedBy(backend.pid, "user_federated_identities");
      queued = Promise.all([session, link]);
    });

    await expect(queued).resolves.toEqual([false, false]);
    expect(await countCredentialRows(racedUserId)).toEqual({ sessions: "0", links: "0" });
    await database.query(`DELETE FROM accounts WHERE id = $1`, [racedAccountId]);
  });
});
