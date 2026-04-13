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
}

const createAuthService = (options: {
  accountRepository?: AccountRepositoryPort;
  userRepository?: InMemoryUserRepository;
  sessionRepository?: SessionRepositoryPort;
  workspaceService?: WorkspaceService;
  accountInvitationRepository?: InMemoryAccountInvitationRepository;
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
    }),
    accountRepository,
    userRepository,
    accountMembershipRepository,
    accountInvitationRepository,
  };
};

describe("AuthService rollback", () => {
  it("deletes the newly created account and user if registration fails after provisioning starts", async () => {
    const accountRepository = new TrackingAccountRepository();
    const userRepository = new InMemoryUserRepository();
    const { authService } = createAuthService({
      accountRepository,
      userRepository,
    });

    await expect(
      authService.register({
        email: "rollback-register@example.com",
        password: "verysecurepassword",
      }),
    ).rejects.toThrow("session create failed");

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
});
