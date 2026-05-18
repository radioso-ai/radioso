import { describe, expect, it } from "vitest";

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

  async findByEmail(email: string): Promise<AccountRecord | null> {
    return [...this.items.values()].find((item) => item.email === email) ?? null;
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

const createAuthService = (options: {
  accountRepository?: AccountRepositoryPort;
  userRepository?: InMemoryUserRepository;
  sessionRepository?: SessionRepositoryPort;
  workspaceService?: WorkspaceService;
  accountInvitationRepository?: InMemoryAccountInvitationRepository;
  onAccountCreated?: (input: { accountId: string }) => Promise<void>;
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
    }),
    accountRepository,
    userRepository,
    accountMembershipRepository,
    accountInvitationRepository,
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
