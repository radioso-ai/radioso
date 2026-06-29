import { randomBytes } from "node:crypto";

import { conflict, notFound } from "../../../shared/domain/errors.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { UserRepositoryPort } from "../../../db/repositories/userRepository.js";
import type {
  AccountInvitationRecord,
  AccountInvitationRole,
  AccountInvitationRepositoryPort,
  AccountInvitationStatus,
} from "../../../db/repositories/accountInvitationRepository.js";
import { normalizeEmail, sha256 } from "../../auth/contracts/index.js";
import { AccountAccessService } from "./accountAccessService.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AccountInvitationSummary {
  id: string;
  email: string;
  status: AccountInvitationStatus;
  expiresAt: string;
  acceptedAt: string | null;
  role: AccountInvitationRole;
  createdAt: string;
}

const serializeInvitation = (
  invitation: AccountInvitationRecord,
  status: AccountInvitationStatus,
): AccountInvitationSummary => ({
  id: invitation.id,
  email: invitation.email,
  status,
  expiresAt: invitation.expiresAt.toISOString(),
  acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
  role: invitation.role,
  createdAt: invitation.createdAt.toISOString(),
});

export class AccountInvitationService {
  constructor(
    private readonly invitationRepository: AccountInvitationRepositoryPort,
    private readonly userRepository: UserRepositoryPort,
    private readonly accountAccessService: AccountAccessService,
    private readonly auditService: AuditService,
  ) {}

  async listForAccount(accountId: string): Promise<AccountInvitationSummary[]> {
    const invitations = await this.invitationRepository.listByAccount(accountId);
    return Promise.all(
      invitations.map(async (invitation) => serializeInvitation(invitation, await this.resolveStatus(invitation))),
    );
  }

  async createInvitation(input: {
    accountId: string;
    invitedByUserId: string;
    email: string;
    role?: AccountInvitationRole;
  }): Promise<AccountInvitationSummary & { acceptanceUrl: string }> {
    const membership = await this.accountAccessService.requireActiveMembership(input.accountId, input.invitedByUserId);
    await this.accountAccessService.requirePermission({
      accountId: input.accountId,
      userId: input.invitedByUserId,
      permission: "account.users.manage",
    });
    const email = normalizeEmail(input.email);
    const existingUser = await this.userRepository.findByEmail(email);

    if (existingUser) {
      const existingMembership = await this.accountAccessService.findActiveMembership(input.accountId, existingUser.id);
      if (existingMembership) {
        await this.auditService.record({
          accountId: input.accountId,
          eventType: "account.invitation.create",
          eventStatus: "failure",
          metadata: { email, reason: "user_already_has_access" },
        });
        throw conflict("User already has access");
      }
    }

    const pending = await this.invitationRepository.findPendingByAccountAndEmail(input.accountId, email);
    if (pending && (await this.resolveStatus(pending)) === "pending") {
      await this.auditService.record({
        accountId: input.accountId,
        eventType: "account.invitation.create",
        eventStatus: "failure",
        metadata: { email, reason: "invitation_already_pending" },
      });
      throw conflict("Invitation already pending");
    }

    const invitationToken = randomBytes(24).toString("hex");
    const invitation = await this.invitationRepository.create({
      accountId: input.accountId,
      email,
      invitedByMembershipId: membership.id,
      tokenHash: sha256(invitationToken),
      role: input.role ?? "member",
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    });

    await this.auditService.record({
      accountId: input.accountId,
      eventType: "account.invitation.create",
      eventStatus: "success",
      metadata: { email },
    });

    return {
      ...serializeInvitation(invitation, "pending"),
      acceptanceUrl: `/invite/${invitationToken}`,
    };
  }

  async revokeInvitation(input: {
    accountId: string;
    actorUserId: string;
    invitationId: string;
  }): Promise<void> {
    await this.accountAccessService.requirePermission({
      accountId: input.accountId,
      userId: input.actorUserId,
      permission: "account.users.manage",
    });

    const invitation = await this.invitationRepository.findById(input.invitationId);
    if (!invitation || invitation.accountId !== input.accountId) {
      throw notFound("Invitation not found");
    }

    const status = await this.resolveStatus(invitation);
    if (status === "accepted") {
      return this.rejectAcceptedRevocation(input.accountId, invitation.email);
    }

    if (status === "pending") {
      const revoked = await this.invitationRepository.updateIfStatus({
        id: invitation.id,
        currentStatus: "pending",
        status: "revoked",
      });
      if (!revoked) {
        await this.handleRevocationRace(input.accountId, invitation.id);
      }
    } else if (status !== "revoked") {
      await this.invitationRepository.update({ id: invitation.id, status: "revoked" });
    }

    await this.auditService.record({
      accountId: input.accountId,
      eventType: "account.invitation.revoke",
      eventStatus: "success",
      metadata: { email: invitation.email },
    });
  }

