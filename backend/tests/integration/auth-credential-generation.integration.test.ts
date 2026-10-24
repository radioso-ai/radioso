import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import { AccountMembershipRepository } from "../../src/db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AuthFunnelRepository } from "../../src/db/repositories/authFunnelRepository.js";
import { PasswordResetTokenRepository } from "../../src/db/repositories/passwordResetTokenRepository.js";
import { SessionRepository } from "../../src/db/repositories/sessionRepository.js";
import { UserFederatedIdentityRepository } from "../../src/db/repositories/userFederatedIdentityRepository.js";
import { UserRepository } from "../../src/db/repositories/userRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AccountAccessService, AccountInvitationService } from "../../src/modules/account/public.js";
import { hashPassword, sha256 } from "../../src/modules/auth/domain/authPrimitives.js";
import { PostgresOrganizationProvisioner } from "../../src/modules/auth/infra/postgresOrganizationProvisioner.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import { PasswordResetService } from "../../src/modules/auth/services/passwordResetService.js";
import { WorkspaceService } from "../../src/modules/workspace/public.js";
import { Database } from "../../src/shared/infra/database.js";
import {
  createAuditService,
  InMemoryAccountInvitationRepository,
  RecordingAccountInvitationNotifier,
} from "../support/fakes.js";
import { createTestEnv } from "../support/testApp.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/** Holds a sign-in at one step until the test lets it continue. */
const createGate = () => {
  let arrive: () => void = () => undefined;
  let release: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    arrived,
    release: () => release(),
    pass: async (): Promise<void> => {
      arrive();
      await released;
    },
  };
};

