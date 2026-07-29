import type { Env } from "../../../app/config/env.js";
import { conflict, forbidden, serviceUnavailable, unauthorized } from "../../../shared/domain/errors.js";
import type { AccountAccessService, AccountInvitationService } from "../../account/public.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type {
  OrganizationCoreProvisioner,
  OrganizationCoreProvisioningResult,
  OrganizationCreationGuard,
  OrganizationCreationReservation,
} from "../../../shared/domain/organizationCreationGuard.js";
import { noopOrganizationCreationGuard } from "../../../shared/domain/organizationCreationGuard.js";
import type { WorkspaceService } from "../../workspace/public.js";
import type { UserRepositoryPort } from "../../../db/repositories/userRepository.js";
import {
  decryptSecret,
  encryptSecret,
  generateApiToken,
  generateSessionToken,
  hashPassword,
  deriveOrganizationName,
  normalizeEmail,
  serializeSessionCookie,
  sha256,
  tokenPrefix,
  verifyPassword,
} from "../domain/authPrimitives.js";

export interface AccountRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  accountId: string;
  sessionTokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface WorkspaceTokenRecord {
  id: string;
  workspaceId: string;
  accountId: string;
  tokenPrefix: string;
  tokenHash: string;
  encryptedToken: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type WorkspaceApiTokenPrincipal = {
  type: "workspace_api_token";
  role: "admin";
  tokenId: string;
};

export interface AccountRepositoryPort {
  create(params: { name: string; email: string; passwordHash: string }): Promise<AccountRecord>;
  findById(id: string): Promise<AccountRecord | null>;
  updateName(id: string, name: string): Promise<AccountRecord>;
  deleteById(id: string): Promise<boolean>;
}

export interface SessionRepositoryPort {
  create(params: { userId: string; accountId: string; sessionTokenHash: string; expiresAt: Date }): Promise<SessionRecord>;
  findActiveByTokenHash(sessionTokenHash: string, now: Date): Promise<SessionRecord | null>;
  touch(sessionId: string, lastSeenAt: Date): Promise<void>;
  revokeAllForUser(userId: string, revokedAt: Date): Promise<number>;
}

export interface WorkspaceTokenRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<WorkspaceTokenRecord | null>;
  findByTokenHash(tokenHash: string): Promise<WorkspaceTokenRecord | null>;
  save(params: {
    workspaceId: string;
    accountId: string;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<WorkspaceTokenRecord>;
  touch(workspaceId: string, lastUsedAt: Date): Promise<void>;
}

interface AuthServiceDependencies {
  env: Env;
  accountRepository: AccountRepositoryPort;
  userRepository: UserRepositoryPort;
  sessionRepository: SessionRepositoryPort;
  workspaceTokenRepository: WorkspaceTokenRepositoryPort;
  workspaceService: WorkspaceService;
  accountAccessService: AccountAccessService;
  accountInvitationService: AccountInvitationService;
  onAccountCreated?: (input: { accountId: string }) => Promise<void>;
  organizationCreationGuard?: OrganizationCreationGuard;
  organizationProvisioner: OrganizationCoreProvisioner;
  auditService: AuditService;
}

export class AuthService {
  constructor(private readonly dependencies: AuthServiceDependencies) {}

  async listAccessibleAccounts(userId: string): Promise<Array<{
    accountId: string;
    organizationName: string;
    role: "owner" | "admin" | "member";
    workspaceId: string;
    workspaceName: string;
    workspacePublicRouteKey: string;
  }>> {
    const memberships = await this.dependencies.accountAccessService.listUserMemberships(userId);

    return Promise.all(
      memberships.map(async (membership) => {
        const account = await this.dependencies.accountRepository.findById(membership.accountId);
        const workspace = await this.dependencies.workspaceService.resolveLoginWorkspace(membership.accountId);
        return {
          accountId: membership.accountId,
          organizationName: account?.name ?? deriveOrganizationName(account?.email ?? "organization@example.com"),
          role: membership.role,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspacePublicRouteKey: workspace.publicRouteKey,
        };
      }),
    );
  }

  async register(input: {
    email: string;
    password: string;
    organizationName?: string | null;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<{
    userId: string;
    accountId: string;
    organizationName: string;
    workspaceId: string;
    workspaceName: string;
    workspacePublicRouteKey: string;
    sessionCookie?: string;
  }> {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    let organizationCreationReservation: OrganizationCreationReservation;
    try {
      organizationCreationReservation = await (this.dependencies.organizationCreationGuard ?? noopOrganizationCreationGuard)
        .reserve({ intent: "signup" });
    } catch (error) {
      await this.recordOrganizationCreationDenied("auth.register", "registration_closed", null, error);
      throw error;
    }

    const organizationName = input.organizationName?.trim() || deriveOrganizationName(email);
    let core: OrganizationCoreProvisioningResult | null = null;
    try {
      core = await (organizationCreationReservation.coreProvisioner ?? this.dependencies.organizationProvisioner)
        .provision({
        intent: "new_user",
        organizationName,
        email,
        passwordHash,
        emailVerifiedAt: null,
      });
      await this.dependencies.onAccountCreated?.({ accountId: core.account.id });

      await this.dependencies.auditService.record({
        accountId: core.account.id,
        eventType: "auth.register",
        eventStatus: "success",
        metadata: { email },
      });
      await organizationCreationReservation.commit({ accountId: core.account.id });

      return {
        userId: core.userId,
        accountId: core.account.id,
        organizationName: core.account.name,
        workspaceId: core.workspace.id,
        workspaceName: core.workspace.name,
        workspacePublicRouteKey: core.workspace.publicRouteKey,
      };
    } catch (error) {
      try {
        await this.recordDuplicateRegistration(email, error);
        await this.recordOrganizationCreationDenied("auth.register", "registration_closed", null, error);
        if (core) {
          await this.rollbackCreatedAccount(core.account.id, core.userId);
        }
      } finally {
        await organizationCreationReservation.release();
      }
      throw error;
    }
  }

  async createOrganization(input: {
    userId: string;
    organizationName: string;
  }): Promise<{
    userId: string;
    accountId: string;
    organizationName: string;
    workspaceId: string;
    workspaceName: string;
    workspacePublicRouteKey: string;
    sessionCookie: string;
  }> {
    const user = await this.dependencies.userRepository.findById(input.userId);
    if (!user) {
      throw unauthorized("Invalid session");
    }

    let organizationCreationReservation: OrganizationCreationReservation | null = null;
    try {
      organizationCreationReservation = await (this.dependencies.organizationCreationGuard ?? noopOrganizationCreationGuard)
        .reserve({ intent: "additional", userId: user.id });
    } catch (error) {
      await this.recordOrganizationCreationDenied(
        "account.create",
        "additional_organization_not_available",
        user.id,
        error,
      );
      throw error;
    }

    let core: OrganizationCoreProvisioningResult | null = null;
    try {
      core = await (organizationCreationReservation.coreProvisioner ?? this.dependencies.organizationProvisioner)
        .provision({
        intent: "existing_user",
        userId: user.id,
        organizationName: input.organizationName.trim(),
        email: user.email,
        passwordHash: user.passwordHash,
      });
      await this.dependencies.onAccountCreated?.({ accountId: core.account.id });
      const sessionCookie = await this.createSessionCookie(user.id, core.account.id);

      await this.dependencies.auditService.record({
        accountId: core.account.id,
        eventType: "account.create",
        eventStatus: "success",
        metadata: {
          actorUserId: user.id,
          organizationName: core.account.name,
        },
      });
      await organizationCreationReservation.commit({ accountId: core.account.id });

      return {
        userId: user.id,
        accountId: core.account.id,
        organizationName: core.account.name,
        workspaceId: core.workspace.id,
        workspaceName: core.workspace.name,
        workspacePublicRouteKey: core.workspace.publicRouteKey,
        sessionCookie,
      };
    } catch (error) {
      try {
        if (core) {
          await this.rollbackCreatedAccount(core.account.id);
        }
      } finally {
        await organizationCreationReservation.release();
      }
      throw error;
    }
  }

  private async recordOrganizationCreationDenied(
    eventType: "auth.register" | "auth.federated_login" | "account.create",
    forbiddenReason: "registration_closed" | "additional_organization_not_available",
    userId: string | null,
    error: unknown,
  ): Promise<void> {
    const candidate = error as { statusCode?: number; code?: string; details?: unknown };
    const rateLimited = candidate.statusCode === 429 || candidate.code === "rate_limit_exceeded";
    const forbidden = candidate.statusCode === 403 || candidate.code === "forbidden";
    if (!rateLimited && !forbidden) {
      return;
    }

    const details = candidate.details as Partial<{
      limit: number;
      used: number;
      periodStart: string;
      resetAt: string;
    }> | undefined;
    const safeRateLimit = rateLimited && details
      ? {
          limit: details.limit,
          used: details.used,
          periodStart: details.periodStart,
          resetAt: details.resetAt,
        }
      : null;

    await this.dependencies.auditService.record({
      eventType,
      eventStatus: "failure",
      metadata: {
        ...(userId ? { actorUserId: userId } : {}),
        reason: rateLimited ? "rate_limited" : forbiddenReason,
        ...(safeRateLimit ? { rateLimit: safeRateLimit } : {}),
      },
    });
  }

  private async recordDuplicateRegistration(email: string, error: unknown): Promise<void> {
    const candidate = error as { statusCode?: number; code?: string };
    if (candidate.statusCode !== 409 && candidate.code !== "conflict") return;

    await this.dependencies.auditService.record({
      eventType: "auth.register",
      eventStatus: "failure",
      metadata: { email },
    });
  }

  async login(input: {
    email: string;
    password: string;
    preferredWorkspaceId?: string | null;
    preferredAccountId?: string | null;
  }): Promise<{
    userId: string;
    accountId: string;
    organizationName: string;
    workspaceId: string;
    workspaceName: string;
    workspacePublicRouteKey: string;
    sessionCookie: string;
  }> {
    const email = normalizeEmail(input.email);
    const user = await this.dependencies.userRepository.findByEmail(email);

    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      await this.dependencies.auditService.record({
        eventType: "auth.login",
        eventStatus: "failure",
        metadata: { email },
      });
      throw unauthorized("Invalid email or password");
    }

    if (!user.emailVerifiedAt) {
      await this.dependencies.auditService.record({
        eventType: "auth.login",
        eventStatus: "failure",
        metadata: { email, reason: "email_unverified" },
      });
      throw forbidden("Email verification required");
    }

    const membership = await this.dependencies.accountAccessService.resolveLoginAccount(user.id, input.preferredAccountId);
    const workspace = await this.dependencies.workspaceService.resolveLoginWorkspace(
      membership.accountId,
      input.preferredWorkspaceId,
    );
    const sessionCookie = await this.createSessionCookie(user.id, membership.accountId);
    await this.dependencies.auditService.record({
      accountId: membership.accountId,
      eventType: "auth.login",
      eventStatus: "success",
      metadata: { email },
    });

    return {
      userId: user.id,
      accountId: membership.accountId,
      organizationName: (await this.dependencies.accountRepository.findById(membership.accountId))?.name
        ?? deriveOrganizationName(email),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePublicRouteKey: workspace.publicRouteKey,
      sessionCookie,
    };
  }

  /**
   * Logs a user in from a provider-verified identity assertion (e.g. Google
   * OAuth), provisioning a fresh account + workspace on first sign-in. This is
   * provider-agnostic: callers translate their provider's response into the
   * shared assertion shape, so this service never learns about Google et al.
   *
   * Linking is by verified email. An existing user (verified or not) is logged
   * in and, if needed, marked verified — the provider has proven control of the
   * mailbox. The provider `subject` is recorded in the audit trail only; we do
   * not yet keep a federated-identity link table.
   */
  async federatedLogin(input: {
    provider: string;
    subject: string;
    email: string;
    emailVerified: boolean;
  }): Promise<{
    userId: string;
    accountId: string;
    organizationName: string;
    workspaceId: string;
    workspaceName: string;
    workspacePublicRouteKey: string;
    sessionCookie: string;
  }> {
    const email = normalizeEmail(input.email);

    if (!input.emailVerified) {
      await this.dependencies.auditService.record({
        eventType: "auth.federated_login",
        eventStatus: "failure",
        metadata: { email, provider: input.provider, reason: "email_unverified" },
      });
      throw unauthorized("Email not verified by the identity provider");
    }

    const existing = await this.dependencies.userRepository.findByEmail(email);
    if (existing) {
      if (!existing.emailVerifiedAt) {
        // The account was created by password registration but never verified,
        // so its password was set by whoever registered it — not necessarily
        // the mailbox owner. The provider has now proven ownership, so treat
        // this exactly like a password reset: rotate the (possibly attacker-set)
        // password to an unusable hash and drop any existing sessions before
        // verifying and issuing a new one. Without this, a pre-verification
        // squatter keeps a working password into the now-verified account.
        await this.dependencies.userRepository.updatePassword(existing.id, await hashPassword(generateSessionToken()));
        await this.dependencies.sessionRepository.revokeAllForUser(existing.id, new Date());
        await this.dependencies.userRepository.markEmailVerified(existing.id, new Date());
      }

      const membership = await this.dependencies.accountAccessService.resolveLoginAccount(existing.id);
      const workspace = await this.dependencies.workspaceService.resolveLoginWorkspace(membership.accountId);
      const sessionCookie = await this.createSessionCookie(existing.id, membership.accountId);

      await this.dependencies.auditService.record({
        accountId: membership.accountId,
        eventType: "auth.federated_login",
        eventStatus: "success",
        metadata: { email, provider: input.provider, subject: input.subject, provisioned: false },
      });

      return {
        userId: existing.id,
        accountId: membership.accountId,
        organizationName: (await this.dependencies.accountRepository.findById(membership.accountId))?.name
          ?? deriveOrganizationName(email),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspacePublicRouteKey: workspace.publicRouteKey,
        sessionCookie,
      };
    }

    return this.provisionFederatedAccount({ ...input, email });
  }

  private async provisionFederatedAccount(input: {
    provider: string;
    subject: string;
    email: string;
  }): Promise<{
    userId: string;
    accountId: string;
    organizationName: string;
    workspaceId: string;
    workspaceName: string;
    workspacePublicRouteKey: string;
    sessionCookie: string;
  }> {
    // Federated users have no password. Store a random, unusable hash so the
    // NOT NULL column is satisfied; they can adopt password login later via the
    // reset flow. The email is verified by the provider, so mark it verified.
    const passwordHash = await hashPassword(generateSessionToken());
    const organizationName = deriveOrganizationName(input.email);
    let organizationCreationReservation: OrganizationCreationReservation;
    try {
      organizationCreationReservation = await (this.dependencies.organizationCreationGuard ?? noopOrganizationCreationGuard)
        .reserve({ intent: "signup" });
    } catch (error) {
      await this.recordOrganizationCreationDenied("auth.federated_login", "registration_closed", null, error);
      throw error;
    }

    let core: OrganizationCoreProvisioningResult | null = null;
    try {
      core = await (organizationCreationReservation.coreProvisioner ?? this.dependencies.organizationProvisioner)
        .provision({
        intent: "new_user",
        organizationName,
        email: input.email,
        passwordHash,
        emailVerifiedAt: new Date(),
      });
      await this.dependencies.onAccountCreated?.({ accountId: core.account.id });
      const sessionCookie = await this.createSessionCookie(core.userId, core.account.id);

      await this.dependencies.auditService.record({
        accountId: core.account.id,
        eventType: "auth.federated_login",
        eventStatus: "success",
        metadata: { email: input.email, provider: input.provider, subject: input.subject, provisioned: true },
      });
      await organizationCreationReservation.commit({ accountId: core.account.id });

      return {
        userId: core.userId,
        accountId: core.account.id,
        organizationName: core.account.name,
        workspaceId: core.workspace.id,
        workspaceName: core.workspace.name,
        workspacePublicRouteKey: core.workspace.publicRouteKey,
        sessionCookie,
      };
    } catch (error) {
      try {
        await this.recordOrganizationCreationDenied("auth.federated_login", "registration_closed", null, error);
        if (core) {
          await this.rollbackCreatedAccount(core.account.id, core.userId);
        }
      } finally {
        await organizationCreationReservation.release();
      }
      throw error;
    }
  }

  async getInvitation(input: { invitationToken: string }): Promise<{
    accountId: string;
    email: string;
    status: "pending" | "accepted" | "revoked" | "expired";
    expiresAt: string;
  }> {
    return this.dependencies.accountInvitationService.getInvitation(input.invitationToken);
  }

  async acceptInvitation(input: {
    invitationToken: string;
    email: string;
    password: string;
  }): Promise<{
    userId: string;
    accountId: string;
    organizationName: string;
    workspaceId: string;
    workspaceName: string;
    workspacePublicRouteKey: string;
    sessionCookie: string;
  }> {
    const email = normalizeEmail(input.email);
    const invitation = await this.dependencies.accountInvitationService.getInvitation(input.invitationToken);
    if (invitation.email !== email) {
      await this.dependencies.auditService.record({
        accountId: invitation.accountId,
        eventType: "account.invitation.accept",
        eventStatus: "failure",
        metadata: { email, reason: "email_mismatch" },
      });
      throw unauthorized("Invitation email does not match");
    }

    const existingUser = await this.dependencies.userRepository.findByEmail(email);

    if (existingUser) {
      const passwordValid = await verifyPassword(input.password, existingUser.passwordHash);
      if (!passwordValid) {
        await this.dependencies.auditService.record({
          accountId: invitation.accountId,
          eventType: "account.invitation.accept",
          eventStatus: "failure",
          metadata: { email, reason: "invalid_password" },
        });
        throw unauthorized("Invalid email or password");
      }
    }

    const user = existingUser
      ? existingUser
      : await this.dependencies.userRepository.create({
          email,
          passwordHash: await hashPassword(input.password),
          emailVerifiedAt: null,
        });

    const createdUserId: string | null = existingUser ? null : user.id;

    let accountId: string;
    try {
      ({ accountId } = await this.dependencies.accountInvitationService.acceptInvitation(
        input.invitationToken,
        user.id,
      ));
      await this.dependencies.userRepository.markEmailVerified(user.id, new Date());
    } catch (error) {
      if (createdUserId) {
        await this.dependencies.userRepository.deleteById(createdUserId);
      }
      throw error;
    }

    try {
      const account = await this.dependencies.accountRepository.findById(accountId);
      const workspace = await this.dependencies.workspaceService.resolveLoginWorkspace(accountId);
      const sessionCookie = await this.createSessionCookie(user.id, accountId);

      return {
        userId: user.id,
        accountId,
        organizationName: account?.name ?? deriveOrganizationName(email),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspacePublicRouteKey: workspace.publicRouteKey,
        sessionCookie,
      };
    } catch (error) {
      await this.dependencies.accountInvitationService.revertAcceptance(input.invitationToken, user.id);
      if (createdUserId) {
        await this.dependencies.userRepository.deleteById(createdUserId);
      }
      throw error;
    }
  }

  async switchAccount(input: {
    userId: string;
    targetAccountId: string;
    preferredWorkspaceId?: string | null;
  }): Promise<{
    userId: string;
    accountId: string;
    organizationName: string;
    workspaceId: string;
    workspaceName: string;
    workspacePublicRouteKey: string;
    sessionCookie: string;
  }> {
    const membership = await this.dependencies.accountAccessService.requireActiveMembership(
      input.targetAccountId,
      input.userId,
    );
    const account = await this.dependencies.accountRepository.findById(membership.accountId);
    const workspace = await this.dependencies.workspaceService.resolveLoginWorkspace(
      membership.accountId,
      input.preferredWorkspaceId,
    );
    const sessionCookie = await this.createSessionCookie(input.userId, membership.accountId);

    await this.dependencies.auditService.record({
      accountId: membership.accountId,
      workspaceId: workspace.id,
      eventType: "auth.account.switch",
      eventStatus: "success",
      metadata: { userId: input.userId },
    });

    return {
      userId: input.userId,
      accountId: membership.accountId,
      organizationName: account?.name ?? deriveOrganizationName(account?.email ?? "organization@example.com"),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePublicRouteKey: workspace.publicRouteKey,
      sessionCookie,
    };
  }

  async deleteOrganization(input: {
    accountId: string;
    userId: string;
  }): Promise<{ accountId: string }> {
    const membership = await this.dependencies.accountAccessService.requireActiveMembership(
      input.accountId,
      input.userId,
    );
    if (membership.role !== "owner") {
      await this.dependencies.auditService.record({
        accountId: input.accountId,
        eventType: "account.delete",
        eventStatus: "failure",
        metadata: {
          actorUserId: input.userId,
          reason: "not_owner",
        },
      });
      throw forbidden("Only the organization owner can delete the organization");
    }

    const account = await this.dependencies.accountRepository.findById(input.accountId);
    const deleted = await this.dependencies.accountRepository.deleteById(input.accountId);
    if (!deleted) {
      throw conflict("Organization could not be deleted");
    }

    await this.dependencies.auditService.record({
      accountId: input.accountId,
      eventType: "account.delete",
      eventStatus: "success",
      metadata: {
        actorUserId: input.userId,
        organizationName: account?.name ?? null,
      },
    });

    return { accountId: input.accountId };
  }

  async renameOrganization(input: {
    accountId: string;
    userId: string;
    organizationName: string;
  }): Promise<{ accountId: string; organizationName: string }> {
    await this.dependencies.accountAccessService.requireActiveMembership(input.accountId, input.userId);
    const account = await this.dependencies.accountRepository.updateName(input.accountId, input.organizationName.trim());

    await this.dependencies.auditService.record({
      accountId: account.id,
      eventType: "account.update",
      eventStatus: "success",
      metadata: {
        actorUserId: input.userId,
        organizationName: account.name,
      },
    });

    return {
      accountId: account.id,
      organizationName: account.name,
    };
  }

  async authenticateSession(sessionToken: string): Promise<{ userId: string; accountId: string; sessionId: string }> {
    const tokenHash = sha256(sessionToken);
    const session = await this.dependencies.sessionRepository.findActiveByTokenHash(tokenHash, new Date());

    if (!session) {
      throw unauthorized();
    }

    await this.dependencies.sessionRepository.touch(session.id, new Date());
    return { userId: session.userId, accountId: session.accountId, sessionId: session.id };
  }

  async getTokenForWorkspace(workspaceId: string, accountId: string): Promise<{ token: string }> {
    await this.dependencies.workspaceService.validateOwnership(workspaceId, accountId);
    const workspaceTokenSecret = this.getWorkspaceTokenSecret();

    const existing = await this.dependencies.workspaceTokenRepository.findByWorkspaceId(workspaceId);

    if (existing) {
      try {
        const token = decryptSecret(existing.encryptedToken, workspaceTokenSecret);
        await this.dependencies.workspaceTokenRepository.touch(workspaceId, new Date());
        await this.dependencies.auditService.record({
          accountId,
          workspaceId,
          eventType: "auth.token.read",
          eventStatus: "success",
        });
        return { token };
      } catch {
        await this.dependencies.auditService.record({
          accountId,
          workspaceId,
          eventType: "auth.token.read",
          eventStatus: "failure",
          metadata: { reason: "decrypt_failed" },
        });
      }
    }

    return this.issueWorkspaceToken(workspaceId, accountId);
  }

  async rotateTokenForWorkspace(workspaceId: string, accountId: string): Promise<{ token: string }> {
    await this.dependencies.workspaceService.validateOwnership(workspaceId, accountId);
    const token = await this.issueWorkspaceToken(workspaceId, accountId);

    await this.dependencies.auditService.record({
      accountId,
      workspaceId,
      eventType: "auth.token.rotate",
      eventStatus: "success",
    });

    return token;
  }

  async authenticateApiToken(token: string): Promise<{
    workspaceId: string;
    accountId: string;
    principal: WorkspaceApiTokenPrincipal;
  }> {
    const tokenHash = sha256(token);
    const workspaceToken = await this.dependencies.workspaceTokenRepository.findByTokenHash(tokenHash);

    if (!workspaceToken) {
      throw unauthorized();
    }

    await this.dependencies.workspaceTokenRepository.touch(workspaceToken.workspaceId, new Date());
    return {
      workspaceId: workspaceToken.workspaceId,
      accountId: workspaceToken.accountId,
      principal: {
        type: "workspace_api_token",
        role: "admin",
        tokenId: workspaceToken.id,
      },
    };
  }

  private async issueWorkspaceToken(workspaceId: string, accountId: string): Promise<{ token: string }> {
    const workspaceTokenSecret = this.getWorkspaceTokenSecret();
    const token = generateApiToken();
    await this.dependencies.workspaceTokenRepository.save({
      workspaceId,
      accountId,
      tokenPrefix: tokenPrefix(),
      tokenHash: sha256(token),
      encryptedToken: encryptSecret(token, workspaceTokenSecret),
    });

    await this.dependencies.auditService.record({
      accountId,
      workspaceId,
      eventType: "auth.token.create",
      eventStatus: "success",
    });

    return { token };
  }

  private async createSessionCookie(userId: string, accountId: string): Promise<string> {
    const sessionToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + this.dependencies.env.SESSION_TTL_HOURS * 60 * 60 * 1000);

    await this.dependencies.sessionRepository.create({
      userId,
      accountId,
      sessionTokenHash: sha256(sessionToken),
      expiresAt,
    });

    return serializeSessionCookie(sessionToken, this.dependencies.env);
  }

  private getWorkspaceTokenSecret(): string {
    const secret = this.dependencies.env.WORKSPACE_TOKEN_SECRET;
    if (!secret) {
      throw serviceUnavailable("Workspace token operations are not configured.", {
        missingEnv: "WORKSPACE_TOKEN_SECRET",
      });
    }

    return secret;
  }

  private async rollbackCreatedAccount(accountId: string, createdUserId?: string): Promise<void> {
    await this.dependencies.accountRepository.deleteById(accountId);
    if (createdUserId) {
      await this.dependencies.userRepository.deleteById(createdUserId);
    }
  }

  async isRegistrationAvailable(): Promise<boolean> {
    return (this.dependencies.organizationCreationGuard ?? noopOrganizationCreationGuard).isSignupAvailable();
  }
}