  async getInvitation(token: string): Promise<{
    accountId: string;
    email: string;
    status: AccountInvitationStatus;
    expiresAt: string;
  }> {
    const invitation = await this.requireInvitation(token);
    const status = await this.resolveStatus(invitation);
    return {
      accountId: invitation.accountId,
      email: invitation.email,
      status,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async acceptInvitation(token: string, userId: string): Promise<{ accountId: string }> {
    const invitation = await this.requireInvitation(token);
    const status = await this.resolveStatus(invitation);

    if (status !== "pending") {
      await this.auditService.record({
        accountId: invitation.accountId,
        eventType: "account.invitation.accept",
        eventStatus: "failure",
        metadata: { email: invitation.email, userId, reason: `invitation_${status}` },
      });
      throw conflict("Invitation is no longer valid");
    }

    const accepted = await this.invitationRepository.updateIfStatus({
      id: invitation.id,
      currentStatus: "pending",
      status: "accepted",
      acceptedAt: new Date(),
      acceptedByUserId: userId,
    });
    if (!accepted) {
      return this.rejectInvalidAcceptance(invitation.id, userId);
    }

    try {
      await this.accountAccessService.ensureMembership({
        accountId: accepted.accountId,
        userId,
        role: accepted.role,
      });
    } catch (error) {
      await this.invitationRepository.update({
        id: accepted.id,
        status: "pending",
        acceptedAt: null,
        acceptedByUserId: null,
      });
      throw error;
    }

    await this.auditService.record({
      accountId: accepted.accountId,
      eventType: "account.invitation.accept",
      eventStatus: "success",
      metadata: { email: accepted.email, userId },
    });

    return { accountId: accepted.accountId };
  }

  async revertAcceptance(token: string, userId: string): Promise<void> {
    const invitation = await this.requireInvitation(token);
    if (invitation.status !== "accepted" || invitation.acceptedByUserId !== userId) {
      return;
    }

    await this.accountAccessService.removeMembershipIfExists(invitation.accountId, userId);
    await this.invitationRepository.update({
      id: invitation.id,
      status: "pending",
      acceptedAt: null,
      acceptedByUserId: null,
    });
  }

  private async requireInvitation(token: string): Promise<AccountInvitationRecord> {
    const invitation = await this.invitationRepository.findByTokenHash(sha256(token));
    if (!invitation) {
      throw notFound("Invitation not found");
    }

    return invitation;
  }

  private async resolveStatus(invitation: AccountInvitationRecord): Promise<AccountInvitationStatus> {
    if (invitation.status !== "pending") {
      return invitation.status;
    }

    if (invitation.expiresAt.getTime() <= Date.now()) {
      const expired = await this.invitationRepository.updateIfStatus({
        id: invitation.id,
        currentStatus: "pending",
        status: "expired",
      });
      if (expired) {
        return "expired";
      }

      const current = await this.invitationRepository.findById(invitation.id);
      return current?.status ?? "expired";
    }

    return "pending";
  }

  private async handleRevocationRace(accountId: string, invitationId: string): Promise<void> {
    const current = await this.invitationRepository.findById(invitationId);
    if (!current || current.accountId !== accountId) {
      throw notFound("Invitation not found");
    }

    const status = await this.resolveStatus(current);
    if (status === "accepted") {
      return this.rejectAcceptedRevocation(accountId, current.email);
    }

    if (status === "revoked") {
      return;
    }

    const revoked = await this.invitationRepository.updateIfStatus({
      id: current.id,
      currentStatus: status,
      status: "revoked",
    });
    if (!revoked) {
      throw conflict("Invitation state changed while revoking");
    }
  }

  private async rejectAcceptedRevocation(accountId: string, email: string): Promise<never> {
    await this.auditService.record({
      accountId,
      eventType: "account.invitation.revoke",
      eventStatus: "failure",
      metadata: { email, reason: "invitation_already_accepted" },
    });
    throw conflict("Invitation has already been accepted");
  }

  private async rejectInvalidAcceptance(invitationId: string, userId: string): Promise<never> {
    const current = await this.invitationRepository.findById(invitationId);
    if (!current) {
      throw notFound("Invitation not found");
    }

    const status = await this.resolveStatus(current);
    await this.auditService.record({
      accountId: current.accountId,
      eventType: "account.invitation.accept",
      eventStatus: "failure",
      metadata: { email: current.email, userId, reason: `invitation_${status}` },
    });
    throw conflict("Invitation is no longer valid");
  }
}
