import { describe, expect, expectTypeOf, it } from "vitest";

import { createTestEnv } from "../support/testApp.js";
import {
  createAuditService,
  InMemoryAccountInvitationRepository,
  InMemoryAccountMembershipRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  InMemoryWorkspaceTokenRepository,
} from "../support/fakes.js";
import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import { AccountInvitationService } from "../../src/modules/account/services/accountInvitationService.js";
import {
  AuthService,
  type AccountRecord,
  type AccountRepositoryPort,
  type SessionRepositoryPort,
} from "../../src/modules/auth/services/authService.js";
import { sha256 } from "../../src/modules/auth/domain/authPrimitives.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import type {
  OrganizationCoreProvisioner,
  OrganizationCreationGuard,
  OrganizationCreationRequest,
  OrganizationCreationReservation,
} from "../../src/shared/domain/organizationCreationGuard.js";
import { InMemoryOrganizationProvisioner } from "../support/organizationProvisioner.js";

it("does not expose an ambiguous account lookup by email", () => {
  expectTypeOf<AccountRepositoryPort>().not.toHaveProperty("findByEmail");
});

class TrackingAccountRepository implements AccountRepositoryPort {
  readonly items = new Map<string, AccountRecord>();
  readonly deletedIds: string[] = [];

  async create(params: { name: string; email: string; passwordHash: string }): Promise<AccountRecord> {
    const record: AccountRecord = {
      id: `account-${this.items.size + 1}`,
      name: params.name,
      email: params.email,
      passwordHash: params.passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AccountRecord | null> {
    return this.items.get(id) ?? null;
  }

  async updateName(id: string, name: string): Promise<AccountRecord> {
    const account = this.items.get(id);
    if (!account) {
      throw new Error(`Account ${id} not found`);
    }
    const updated = { ...account, name, updatedAt: new Date() };
    this.items.set(id, updated);
    return updated;
  }

  async deleteById(id: string): Promise<boolean> {
    this.deletedIds.push(id);
    return this.items.delete(id);
  }
}

class FailingAccountRepository extends TrackingAccountRepository {
  override async create(): Promise<never> {
    throw new Error("account create failed");
  }
}

class FailingSessionRepository implements SessionRepositoryPort {
  async create(_params: {
    userId: string;
    accountId: string;
    sessionTokenHash: string;
    expiresAt: Date;
  }): Promise<never> {
    throw new Error("session create failed");
  }

  async findActiveByTokenHash(_sessionTokenHash: string, _now: Date): Promise<null> {
    return null;
  }

  async touch(_sessionId: string, _lastSeenAt: Date): Promise<void> {}

  async revokeAllForUser(_userId: string, _revokedAt: Date): Promise<number> {
    return 0;
  }
}

class WorkingSessionRepository implements SessionRepositoryPort {
  async create(_params: {
    userId: string;
    accountId: string;
    sessionTokenHash: string;
    expiresAt: Date;
  }): Promise<{
    id: string;
    userId: string;
    accountId: string;
    sessionTokenHash: string;
    createdAt: Date;
    expiresAt: Date;
    lastSeenAt: Date;
    revokedAt: Date | null;
  }> {
    return {
      id: `${_params.accountId}-session`,
      userId: _params.userId,
      accountId: _params.accountId,
      sessionTokenHash: _params.sessionTokenHash,
      createdAt: new Date(),
      expiresAt: _params.expiresAt,
      lastSeenAt: new Date(),
      revokedAt: null,
    };
  }

  async findActiveByTokenHash(): Promise<null> {
    return null;
  }

  async touch(_sessionId: string, _lastSeenAt: Date): Promise<void> {}

  async revokeAllForUser(_userId: string, _revokedAt: Date): Promise<number> {
    return 0;
  }
}

class RecordingOrganizationCreationGuard implements OrganizationCreationGuard {
  readonly reservations: RecordingOrganizationCreationReservation[] = [];
  readonly requests: OrganizationCreationRequest[] = [];
  shouldReject: unknown = null;

  async reserve(input: OrganizationCreationRequest): Promise<OrganizationCreationReservation> {
    this.requests.push(input);
    if (this.shouldReject) {
      throw this.shouldReject;
    }
    const reservation = new RecordingOrganizationCreationReservation();
    this.reservations.push(reservation);
    return reservation;
  }

  async isSignupAvailable(): Promise<boolean> {
    return !this.shouldReject;
  }
}

class RecordingOrganizationCreationReservation implements OrganizationCreationReservation {
  committed = false;
  released = false;
  accountId: string | null = null;

  async commit(input: { accountId: string }): Promise<void> {
    this.committed = true;
    this.accountId = input.accountId;
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

const createAuthService = (options: {
  accountRepository?: AccountRepositoryPort;
  userRepository?: InMemoryUserRepository;
  sessionRepository?: SessionRepositoryPort;
  workspaceService?: WorkspaceService;
  accountInvitationRepository?: InMemoryAccountInvitationRepository;
  onAccountCreated?: (input: { accountId: string }) => Promise<void>;
  organizationCreationGuard?: OrganizationCreationGuard;
  organizationProvisioner?: OrganizationCoreProvisioner;
}) => {
  const env = createTestEnv();
  const auditService = createAuditService();
  const accountRepository = options.accountRepository ?? new TrackingAccountRepository();
  const userRepository = options.userRepository ?? new InMemoryUserRepository();
  const accountMembershipRepository = new InMemoryAccountMembershipRepository();
  accountMembershipRepository.setUserRepository(userRepository);
  const accountAccessService = new AccountAccessService(accountMembershipRepository, auditService);
  const accountInvitationRepository = options.accountInvitationRepository ?? new InMemoryAccountInvitationRepository();
  const accountInvitationService = new AccountInvitationService(
    accountInvitationRepository,
    userRepository,
    accountAccessService,
    auditService,
  );
  const workspaceService = options.workspaceService ?? new WorkspaceService(new InMemoryWorkspaceRepository(), auditService);

  return {
    authService: new AuthService({
      env,
      auditService,
      accountRepository,
      userRepository,
      sessionRepository: options.sessionRepository ?? new FailingSessionRepository(),
      workspaceTokenRepository: new InMemoryWorkspaceTokenRepository(),
      workspaceService,
      accountAccessService,
      accountInvitationService,
      onAccountCreated: options.onAccountCreated,
      organizationCreationGuard: options.organizationCreationGuard,
      organizationProvisioner: options.organizationProvisioner ?? new InMemoryOrganizationProvisioner(
        accountRepository,
        userRepository,
        accountAccessService,
        workspaceService,
      ),
    }),
    accountRepository,
    userRepository,
    accountMembershipRepository,
    accountInvitationRepository,
    auditService,
  };
};

describe("AuthService rollback", () => {
  it("deletes the newly created account and user if post-registration provisioning fails", async () => {
    const accountRepository = new TrackingAccountRepository();
    const userRepository = new InMemoryUserRepository();
    const { authService } = createAuthService({
      accountRepository,
      userRepository,
      onAccountCreated: async () => {
        throw new Error("account hook failed");
      },
    });

    await expect(
      authService.register({
        email: "rollback-register@example.com",
        password: "verysecurepassword",
      }),
    ).rejects.toThrow("account hook failed");

    expect(accountRepository.deletedIds).toEqual(["account-1"]);
    expect(await accountRepository.findById("account-1")).toBeNull();
    expect(await userRepository.findById("account-1")).toBeNull();
  });

  it("deletes the new account if organization creation fails after membership setup", async () => {
    const accountRepository = new TrackingAccountRepository();
    const userRepository = new InMemoryUserRepository();
    await userRepository.create({
      id: "user-1",
      email: "existing@example.com",
      passwordHash: "hash",
    });
    const { authService } = createAuthService({
      accountRepository,
      userRepository,
    });

    await expect(
      authService.createOrganization({
        userId: "user-1",
        organizationName: "Rollback Org",
      }),
    ).rejects.toThrow("session create failed");

    expect(accountRepository.deletedIds).toEqual(["account-1"]);
    expect(await accountRepository.findById("account-1")).toBeNull();
    expect(await userRepository.findById("user-1")).toBeTruthy();
  });

  it("reverts invitation acceptance and deletes a newly created user if session creation fails", async () => {
    const accountRepository = new TrackingAccountRepository();
    const invitationRepository = new InMemoryAccountInvitationRepository();
    const { authService, accountMembershipRepository, userRepository } = createAuthService({
      accountRepository,
      accountInvitationRepository: invitationRepository,
    });

    const account = await accountRepository.create({
      name: "Shared Org",
      email: "owner@example.com",
      passwordHash: "hash",
    });
    const invitationToken = "invitation-token";
    await invitationRepository.create({
      accountId: account.id,
      email: "invitee@example.com",
      invitedByMembershipId: "membership-owner",
      tokenHash: sha256(invitationToken),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      authService.acceptInvitation({
        invitationToken,
        email: "invitee@example.com",
        password: "verysecurepassword",
      }),
    ).rejects.toThrow();

    const invitation = await invitationRepository.findByTokenHash(
      sha256(invitationToken),
    );

    expect(invitation?.status).toBe("pending");
    expect(invitation?.acceptedByUserId).toBeNull();
    const createdUser = await userRepository.findByEmail("invitee@example.com");
    expect(createdUser).toBeNull();
    expect(
      createdUser
        ? await accountMembershipRepository.findActiveByAccountAndUser(account.id, createdUser.id)
        : null,
    ).toBeNull();
  });

  it("calls the account-created hook when creating a new organization account", async () => {
    const accountIds: string[] = [];
    const userRepository = new InMemoryUserRepository();
    await userRepository.create({
      id: "user-1",
      email: "create-org@example.com",
      passwordHash: "hash",
    });
    const { authService: orgAuthService } = createAuthService({
      userRepository,
      sessionRepository: new WorkingSessionRepository(),
      onAccountCreated: async ({ accountId }) => {
        accountIds.push(accountId);
      },
    });

    const { accountId } = await orgAuthService.createOrganization({
      userId: "user-1",
      organizationName: "Hook Org",
    });

    expect(accountIds).toEqual([accountId]);
  });

  it("reserves and commits one organization creation when creating a new organization account", async () => {
    const guard = new RecordingOrganizationCreationGuard();
    const userRepository = new InMemoryUserRepository();
    await userRepository.create({
      id: "user-1",
      email: "create-org-guard@example.com",
      passwordHash: "hash",
    });
    const { authService: orgAuthService } = createAuthService({
      userRepository,
      sessionRepository: new WorkingSessionRepository(),
      organizationCreationGuard: guard,
    });

    await orgAuthService.createOrganization({
      userId: "user-1",
      organizationName: "Guard Org",
    });

    expect(guard.reservations).toHaveLength(1);
    expect(guard.reservations[0]).toMatchObject({
      committed: true,
      released: false,
    });
    expect(guard.requests).toEqual([{ intent: "additional", userId: "user-1" }]);
  });

  it("releases the organization creation reservation when post-create provisioning fails", async () => {
    const guard = new RecordingOrganizationCreationGuard();
    const userRepository = new InMemoryUserRepository();
    await userRepository.create({
      id: "user-1",
      email: "create-org-release@example.com",
      passwordHash: "hash",
    });
    const { authService: orgAuthService } = createAuthService({
      userRepository,
      organizationCreationGuard: guard,
    });

    await expect(orgAuthService.createOrganization({
      userId: "user-1",
      organizationName: "Release Org",
    })).rejects.toThrow("session create failed");

    expect(guard.reservations[0]).toMatchObject({
      committed: false,
      released: true,
    });
  });

  it("releases the organization creation reservation when account persistence fails", async () => {
    const guard = new RecordingOrganizationCreationGuard();
    const userRepository = new InMemoryUserRepository();
    await userRepository.create({
      id: "user-1",
      email: "create-org-account-failure@example.com",
      passwordHash: "hash",
    });
    const { authService: orgAuthService } = createAuthService({
      accountRepository: new FailingAccountRepository(),
      userRepository,
      organizationCreationGuard: guard,
    });

    await expect(orgAuthService.createOrganization({
      userId: "user-1",
      organizationName: "Never Persisted",
    })).rejects.toThrow("account create failed");

    expect(guard.reservations[0]).toMatchObject({ committed: false, released: true });
  });

  it("releases the signup reservation when account persistence fails", async () => {
    const guard = new RecordingOrganizationCreationGuard();
    const { authService } = createAuthService({
      accountRepository: new FailingAccountRepository(),
      organizationCreationGuard: guard,
    });

    await expect(authService.register({
      email: "register-account-failure@example.com",
      password: "verysecurepassword",
    })).rejects.toThrow("account create failed");

    expect(guard.requests).toEqual([{ intent: "signup" }]);
    expect(guard.reservations[0]).toMatchObject({ committed: false, released: true });
  });

  it("does not create account records when the organization creation guard rejects", async () => {
    const guard = new RecordingOrganizationCreationGuard();
    guard.shouldReject = {
      statusCode: 429,
      code: "rate_limit_exceeded",
      message: "Organization creation limit reached.",
      details: {
        limit: 1,
        used: 1,
        periodStart: "2026-06-01",
        resetAt: "2026-07-01T00:00:00.000Z",
      },
    };
    const accountRepository = new TrackingAccountRepository();
    const userRepository = new InMemoryUserRepository();
    await userRepository.create({
      id: "user-1",
      email: "create-org-blocked@example.com",
      passwordHash: "hash",
    });
    const { authService: orgAuthService, auditService } = createAuthService({
      accountRepository,
      userRepository,
      sessionRepository: new WorkingSessionRepository(),
      organizationCreationGuard: guard,
    });

    await expect(orgAuthService.createOrganization({
      userId: "user-1",
      organizationName: "Blocked Org",
    })).rejects.toMatchObject({ statusCode: 429, code: "rate_limit_exceeded" });

    expect(accountRepository.items.size).toBe(0);
    expect(auditService.events.at(-1)).toMatchObject({
      eventType: "account.create",
      eventStatus: "failure",
      metadata: {
        actorUserId: "user-1",
        reason: "rate_limited",
      },
    });
  });

  it("records sanitized signup denial metadata without customer content", async () => {
    const guard = new RecordingOrganizationCreationGuard();
    guard.shouldReject = {
      statusCode: 403,
      code: "forbidden",
      message: "Registration is closed",
      details: { organizationName: "Sensitive Org", email: "owner@example.com" },
    };
    const accountRepository = new TrackingAccountRepository();
    const { authService, auditService, userRepository } = createAuthService({
      accountRepository,
      organizationCreationGuard: guard,
    });

    await expect(authService.register({
      email: "owner@example.com",
      password: "verysecurepassword",
      organizationName: "Sensitive Org",
    })).rejects.toMatchObject({ statusCode: 403, code: "forbidden" });

    expect(accountRepository.items.size).toBe(0);
    expect(await userRepository.findByEmail("owner@example.com")).toBeNull();
    expect(auditService.events.at(-1)).toEqual({
      eventType: "auth.register",
      eventStatus: "failure",
      metadata: { reason: "registration_closed" },
    });
  });

  it("returns closed registration before duplicate-account handling on initialized OSS", async () => {
    const guard = new RecordingOrganizationCreationGuard();
    guard.shouldReject = {
      statusCode: 403,
      code: "forbidden",
      message: "Registration is closed",
    };
    const userRepository = new InMemoryUserRepository();
    await userRepository.create({
      id: "existing-user",
      email: "existing@example.com",
      passwordHash: "hash",
    });
    const { authService, auditService } = createAuthService({ userRepository, organizationCreationGuard: guard });

    await expect(authService.register({
      email: "existing@example.com",
      password: "verysecurepassword",
    })).rejects.toMatchObject({ statusCode: 403, code: "forbidden" });

    expect(auditService.events.at(-1)).toMatchObject({
      eventType: "auth.register",
      eventStatus: "failure",
      metadata: { reason: "registration_closed" },
    });
  });

  it("does not release committed organization creation reservations when deleting organizations", async () => {
    const guard = new RecordingOrganizationCreationGuard();
    const userRepository = new InMemoryUserRepository();
    await userRepository.create({
      id: "user-1",
      email: "create-org-delete@example.com",
      passwordHash: "hash",
    });
    const { authService: orgAuthService } = createAuthService({
      userRepository,
      sessionRepository: new WorkingSessionRepository(),
      organizationCreationGuard: guard,
    });

    const { accountId } = await orgAuthService.createOrganization({
      userId: "user-1",
      organizationName: "Deleted Org",
    });
    await orgAuthService.deleteOrganization({ accountId, userId: "user-1" });

    expect(guard.reservations[0]).toMatchObject({
      committed: true,
      released: false,
    });
  });

  it("calls the account-created hook when registering a new account", async () => {
    const accountIds: string[] = [];
    const { authService } = createAuthService({
      sessionRepository: new WorkingSessionRepository(),
      onAccountCreated: async ({ accountId }) => {
        accountIds.push(accountId);
      },
    });

    const { accountId } = await authService.register({
      email: "hooked@example.com",
      password: "verysecurepassword",
    });

    expect(accountIds).toEqual([accountId]);
  });

  it("registers new users as unverified without creating an immediate session", async () => {
    const { authService, userRepository } = createAuthService({
      sessionRepository: new WorkingSessionRepository(),
    });

    const result = await authService.register({
      email: "verify-after-register@example.com",
      password: "verysecurepassword",
    });

    const user = await userRepository.findById(result.userId);
    expect(result.sessionCookie).toBeUndefined();
    expect(user?.emailVerifiedAt).toBeNull();
  });

  it("reserves and commits signup organization creation while registering a first account", async () => {
    const guard = new RecordingOrganizationCreationGuard();
    const { authService } = createAuthService({
      sessionRepository: new WorkingSessionRepository(),
      organizationCreationGuard: guard,
    });

    await authService.register({
      email: "signup-not-capped@example.com",
      password: "verysecurepassword",
    });

    expect(guard.requests).toEqual([{ intent: "signup" }]);
    expect(guard.reservations).toHaveLength(1);
    expect(guard.reservations[0]).toMatchObject({
      committed: true,
      released: false,
      accountId: "account-1",
    });
  });

  it("provisions a new account and workspace on first federated sign-in", async () => {
    const accountIds: string[] = [];
    const guard = new RecordingOrganizationCreationGuard();
    const { authService, userRepository } = createAuthService({
      sessionRepository: new WorkingSessionRepository(),
      organizationCreationGuard: guard,
      onAccountCreated: async ({ accountId }) => {
        accountIds.push(accountId);
      },
    });

    const result = await authService.federatedLogin({
      provider: "google",
      subject: "google-sub-1",
      email: "New.Person@Example.com",
      emailVerified: true,
    });

    const user = await userRepository.findByEmail("new.person@example.com");
    expect(user).not.toBeNull();
    expect(result.userId).toBe(user?.id);
    expect(result.accountId).toBe(user?.id);
    expect(accountIds).toEqual([result.accountId]);
    expect(user?.emailVerifiedAt).not.toBeNull();
    expect(result.sessionCookie).toContain("radioso_session=");
    expect(guard.requests).toEqual([{ intent: "signup" }]);
    expect(guard.reservations[0]).toMatchObject({
      committed: true,
      released: false,
      accountId: result.accountId,
    });
  });

  it("logs an existing verified user in without creating a second account", async () => {
    const { authService, userRepository } = createAuthService({
      sessionRepository: new WorkingSessionRepository(),
    });
    const registered = await authService.register({
      email: "linkme@example.com",
      password: "verysecurepassword",
    });
    await userRepository.markEmailVerified(registered.userId, new Date());

    const result = await authService.federatedLogin({
      provider: "google",
      subject: "google-sub-2",
      email: "linkme@example.com",
      emailVerified: true,
    });

    expect(result.userId).toBe(registered.userId);
    expect(result.accountId).toBe(registered.accountId);
    expect(result.sessionCookie).toContain("radioso_session=");
  });

  it("verifies and signs in an existing unverified user on federated sign-in", async () => {
    const { authService, userRepository } = createAuthService({
      sessionRepository: new WorkingSessionRepository(),
    });
    const registered = await authService.register({
      email: "unverified@example.com",
      password: "verysecurepassword",
    });
    expect((await userRepository.findById(registered.userId))?.emailVerifiedAt).toBeNull();

    const result = await authService.federatedLogin({
      provider: "google",
      subject: "google-sub-3",
      email: "unverified@example.com",
      emailVerified: true,
    });

    expect(result.userId).toBe(registered.userId);
    expect((await userRepository.findById(registered.userId))?.emailVerifiedAt).not.toBeNull();
    expect(result.sessionCookie).toContain("radioso_session=");
  });

  it("rotates the password and revokes sessions when verifying a squatted account (anti pre-hijack)", async () => {
    const revokeCalls: string[] = [];
    const sessionRepository = new WorkingSessionRepository();
    const originalRevoke = sessionRepository.revokeAllForUser.bind(sessionRepository);
    sessionRepository.revokeAllForUser = async (userId: string, revokedAt: Date) => {
      revokeCalls.push(userId);
      return originalRevoke(userId, revokedAt);
    };
    const { authService, userRepository } = createAuthService({ sessionRepository });

    // Attacker registers the victim's email with a password they know. The
    // account is unverified, so password login is still blocked.
    const squatted = await authService.register({
      email: "victim@example.com",
      password: "attacker-known-password",
    });
    const squattedHash = (await userRepository.findById(squatted.userId))?.passwordHash;

    // The real owner signs in with Google.
    await authService.federatedLogin({
      provider: "google",
      subject: "google-sub-victim",
      email: "victim@example.com",
      emailVerified: true,
    });

    // The attacker's password must no longer work, and the hash must have rotated.
    const rotatedHash = (await userRepository.findById(squatted.userId))?.passwordHash;
    expect(rotatedHash).not.toBe(squattedHash);
    expect(revokeCalls).toContain(squatted.userId);
    await expect(
      authService.login({ email: "victim@example.com", password: "attacker-known-password" }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("does not rotate the password of an already-verified user on federated sign-in", async () => {
    const { authService, userRepository } = createAuthService({
      sessionRepository: new WorkingSessionRepository(),
    });
    const registered = await authService.register({
      email: "verified-pw@example.com",
      password: "owner-password",
    });
    await userRepository.markEmailVerified(registered.userId, new Date());
    const verifiedHash = (await userRepository.findById(registered.userId))?.passwordHash;

    await authService.federatedLogin({
      provider: "google",
      subject: "google-sub-verified",
      email: "verified-pw@example.com",
      emailVerified: true,
    });

    expect((await userRepository.findById(registered.userId))?.passwordHash).toBe(verifiedHash);
    await expect(
      authService.login({ email: "verified-pw@example.com", password: "owner-password" }),
    ).resolves.toMatchObject({ userId: registered.userId });
  });

  it("rejects a federated sign-in whose email the provider did not verify", async () => {
    const { authService } = createAuthService({
      sessionRepository: new WorkingSessionRepository(),
    });

    await expect(
      authService.federatedLogin({
        provider: "google",
        subject: "google-sub-4",
        email: "unverified-by-provider@example.com",
        emailVerified: false,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rolls back the provisioned account if federated provisioning fails", async () => {
    const accountRepository = new TrackingAccountRepository();
    const { authService } = createAuthService({
      accountRepository,
      sessionRepository: new WorkingSessionRepository(),
      onAccountCreated: async () => {
        throw new Error("provisioning hook failed");
      },
    });

    await expect(
      authService.federatedLogin({
        provider: "google",
        subject: "google-sub-5",
        email: "rollback-federated@example.com",
        emailVerified: true,
      }),
    ).rejects.toThrow("provisioning hook failed");

    expect(accountRepository.deletedIds).toEqual(["account-1"]);
    expect(await accountRepository.findById("account-1")).toBeNull();
  });

  it("rolls back the loser of a concurrent first sign-in when the unique email insert fails", async () => {
    // Two simultaneous first-time federated callbacks for the same new email
    // both miss findByEmail and both provision. In Postgres the second user
    // insert violates the users.email UNIQUE constraint (users_email_key); this
    // proves provisionFederatedAccount funnels that failure into the account
    // rollback path, so the race cannot leave a duplicate/orphan account.
    const accountRepository = new TrackingAccountRepository();
    const userRepository = new InMemoryUserRepository();
    userRepository.create = async () => {
      throw Object.assign(new Error("duplicate key value violates unique constraint \"users_email_key\""), {
        code: "23505",
      });
    };
    const { authService } = createAuthService({
      accountRepository,
      userRepository,
      sessionRepository: new WorkingSessionRepository(),
    });

    await expect(
      authService.federatedLogin({
        provider: "google",
        subject: "google-sub-race",
        email: "race@example.com",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "23505" });

    expect(accountRepository.deletedIds).toEqual(["account-1"]);
    expect(await accountRepository.findById("account-1")).toBeNull();
  });

  it("rejects login until the user email is verified", async () => {
    const { authService, userRepository } = createAuthService({
      sessionRepository: new WorkingSessionRepository(),
    });
    const { userId } = await authService.register({
      email: "login-after-verify@example.com",
      password: "verysecurepassword",
    });

    await expect(authService.login({
      email: "login-after-verify@example.com",
      password: "verysecurepassword",
    })).rejects.toMatchObject({
      statusCode: 403,
      code: "forbidden",
    });

    await userRepository.markEmailVerified(userId, new Date());

    await expect(authService.login({
      email: "login-after-verify@example.com",
      password: "verysecurepassword",
    })).resolves.toMatchObject({
      userId,
      sessionCookie: expect.stringContaining("radioso_session="),
    });
  });
});
