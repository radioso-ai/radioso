import { conflict, forbidden, notFound, unauthorized } from "../../../shared/domain/errors.js";
import type {
  AccountMembershipRecord,
  AccountMembershipRepositoryPort,
  AccountMembershipRole,
  AccountMembershipUserRecord,
} from "../../../db/repositories/accountMembershipRepository.js";
import type { AuditService } from "../../audit/contracts/index.js";

export class AccountAccessService {
  constructor(
    private readonly membershipRepository: AccountMembershipRepositoryPort,
    private readonly auditService: AuditService,
  ) {}

  async findActiveMembership(accountId: string, userId: string): Promise<AccountMembershipRecord | null> {
    return this.membershipRepository.findActiveByAccountAndUser(accountId, userId);
  }

  async requireActiveMembership(accountId: string, userId: string): Promise<AccountMembershipRecord> {
    const membership = await this.findActiveMembership(accountId, userId);
    if (!membership) {
      throw unauthorized("Active account membership is required");
    }

    return membership;
  }

  async resolveLoginAccount(userId: string, preferredAccountId?: string | null): Promise<AccountMembershipRecord> {
    const memberships = await this.membershipRepository.listActiveByUser(userId);
    if (memberships.length === 0) {
      throw unauthorized("No active account membership found");
    }

    if (preferredAccountId) {
      const preferredMembership = memberships.find((membership) => membership.accountId === preferredAccountId);
      if (preferredMembership) {
        return preferredMembership;
      }
    }

    return memberships.at(-1)!;
  }

  async listAccountUsers(accountId: string): Promise<AccountMembershipUserRecord[]> {
    return this.membershipRepository.listActiveByAccount(accountId);
  }

  async listUserMemberships(userId: string): Promise<AccountMembershipRecord[]> {
    return this.membershipRepository.listActiveByUser(userId);
  }

  async ensureMembership(params: {
    accountId: string;
    userId: string;
    role: AccountMembershipRole;
  }): Promise<AccountMembershipRecord> {
    const existing = await this.membershipRepository.findActiveByAccountAndUser(params.accountId, params.userId);
    if (existing) {
      return existing;
    }

    return this.membershipRepository.create(params);
  }

  async removeMembershipIfExists(accountId: string, userId: string): Promise<void> {
    const membership = await this.membershipRepository.findActiveByAccountAndUser(accountId, userId);
    if (membership) {
      await this.membershipRepository.deleteById(membership.id);
    }
  }

  async requireMembershipById(id: string): Promise<AccountMembershipRecord> {
    const membership = await this.membershipRepository.findById(id);
    if (!membership || membership.status !== "active") {
      throw notFound("Membership not found");
    }

    return membership;
  }

  async removeUserAccess(input: {
    accountId: string;
    actorUserId: string;
    membershipId: string;
  }): Promise<void> {
    const actorMembership = await this.requireActiveMembership(input.accountId, input.actorUserId);
    const targetMembership = await this.requireMembershipById(input.membershipId);

    if (targetMembership.accountId !== input.accountId) {
      throw notFound("Membership not found");
    }

    if (actorMembership.role !== "owner") {
      await this.auditService.record({
        accountId: input.accountId,
        eventType: "account.membership.remove",
        eventStatus: "failure",
        metadata: {
          actorUserId: input.actorUserId,
          targetMembershipId: input.membershipId,
          reason: "actor_not_owner",
        },
      });
      throw forbidden("Only account owners can remove user access");
    }

    if (targetMembership.userId === input.actorUserId) {
      await this.auditService.record({
        accountId: input.accountId,
        eventType: "account.membership.remove",
        eventStatus: "failure",
        metadata: {
          actorUserId: input.actorUserId,
          targetMembershipId: input.membershipId,
          reason: "self_removal_forbidden",
        },
      });
      throw conflict("Account owners cannot remove their own access");
    }

    if (targetMembership.role === "owner") {
      await this.auditService.record({
        accountId: input.accountId,
        eventType: "account.membership.remove",
        eventStatus: "failure",
        metadata: {
          actorUserId: input.actorUserId,
          targetMembershipId: input.membershipId,
          reason: "owner_removal_forbidden",
        },
      });
      throw conflict("Owner access cannot be removed");
    }

    await this.membershipRepository.deleteById(targetMembership.id);
    await this.auditService.record({
      accountId: input.accountId,
      eventType: "account.membership.remove",
      eventStatus: "success",
      metadata: {
        actorUserId: input.actorUserId,
        removedUserId: targetMembership.userId,
        targetMembershipId: targetMembership.id,
      },
    });
  }
}
