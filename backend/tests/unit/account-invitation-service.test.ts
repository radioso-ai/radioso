import { describe, expect, it } from "vitest";

import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import { AccountInvitationService } from "../../src/modules/account/services/accountInvitationService.js";
import type {
  AccountInvitationRecord,
  AccountInvitationStatus,
} from "../../src/db/repositories/accountInvitationRepository.js";
import {
  createAuditService,
  InMemoryAccountInvitationRepository,
  InMemoryAccountMembershipRepository,
  InMemoryUserRepository,
} from "../support/fakes.js";

class AcceptBeforeRevokeInvitationRepository extends InMemoryAccountInvitationRepository {
  constructor(private readonly acceptedByUserId: string) {
    super();
  }

  override async update(params: {
    id: string;
    status: AccountInvitationStatus;
    acceptedAt?: Date | null;
    acceptedByUserId?: string | null;
  }): Promise<AccountInvitationRecord> {
    if (params.status === "revoked") {
      await super.update({
        id: params.id,
        status: "accepted",
        acceptedAt: new Date(),
        acceptedByUserId: this.acceptedByUserId,
      });
    }

    return super.update(params);
  }

  override async updateIfStatus(params: {
    id: string;
    currentStatus: AccountInvitationStatus;
    status: AccountInvitationStatus;
    acceptedAt?: Date | null;
    acceptedByUserId?: string | null;
  }): Promise<AccountInvitationRecord | null> {
    if (params.status === "revoked") {
      await super.update({
        id: params.id,
        status: "accepted",
        acceptedAt: new Date(),
        acceptedByUserId: this.acceptedByUserId,
      });
    }

    return super.updateIfStatus(params);
  }
}

class RevokeBeforeAcceptInvitationRepository extends InMemoryAccountInvitationRepository {
  override async update(params: {
    id: string;
    status: AccountInvitationStatus;
    acceptedAt?: Date | null;
    acceptedByUserId?: string | null;
  }): Promise<AccountInvitationRecord> {
    if (params.status === "accepted") {
      await super.update({ id: params.id, status: "revoked" });
    }

    return super.update(params);
  }

  override async updateIfStatus(params: {
    id: string;
    currentStatus: AccountInvitationStatus;
    status: AccountInvitationStatus;
    acceptedAt?: Date | null;
    acceptedByUserId?: string | null;
  }): Promise<AccountInvitationRecord | null> {
    if (params.status === "accepted") {
      await super.update({ id: params.id, status: "revoked" });
    }

    return super.updateIfStatus(params);
  }
}

