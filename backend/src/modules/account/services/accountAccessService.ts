import { conflict, forbidden, notFound, unauthorized } from "../../../shared/domain/errors.js";
import type {
  AccountMembershipRecord,
  AccountMembershipRepositoryPort,
  AccountMembershipRole,
  AccountMembershipUserRecord,
} from "../../../db/repositories/accountMembershipRepository.js";
import type {
  WorkspaceGrantRecord,
  WorkspaceGrantRepositoryPort,
  WorkspaceGrantRole,
} from "../../../db/repositories/workspaceGrantRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AuditService } from "../../audit/contracts/index.js";

export type AccountPermission =
  | "account.users.manage"
  | "account.membership.remove"
  | "account.membership.role.update"
  | "account.organization.rename"
  | "workspace.create"
  | "workspace.rename"
  | "workspace.delete"
  | "workspace.settings.manage"
  | "workspace.documents.manage"
  | "workspace.token.read"
  | "workspace.token.rotate";

export interface WorkspaceGrantSummary {
  workspaceId: string;
  userId: string;
  role: WorkspaceGrantRole;
  createdAt: string;
  updatedAt: string;
}

const roleRank: Record<AccountMembershipRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

const grantRank: Record<WorkspaceGrantRole, number> = {
  member: 1,
  admin: 2,
};

export class AccountAccessService {
  constructor(
    private readonly membershipRepository: AccountMembershipRepositoryPort,
    private readonly auditService: AuditService,
    private readonly workspaceGrantRepository?: WorkspaceGrantRepositoryPort,
    private readonly workspaceRepository?: Pick<WorkspaceRepositoryPort, "findByIdAndAccountId">,
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

  async listWorkspaceGrants(accountId: string): Promise<WorkspaceGrantSummary[]> {
    if (!this.workspaceGrantRepository) {
      return [];
    }

    const grants = await this.workspaceGrantRepository.listByAccount(accountId);
    return grants.map((grant) => ({
      workspaceId: grant.workspaceId,
      userId: grant.userId,
      role: grant.role,
      createdAt: grant.createdAt.toISOString(),
      updatedAt: grant.updatedAt.toISOString(),
    }));
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

    if (!(await this.hasPermission({
      accountId: input.accountId,
      userId: input.actorUserId,
      permission: "account.membership.remove",
    }))) {
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

    if (this.workspaceGrantRepository) {
      await this.workspaceGrantRepository.deleteByAccountAndUser(input.accountId, targetMembership.userId);
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

  async updateMembershipRole(input: {
    accountId: string;
    actorUserId: string;
    membershipId: string;
    role: Exclude<AccountMembershipRole, "owner">;
  }): Promise<AccountMembershipRecord> {
    await this.requirePermission({
      accountId: input.accountId,
      userId: input.actorUserId,
      permission: "account.membership.role.update",
    });
    const targetMembership = await this.requireMembershipById(input.membershipId);
    if (targetMembership.accountId !== input.accountId) {
      throw notFound("Membership not found");
    }
    if (targetMembership.userId === input.actorUserId) {
      throw conflict("Users cannot change their own role");
    }
    if (targetMembership.role === "owner") {
      throw conflict("Owner roles cannot be changed in this release");
    }
    const updated = await this.membershipRepository.updateRole(targetMembership.id, input.role);
    await this.auditService.record({
      accountId: input.accountId,
      eventType: "account.membership.role.update",
      eventStatus: "success",
      metadata: {
        actorUserId: input.actorUserId,
        targetMembershipId: input.membershipId,
        previousRole: targetMembership.role,
        role: input.role,
      },
    });

    return updated;
  }

  async setWorkspaceGrant(input: {
    accountId: string;
    actorUserId: string;
    workspaceId: string;
    userId: string;
    role: WorkspaceGrantRole;
  }): Promise<WorkspaceGrantRecord> {
    if (!this.workspaceGrantRepository) {
      throw new Error("Workspace grant repository is not configured");
    }
    await this.requireWorkspaceInAccount(input.accountId, input.workspaceId);
    await this.requirePermission({
      accountId: input.accountId,
      userId: input.actorUserId,
      permission: "account.membership.role.update",
      workspaceId: input.workspaceId,
    });
    if (input.userId === input.actorUserId) {
      throw conflict("Users cannot change their own workspace access");
    }
    const targetMembership = await this.requireActiveMembership(input.accountId, input.userId);
    const grant = await this.workspaceGrantRepository.upsert({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      userId: targetMembership.userId,
      role: input.role,
    });
    await this.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "workspace.grant.update",
      eventStatus: "success",
      metadata: {
        actorUserId: input.actorUserId,
        userId: input.userId,
        role: input.role,
      },
    });

    return grant;
  }

  async removeWorkspaceGrant(input: {
    accountId: string;
    actorUserId: string;
    workspaceId: string;
    userId: string;
  }): Promise<void> {
    if (!this.workspaceGrantRepository) {
      return;
    }
    await this.requireWorkspaceInAccount(input.accountId, input.workspaceId);
    await this.requirePermission({
      accountId: input.accountId,
      userId: input.actorUserId,
      permission: "account.membership.role.update",
      workspaceId: input.workspaceId,
    });
    if (input.userId === input.actorUserId) {
      throw conflict("Users cannot change their own workspace access");
    }
    await this.requireActiveMembership(input.accountId, input.userId);
    await this.workspaceGrantRepository.deleteByWorkspaceAndUser(input.workspaceId, input.accountId, input.userId);
    await this.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "workspace.grant.remove",
      eventStatus: "success",
      metadata: {
        actorUserId: input.actorUserId,
        userId: input.userId,
      },
    });
  }

