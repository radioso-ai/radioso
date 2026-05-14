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

    await this.accountAccessService.ensureMembership({
      accountId: invitation.accountId,
      userId,
      role: invitation.role,
    });

    await this.invitationRepository.update({
      id: invitation.id,
      status: "accepted",
      acceptedAt: new Date(),
      acceptedByUserId: userId,
    });

    await this.auditService.record({
      accountId: invitation.accountId,
      eventType: "account.invitation.accept",
      eventStatus: "success",
      metadata: { email: invitation.email, userId },
    });

    return { accountId: invitation.accountId };
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
      await this.invitationRepository.update({
        id: invitation.id,
        status: "expired",
      });
      return "expired";
    }

    return "pending";
  }
}