/** Settles a sign-in into its outcome, so the test can release it before asserting. */
const settle = <T>(attempt: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  attempt.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

describeIntegration("credential generation (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const env = createTestEnv();
  const accountIds = new Set<string>();
  const userIds = new Set<string>();

  afterAll(async () => {
    for (const accountId of accountIds) {
      await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    }
    for (const userId of userIds) {
      await database.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  });

  const createServices = () => {
    const auditService = createAuditService();
    const accountRepository = new AccountRepository(database.kysely);
    const userRepository = new UserRepository(database.kysely);
    const accountAccessService = new AccountAccessService(
      new AccountMembershipRepository(database.kysely),
      auditService,
    );
    const workspaceService = new WorkspaceService(new WorkspaceRepository(database.kysely), auditService);
    const sessionRepository = new SessionRepository(database.kysely);
    const authFunnelRepository = new AuthFunnelRepository(database.kysely);
    const authService = new AuthService({
      env,
      auditService,
      accountRepository,
      userRepository,
      sessionRepository,
      federatedIdentityRepository: new UserFederatedIdentityRepository(database.kysely),
      authFunnelRepository,
      workspaceService,
      accountAccessService,
      accountInvitationService: new AccountInvitationService(
        new InMemoryAccountInvitationRepository(),
        userRepository,
        accountAccessService,
        auditService,
        new RecordingAccountInvitationNotifier(),
      ),
      organizationProvisioner: new PostgresOrganizationProvisioner(database, auditService),
    });
    // The reset runs on its own service graph, so a gate placed on the sign-in's
    // dependencies never holds the reset.
    const passwordResetService = new PasswordResetService({
      env,
      auditService,
      accountRepository: new AccountRepository(database.kysely),
      userRepository: new UserRepository(database.kysely),
      accountAccessService: new AccountAccessService(new AccountMembershipRepository(database.kysely), auditService),
      workspaceService: new WorkspaceService(new WorkspaceRepository(database.kysely), auditService),
      authFunnelRepository: new AuthFunnelRepository(database.kysely),
      passwordResetTokenRepository: new PasswordResetTokenRepository(database.kysely),
      mailService: {} as never,
      responsePaddingMs: 0,
    });
    return { authService, passwordResetService, accountAccessService, userRepository, auditService };
  };

  const provisionUser = async (label: string): Promise<{ userId: string; accountId: string; email: string }> => {
    const email = `${label}-${randomUUID()}@example.com`;
    const provisioned = await new PostgresOrganizationProvisioner(database, createAuditService()).provision({
      intent: "new_user",
      organizationName: label,
      email,
      passwordHash: await hashPassword("theoldpassword"),
      emailVerifiedAt: new Date(),
    });
    accountIds.add(provisioned.account.id);
    userIds.add(provisioned.userId);
    return { userId: provisioned.userId, accountId: provisioned.account.id, email };
  };

  const issueResetToken = async (userId: string): Promise<string> => {
    const token = `reset-${randomUUID()}`;
    await database.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), userId, sha256(token), new Date(Date.now() + 60_000)],
    );
    return token;
  };

  const sessionHashFromCookie = (cookie: string): string => sha256(cookie.split(";")[0]?.split("=")[1] ?? "");

  const credentialState = async (userId: string) => {
    const sessions = await database.query<{ session_token_hash: string; revoked: boolean }>(
      `SELECT session_token_hash, revoked_at IS NOT NULL AS revoked FROM sessions WHERE user_id = $1`,
      [userId],
    );
    const links = await database.query<{ subject: string }>(
      `SELECT subject FROM user_federated_identities WHERE user_id = $1`,
      [userId],
    );
    return { sessions, links };
  };

  it("leaves no session from a password login that a reset overtook after the password check", async () => {
    const { authService, passwordResetService, accountAccessService } = createServices();
    const { userId, email } = await provisionUser("raced-login");
    const resetToken = await issueResetToken(userId);
    // The membership lookup runs after the password is verified and before the session write.
    const gate = createGate();
    const resolveLoginAccount = accountAccessService.resolveLoginAccount.bind(accountAccessService);
    accountAccessService.resolveLoginAccount = async (...args) => {
      const membership = await resolveLoginAccount(...args);
      await gate.pass();
      return membership;
    };

    const login = settle(authService.login({ email, password: "theoldpassword" }));
    await gate.arrived;
    const reset = await passwordResetService.confirmReset({ token: resetToken, password: "thenewpassword" });
    gate.release();
    const outcome = await login;

    expect(outcome).toMatchObject({ ok: false, error: { statusCode: 401, message: "Invalid email or password" } });
    // The only session is the one the reset issued for itself.
    expect(await credentialState(userId)).toEqual({
      sessions: [{ session_token_hash: sessionHashFromCookie(reset.sessionCookie), revoked: false }],
      links: [],
    });
  });

  it("leaves no session or re-inserted link from a Google sign-in that a reset overtook after the link lookup", async () => {
    const { authService, passwordResetService, userRepository } = createServices();
    const { userId } = await provisionUser("raced-google");
    const subject = `google-${randomUUID()}`;
    await database.query(
      `INSERT INTO user_federated_identities (id, user_id, provider, subject, provider_email, last_authenticated_at)
       VALUES ($1, $2, 'google', $3, $4, NOW())`,
      [randomUUID(), userId, subject, `provider-${subject}@example.com`],
    );
    const resetToken = await issueResetToken(userId);
    const gate = createGate();
    const findByFederatedIdentity = userRepository.findByFederatedIdentity.bind(userRepository);
    userRepository.findByFederatedIdentity = async (...args) => {
      const user = await findByFederatedIdentity(...args);
      await gate.pass();
      return user;
    };

    const signIn = settle(authService.federatedLogin({
      provider: "google",
      subject,
      email: `provider-${subject}@example.com`,
      emailVerified: true,
    }));
    await gate.arrived;
    const reset = await passwordResetService.confirmReset({ token: resetToken, password: "thenewpassword" });
    gate.release();
    const outcome = await signIn;

    expect(reset).toMatchObject({ userId });
    expect(outcome).toMatchObject({ ok: false, error: { statusCode: 401 } });
    expect(await credentialState(userId)).toEqual({
      sessions: [{ session_token_hash: sessionHashFromCookie(reset.sessionCookie), revoked: false }],
      links: [],
    });
  });

  it("signs ordinary password and Google sign-ins in with one session each", async () => {
    const { authService } = createServices();
    const { userId, email } = await provisionUser("ordinary-sign-in");
    const subject = `google-${randomUUID()}`;

    const login = await authService.login({ email, password: "theoldpassword" });
    const linked = await authService.federatedLogin({ provider: "google", subject, email, emailVerified: true });
    const relinked = await authService.federatedLogin({
      provider: "google",
      subject,
      email: `changed-${email}`,
      emailVerified: true,
    });

    expect([login.userId, linked.userId, relinked.userId]).toEqual([userId, userId, userId]);
    const state = await credentialState(userId);
    expect(state.links).toEqual([{ subject }]);
    expect(new Set(state.sessions.map((session) => session.session_token_hash))).toEqual(new Set([
      sessionHashFromCookie(login.sessionCookie),
      sessionHashFromCookie(linked.sessionCookie),
      sessionHashFromCookie(relinked.sessionCookie),
    ]));
    expect(state.sessions.every((session) => !session.revoked)).toBe(true);
  });
});