  async requirePermission(input: {
    accountId: string;
    userId?: string | null;
    permission: AccountPermission;
    workspaceId?: string | null;
    supportImpersonationId?: string | null;
  }): Promise<void> {
    if (input.workspaceId && !(await this.workspaceBelongsToAccount(input.accountId, input.workspaceId))) {
      throw notFound("Workspace not found");
    }

    if (await this.hasPermission(input)) {
      return;
    }

    await this.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId ?? undefined,
      eventType: "authorization.permission",
      eventStatus: "failure",
      metadata: {
        userId: input.userId ?? null,
        permission: input.permission,
        supportImpersonationId: input.supportImpersonationId ?? null,
        reason: "permission_denied",
      },
    });
    throw forbidden("You do not have permission to perform this action");
  }

  async hasPermission(input: {
    accountId: string;
    userId?: string | null;
    permission: AccountPermission;
    workspaceId?: string | null;
    supportImpersonationId?: string | null;
  }): Promise<boolean> {
    if (input.supportImpersonationId) {
      return this.supportRoleAllows(input.permission);
    }
    if (!input.userId) {
      return false;
    }

    const membership = await this.findActiveMembership(input.accountId, input.userId);
    if (!membership) {
      return false;
    }

    const effectiveRole = input.workspaceId
      ? await this.resolveEffectiveWorkspaceRole(membership, input.workspaceId)
      : membership.role;
    return this.roleAllows(effectiveRole, input.permission);
  }

  private async resolveEffectiveWorkspaceRole(
    membership: AccountMembershipRecord,
    workspaceId: string,
  ): Promise<AccountMembershipRole> {
    if (!this.workspaceGrantRepository) {
      return membership.role;
    }

    const grant = await this.workspaceGrantRepository.findByWorkspaceAndUser(workspaceId, membership.userId);
    if (!grant) {
      return membership.role;
    }

    const effectiveRank = Math.max(roleRank[membership.role], grantRank[grant.role]);
    if (effectiveRank >= roleRank.owner) {
      return "owner";
    }
    if (effectiveRank >= roleRank.admin) {
      return "admin";
    }
    return "member";
  }

  private async requireWorkspaceInAccount(accountId: string, workspaceId: string): Promise<void> {
    if (!(await this.workspaceBelongsToAccount(accountId, workspaceId))) {
      throw notFound("Workspace not found");
    }
  }

  private async workspaceBelongsToAccount(accountId: string, workspaceId: string): Promise<boolean> {
    if (!this.workspaceRepository) {
      return true;
    }

    return Boolean(await this.workspaceRepository.findByIdAndAccountId(workspaceId, accountId));
  }

  private roleAllows(role: AccountMembershipRole, permission: AccountPermission): boolean {
    if (role === "owner") {
      return true;
    }

    if (role === "admin") {
      return permission !== "account.membership.remove";
    }

    return [
      "workspace.settings.manage",
      "workspace.documents.manage",
      "workspace.token.read",
    ].includes(permission);
  }

  private supportRoleAllows(permission: AccountPermission): boolean {
    return [
      "workspace.create",
      "workspace.settings.manage",
      "workspace.documents.manage",
    ].includes(permission);
  }
}