describe("AccountInvitationService", () => {
  it("creates a pending invitation and acceptance URL", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const accessService = new AccountAccessService(membershipRepository, createAuditService());
    const service = new AccountInvitationService(
      new InMemoryAccountInvitationRepository(),
      userRepository,
      accessService,
      createAuditService(),
    );
    const inviter = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: inviter.id, role: "owner" });

    const invitation = await service.createInvitation({
      accountId: "account-1",
      invitedByUserId: inviter.id,
      email: "teammate@example.com",
    });

    expect(invitation.status).toBe("pending");
    expect(invitation.acceptanceUrl).toMatch(/^\/invite\/[a-f0-9]+$/);
  });

  it("rejects duplicate pending invitations", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const accessService = new AccountAccessService(membershipRepository, createAuditService());
    const auditService = createAuditService();
    const service = new AccountInvitationService(
      new InMemoryAccountInvitationRepository(),
      userRepository,
      accessService,
      auditService,
    );
    const inviter = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: inviter.id, role: "owner" });

    await service.createInvitation({
      accountId: "account-1",
      invitedByUserId: inviter.id,
      email: "teammate@example.com",
    });

    await expect(
      service.createInvitation({
        accountId: "account-1",
        invitedByUserId: inviter.id,
        email: "teammate@example.com",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
    });

    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        accountId: "account-1",
        eventType: "account.invitation.create",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          email: "teammate@example.com",
          reason: "invitation_already_pending",
        }),
      }),
    );
  });

  it("revokes a pending invitation and audits the success", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const accessService = new AccountAccessService(membershipRepository, createAuditService());
    const auditService = createAuditService();
    const invitationRepository = new InMemoryAccountInvitationRepository();
    const service = new AccountInvitationService(
      invitationRepository,
      userRepository,
      accessService,
      auditService,
    );
    const inviter = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: inviter.id, role: "owner" });

    const invitation = await service.createInvitation({
      accountId: "account-1",
      invitedByUserId: inviter.id,
      email: "teammate@example.com",
    });

    await service.revokeInvitation({
      accountId: "account-1",
      actorUserId: inviter.id,
      invitationId: invitation.id,
    });

    const [stored] = await service.listForAccount("account-1");
    expect(stored.status).toBe("revoked");
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        accountId: "account-1",
        eventType: "account.invitation.revoke",
        eventStatus: "success",
        metadata: expect.objectContaining({ email: "teammate@example.com" }),
      }),
    );
  });

  it("rejects revoking an already accepted invitation", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const accessService = new AccountAccessService(membershipRepository, createAuditService());
    const invitationRepository = new InMemoryAccountInvitationRepository();
    const service = new AccountInvitationService(
      invitationRepository,
      userRepository,
      accessService,
      createAuditService(),
    );
    const inviter = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: inviter.id, role: "owner" });

    const invitation = await service.createInvitation({
      accountId: "account-1",
      invitedByUserId: inviter.id,
      email: "teammate@example.com",
    });
    const stored = await invitationRepository.findById(invitation.id);
    await invitationRepository.update({ id: invitation.id, status: "accepted", acceptedAt: new Date() });

    await expect(
      service.revokeInvitation({
        accountId: "account-1",
        actorUserId: inviter.id,
        invitationId: stored!.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "conflict" });
  });

  it("does not overwrite an invitation accepted after revoke reads it as pending", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const accessService = new AccountAccessService(membershipRepository, createAuditService());
    const auditService = createAuditService();
    const inviter = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    const invitee = await userRepository.create({ email: "teammate@example.com", passwordHash: "hash" });
    const invitationRepository = new AcceptBeforeRevokeInvitationRepository(invitee.id);
    const service = new AccountInvitationService(
      invitationRepository,
      userRepository,
      accessService,
      auditService,
    );
    await membershipRepository.create({ accountId: "account-1", userId: inviter.id, role: "owner" });

    const invitation = await service.createInvitation({
      accountId: "account-1",
      invitedByUserId: inviter.id,
      email: "teammate@example.com",
    });

    await expect(
      service.revokeInvitation({
        accountId: "account-1",
        actorUserId: inviter.id,
        invitationId: invitation.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "conflict" });

    expect(await invitationRepository.findById(invitation.id)).toMatchObject({
      status: "accepted",
      acceptedByUserId: invitee.id,
    });
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        accountId: "account-1",
        eventType: "account.invitation.revoke",
        eventStatus: "failure",
        metadata: expect.objectContaining({ reason: "invitation_already_accepted" }),
      }),
    );
  });

  it("does not add membership when an invitation is revoked after accept reads it as pending", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const accessService = new AccountAccessService(membershipRepository, createAuditService());
    const auditService = createAuditService();
    const invitationRepository = new RevokeBeforeAcceptInvitationRepository();
    const service = new AccountInvitationService(
      invitationRepository,
      userRepository,
      accessService,
      auditService,
    );
    const inviter = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    const invitee = await userRepository.create({ email: "teammate@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: inviter.id, role: "owner" });

    const invitation = await service.createInvitation({
      accountId: "account-1",
      invitedByUserId: inviter.id,
      email: "teammate@example.com",
    });
    const invitationToken = invitation.acceptanceUrl.split("/").at(-1)!;

    await expect(service.acceptInvitation(invitationToken, invitee.id))
      .rejects.toMatchObject({ statusCode: 409, code: "conflict" });

    expect(await invitationRepository.findById(invitation.id)).toMatchObject({ status: "revoked" });
    expect(await membershipRepository.findActiveByAccountAndUser("account-1", invitee.id)).toBeNull();
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        accountId: "account-1",
        eventType: "account.invitation.accept",
        eventStatus: "failure",
        metadata: expect.objectContaining({ reason: "invitation_revoked" }),
      }),
    );
  });

  it("does not allow revoking an invitation from another account", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const accessService = new AccountAccessService(membershipRepository, createAuditService());
    const invitationRepository = new InMemoryAccountInvitationRepository();
    const service = new AccountInvitationService(
      invitationRepository,
      userRepository,
      accessService,
      createAuditService(),
    );
    const inviter = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: inviter.id, role: "owner" });
    const otherOwner = await userRepository.create({ email: "other@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-2", userId: otherOwner.id, role: "owner" });

    const invitation = await service.createInvitation({
      accountId: "account-1",
      invitedByUserId: inviter.id,
      email: "teammate@example.com",
    });

    await expect(
      service.revokeInvitation({
        accountId: "account-2",
        actorUserId: otherOwner.id,
        invitationId: invitation.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "not_found" });
  });

  it("rejects invitations for users who already have access and audits the failure", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const accessService = new AccountAccessService(membershipRepository, createAuditService());
    const auditService = createAuditService();
    const service = new AccountInvitationService(
      new InMemoryAccountInvitationRepository(),
      userRepository,
      accessService,
      auditService,
    );
    const inviter = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    const teammate = await userRepository.create({ email: "teammate@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: inviter.id, role: "owner" });
    await membershipRepository.create({ accountId: "account-1", userId: teammate.id, role: "member" });

    await expect(
      service.createInvitation({
        accountId: "account-1",
        invitedByUserId: inviter.id,
        email: "teammate@example.com",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
    });

    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        accountId: "account-1",
        eventType: "account.invitation.create",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          email: "teammate@example.com",
          reason: "user_already_has_access",
        }),
      }),
    );
  });
});
