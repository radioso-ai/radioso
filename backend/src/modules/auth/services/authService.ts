import type { Env } from "../../../app/config/env.js";
import { conflict, forbidden, unauthorized } from "../../../shared/domain/errors.js";
import type { AccountAccessService, AccountInvitationService, AuthenticatedPrincipal } from "../../account/public.js";
import {
  transactionalLifecycleAuditEvent,
  type ApiPrincipalAuthenticator,
  type PersonalCredentialLifecyclePort,
  type PersonalCredentialTenureService,
} from "../../machineAccess/public.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { ProductAnalyticsPort } from "../../../shared/analytics/productAnalyticsService.js";
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
  generateSessionToken,
  hashPassword,
  deriveOrganizationName,
  normalizeEmail,
  serializeSessionCookie,
  sha256,
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


/** A signed-in principal plus the account and workspace the session lands on. */
export interface AuthenticatedAccountSession {
  userId: string;
  accountId: string;
  organizationName: string;
  workspaceId: string;
  workspaceName: string;
  workspacePublicRouteKey: string;
  sessionCookie: string;
}

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

/** A login this user holds at an external identity provider. */
export interface FederatedIdentityRecord {
  userId: string;
  provider: string;
  subject: string;
  providerEmail: string;
  lastAuthenticatedAt: Date;
}

export interface FederatedIdentityRepositoryPort {
  findByProviderSubject(provider: string, subject: string): Promise<FederatedIdentityRecord | null>;
  listForUser(userId: string): Promise<FederatedIdentityRecord[]>;
  /** Links the provider identity to the user, refreshing an existing link. */
  link(params: {
    userId: string;
    provider: string;
    subject: string;
    providerEmail: string;
    authenticatedAt: Date;
  }): Promise<FederatedIdentityRecord>;
  /** Drops every provider link a user holds. Returns how many were removed. */
  deleteForUser(userId: string): Promise<number>;
}

interface AuthServiceDependencies {
  env: Env;
  accountRepository: AccountRepositoryPort;
  userRepository: UserRepositoryPort;
  sessionRepository: SessionRepositoryPort;
  federatedIdentityRepository: FederatedIdentityRepositoryPort;
  workspaceService: WorkspaceService;
  accountAccessService: AccountAccessService;
  accountInvitationService: AccountInvitationService;
  onAccountCreated?: (input: { accountId: string }) => Promise<void>;
  organizationCreationGuard?: OrganizationCreationGuard;
  organizationProvisioner: OrganizationCoreProvisioner;
  auditService: AuditService;
  productAnalytics?: ProductAnalyticsPort;
  apiPrincipalAuthenticator?: Pick<ApiPrincipalAuthenticator, "authenticate"> & Partial<Pick<ApiPrincipalAuthenticator, "recordSuccessfulUse">>;
  personalCredentialTermination?: Pick<PersonalCredentialTenureService, "endAccount">;
  personalCredentialLifecycle?: Pick<PersonalCredentialLifecyclePort, "deleteAccount">;
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
    requiresEmailVerification: boolean;
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
    const autoVerifyEmail = this.dependencies.env.NODE_ENV === "development"
      && this.dependencies.env.AUTH_AUTO_VERIFY_EMAIL;
    let core: OrganizationCoreProvisioningResult | null = null;
    try {
      core = await (organizationCreationReservation.coreProvisioner ?? this.dependencies.organizationProvisioner)
        .provision({
        intent: "new_user",
        organizationName,
        email,
        passwordHash,
        emailVerifiedAt: autoVerifyEmail ? new Date() : null,
      });
      await this.dependencies.onAccountCreated?.({ accountId: core.account.id });
      const sessionCookie = autoVerifyEmail
        ? await this.createSessionCookie(core.userId, core.account.id)
        : undefined;

      await this.dependencies.auditService.record({
        accountId: core.account.id,
        eventType: "auth.register",
        eventStatus: "success",
        metadata: {
          email,
          verificationMode: autoVerifyEmail ? "development_auto_verify" : "email_verification",
        },
      });
      await organizationCreationReservation.commit({ accountId: core.account.id });
      await this.trackRegistration({
        accountId: core.account.id,
        workspaceId: core.workspace.id,
        requiresEmailVerification: !autoVerifyEmail,
      });

      return {
        userId: core.userId,
        accountId: core.account.id,
        organizationName: core.account.name,
        workspaceId: core.workspace.id,
        workspaceName: core.workspace.name,
        workspacePublicRouteKey: core.workspace.publicRouteKey,
        requiresEmailVerification: !autoVerifyEmail,
        ...(sessionCookie ? { sessionCookie } : {}),
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

  private async trackRegistration(input: {
    accountId: string;
    workspaceId: string;
    requiresEmailVerification: boolean;
  }): Promise<void> {
    try {
      await this.dependencies.productAnalytics?.track({
        eventName: "account.registered",
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        actorType: "authenticated_user",
        subjectType: "workspace",
        subjectId: input.workspaceId,
        properties: { requiresEmailVerification: input.requiresEmailVerification },
      });
    } catch {
      // The registration already succeeded and is recorded in the audit log. A failing
      // reporting path must not roll it back or surface as a signup error.
    }
  }

  async createOrganization(input: {
    userId: string;
    organizationName: string;
  }): Promise<AuthenticatedAccountSession> {
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
  }): Promise<AuthenticatedAccountSession> {
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
   * The provider `subject` is the identifier of record — it is stable for the
   * life of the provider account, while the address on it can be reassigned.
   * A known subject therefore wins over the email, which keeps someone whose
   * work address changed in the account they already have. The email links a
   * subject the first time it is seen, and an existing user (verified or not)
   * is marked verified, since the provider has proven control of the mailbox.
   */
  async federatedLogin(input: {
    provider: string;
    subject: string;
    email: string;
    emailVerified: boolean;
  }): Promise<AuthenticatedAccountSession> {
    const email = normalizeEmail(input.email);

    if (!input.emailVerified) {
      await this.dependencies.auditService.record({
        eventType: "auth.federated_login",
        eventStatus: "failure",
        metadata: { email, provider: input.provider, reason: "email_unverified" },
      });
      throw unauthorized("Email not verified by the identity provider");
    }

    const linked = await this.dependencies.federatedIdentityRepository
      .findByProviderSubject(input.provider, input.subject);
    const existing = linked
      ? await this.dependencies.userRepository.findById(linked.userId)
      : await this.dependencies.userRepository.findByEmail(email);

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

      // The provider's current address is kept on the link, not written back
      // onto the user: a reassigned address could already belong to another
      // user, and rewriting the login email would move an account behind the
      // owner's back.
      await this.recordFederatedIdentityLink({
        userId: existing.id,
        provider: input.provider,
        subject: input.subject,
        email,
      });

      const membership = await this.dependencies.accountAccessService.resolveLoginAccount(existing.id);
      const workspace = await this.dependencies.workspaceService.resolveLoginWorkspace(membership.accountId);
      const sessionCookie = await this.createSessionCookie(existing.id, membership.accountId);

      await this.dependencies.auditService.record({
        accountId: membership.accountId,
        eventType: "auth.federated_login",
        eventStatus: "success",
        metadata: {
          email,
          provider: input.provider,
          subject: input.subject,
          provisioned: false,
          matchedBy: linked ? "subject" : "email",
        },
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

  /**
   * Writes the provider link that later sign-ins match on. It sits on the
   * critical path deliberately — skipping it would silently degrade every
   * subsequent login back to email matching — so a failure is named rather than
   * left to surface as the caller's generic OAuth error.
   */
  private async recordFederatedIdentityLink(input: {
    userId: string;
    provider: string;
    subject: string;
    email: string;
  }): Promise<void> {
    try {
      await this.dependencies.federatedIdentityRepository.link({
        userId: input.userId,
        provider: input.provider,
        subject: input.subject,
        providerEmail: input.email,
        authenticatedAt: new Date(),
      });
    } catch (error) {
      await this.dependencies.auditService.record({
        eventType: "auth.federated_login",
        eventStatus: "failure",
        metadata: {
          email: input.email,
          provider: input.provider,
          subject: input.subject,
          reason: "identity_link_write_failed",
        },
      });
      throw error;
    }
  }

  private async provisionFederatedAccount(input: {
    provider: string;
    subject: string;
    email: string;
  }): Promise<AuthenticatedAccountSession> {
    // Federated users have no password. Store a random, unusable hash so the
    // NOT NULL column is satisfied; they can adopt password login later via the
    // reset flow, and the identity link below is what records that the provider
    // is how they get in. The email is verified by the provider, so mark it
    // verified.
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
      await this.recordFederatedIdentityLink({
        userId: core.userId,
        provider: input.provider,
        subject: input.subject,
        email: input.email,
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
      await this.trackRegistration({
        accountId: core.account.id,
        workspaceId: core.workspace.id,
        requiresEmailVerification: false,
      });

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

  /**
   * Describes the account context of an existing session. The session cookie is
   * the only durable record that someone is signed in — a browser that arrives
   * with one but no client-side state (a fresh tab, or the return leg of a
   * provider redirect, which sets the cookie and nothing else) needs this to
   * recover who it is without asking for a credential it may not have.
   */
  async describeSession(input: {
    userId: string;
    accountId: string;
  }): Promise<Omit<AuthenticatedAccountSession, "sessionCookie"> & { email: string }> {
    const user = await this.dependencies.userRepository.findById(input.userId);
    if (!user) {
      throw unauthorized();
    }

    const membership = await this.dependencies.accountAccessService.resolveLoginAccount(
      input.userId,
      input.accountId,
    );
    const account = await this.dependencies.accountRepository.findById(membership.accountId);
    const workspace = await this.dependencies.workspaceService.resolveLoginWorkspace(membership.accountId);

    return {
      userId: user.id,
      email: user.email,
      accountId: membership.accountId,
      organizationName: account?.name ?? deriveOrganizationName(user.email),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePublicRouteKey: workspace.publicRouteKey,
    };
  }

  /**
   * Describes the invitation and, with it, how the invitee can actually get in.
   * The credential half lives here rather than in the invitation service: an
   * invitation knows nothing about logins, while auth knows that an existing
   * user turns the join form into a credential check, and that a linked
   * provider is a way in that needs no password at all. Disclosing both to the
   * holder of the token is safe — it was minted for this one mailbox.
   */
  async getInvitation(input: { invitationToken: string }): Promise<{
    accountId: string;
    email: string;
    status: "pending" | "accepted" | "revoked" | "expired";
    expiresAt: string;
    requiresExistingPassword: boolean;
    federatedProviders: string[];
  }> {
    const invitation = await this.dependencies.accountInvitationService.getInvitation(input.invitationToken);
    const existingUser = await this.dependencies.userRepository.findByEmail(invitation.email);
    // A user can hold more than one account at the same provider, so the rows
    // collapse to the distinct providers the wire contract promises.
    const federatedProviders = existingUser
      ? [...new Set(
        (await this.dependencies.federatedIdentityRepository.listForUser(existingUser.id))
          .map(({ provider }) => provider),
      )]
      : [];

    return {
      ...invitation,
      requiresExistingPassword: existingUser !== null,
      federatedProviders,
    };
  }

  async acceptInvitation(input: {
    invitationToken: string;
    email: string;
    password: string;
  }): Promise<AuthenticatedAccountSession> {
    const email = normalizeEmail(input.email);
    const invitation = await this.dependencies.accountInvitationService.getInvitation(input.invitationToken);
    if (invitation.email !== email) {
      await this.recordInvitationAcceptFailure(invitation.accountId, email, "email_mismatch");
      throw unauthorized("Invitation email does not match");
    }

    const existingUser = await this.dependencies.userRepository.findByEmail(email);

    if (existingUser) {
      const passwordValid = await verifyPassword(input.password, existingUser.passwordHash);
      if (!passwordValid) {
        await this.recordInvitationAcceptFailure(invitation.accountId, email, "invalid_password");
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

    return this.completeInvitationAcceptance({
      invitationToken: input.invitationToken,
      userId: user.id,
      email,
      createdUserId: existingUser ? null : user.id,
    });
  }

  /**
   * Accepts an invitation on behalf of an already-authenticated user. The
   * session itself is the proof of identity, so no password is collected —
   * which is the only way in for someone whose login is federated and
   * therefore has no usable password hash to verify.
   */
  async acceptInvitationAsUser(input: {
    invitationToken: string;
    userId: string;
  }): Promise<AuthenticatedAccountSession> {
    const invitation = await this.dependencies.accountInvitationService.getInvitation(input.invitationToken);
    const user = await this.dependencies.userRepository.findById(input.userId);
    if (!user) {
      throw unauthorized();
    }

    const email = normalizeEmail(user.email);
    if (invitation.email !== email) {
      await this.recordInvitationAcceptFailure(invitation.accountId, email, "email_mismatch");
      throw unauthorized("Invitation email does not match");
    }

    return this.completeInvitationAcceptance({
      invitationToken: input.invitationToken,
      userId: user.id,
      email,
      createdUserId: null,
    });
  }

  private async recordInvitationAcceptFailure(
    accountId: string,
    email: string,
    reason: "email_mismatch" | "invalid_password",
  ): Promise<void> {
    await this.dependencies.auditService.record({
      accountId,
      eventType: "account.invitation.accept",
      eventStatus: "failure",
      metadata: { email, reason },
    });
  }

  /**
   * Shared tail of both accept paths: claim the invitation, mark the mailbox
   * verified (following the emailed link proves control of it), and hand back a
   * session on the joined account. `createdUserId` names a user this call
   * brought into existence, so a failure downstream can unwind it.
   */
  private async completeInvitationAcceptance(input: {
    invitationToken: string;
    userId: string;
    email: string;
    createdUserId: string | null;
  }): Promise<AuthenticatedAccountSession> {
    let accountId: string;
    try {
      ({ accountId } = await this.dependencies.accountInvitationService.acceptInvitation(
        input.invitationToken,
        input.userId,
      ));
      await this.dependencies.userRepository.markEmailVerified(input.userId, new Date());
    } catch (error) {
      // The claim may already have succeeded and only the verification failed,
      // which would otherwise leave the invitation spent while the caller sees
      // an error and a retry gets "no longer valid". Reverting is a no-op when
      // the claim itself is what threw.
      await this.dependencies.accountInvitationService.revertAcceptance(input.invitationToken, input.userId);
      if (input.createdUserId) {
        await this.dependencies.userRepository.deleteById(input.createdUserId);
      }
      throw error;
    }

    try {
      const account = await this.dependencies.accountRepository.findById(accountId);
      const workspace = await this.dependencies.workspaceService.resolveLoginWorkspace(accountId);
      const sessionCookie = await this.createSessionCookie(input.userId, accountId);

      return {
        userId: input.userId,
        accountId,
        organizationName: account?.name ?? deriveOrganizationName(input.email),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspacePublicRouteKey: workspace.publicRouteKey,
        sessionCookie,
      };
    } catch (error) {
      await this.dependencies.accountInvitationService.revertAcceptance(input.invitationToken, input.userId);
      if (input.createdUserId) {
        await this.dependencies.userRepository.deleteById(input.createdUserId);
      }
      throw error;
    }
  }

  async switchAccount(input: {
    userId: string;
    targetAccountId: string;
    preferredWorkspaceId?: string | null;
  }): Promise<AuthenticatedAccountSession> {
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
    const auditEvent = transactionalLifecycleAuditEvent({
      accountId: input.accountId,
      eventType: "account.delete",
      eventStatus: "success",
      metadata: {
        actorUserId: input.userId,
        organizationName: account?.name ?? null,
      },
    });
    if (this.dependencies.personalCredentialLifecycle) {
      const deleted = await this.dependencies.personalCredentialLifecycle.deleteAccount({
        accountId: input.accountId,
        actorUserId: input.userId,
        auditEvent,
      });
      if (!deleted) throw conflict("Organization could not be deleted");
      this.dependencies.auditService.logRecorded?.(auditEvent);
      return { accountId: input.accountId };
    }
    await this.dependencies.personalCredentialTermination?.endAccount({
      accountId: input.accountId,
      actorUserId: input.userId,
    });
    const deleted = await this.dependencies.accountRepository.deleteById(input.accountId);
    if (!deleted) {
      throw conflict("Organization could not be deleted");
    }

    await this.dependencies.auditService.record(auditEvent);

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

  async authenticateApiToken(token: string): Promise<{
    workspaceId: string;
    accountId: string;
    principal: AuthenticatedPrincipal;
  }> {
    if (!this.dependencies.apiPrincipalAuthenticator) throw unauthorized();
    return this.dependencies.apiPrincipalAuthenticator.authenticate(token);
  }

  recordApiTokenUse(principal: AuthenticatedPrincipal): void {
    if (principal.type === "personal_api_credential" || principal.type === "service_account_credential") {
      this.dependencies.apiPrincipalAuthenticator?.recordSuccessfulUse?.(principal);
    }
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
