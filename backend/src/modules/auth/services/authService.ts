import type { Env } from "../../../app/config/env.js";
import { conflict, serviceUnavailable, unauthorized } from "../../../shared/domain/errors.js";
import type { AccountAccessService } from "../../account/services/accountAccessService.js";
import type { AccountInvitationService } from "../../account/services/accountInvitationService.js";
import type { AuditService } from "../../audit/services/auditService.js";
import type { WorkspaceService } from "../../workspace/services/workspaceService.js";
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
}

export interface AccountRepositoryPort {
  create(params: { name: string; email: string; passwordHash: string }): Promise<AccountRecord>;
  findByEmail(email: string): Promise<AccountRecord | null>;
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
  auditService: AuditService;
}

export class AuthService {
  constructor(private readonly dependencies: AuthServiceDependencies) {}

  async listAccessibleAccounts(userId: string): Promise<Array<{
    accountId: string;
    organizationName: string;
    role: "owner" | "member";
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
    const existing = await this.dependencies.userRepository.findByEmail(email);

    if (existing) {
      await this.dependencies.auditService.record({
        eventType: "auth.register",
        eventStatus: "failure",
        metadata: { email },
      });
      throw conflict("Account already exists");
    }

    const passwordHash = await hashPassword(input.password);
    const organizationName = input.organizationName?.trim() || deriveOrganizationName(email);
    const account = await this.dependencies.accountRepository.create({ name: organizationName, email, passwordHash });

    try {
      const user = await this.dependencies.userRepository.create({
        id: account.id,
        email,
        passwordHash,
        emailVerifiedAt: new Date(),
      });
      await this.dependencies.accountAccessService.ensureMembership({
        accountId: account.id,
        userId: user.id,
        role: "owner",
      });
      const workspace = await this.dependencies.workspaceService.createDefault(account.id);
      const sessionCookie = await this.createSessionCookie(user.id, account.id);

      await this.dependencies.auditService.record({
        accountId: account.id,
        eventType: "auth.register",
        eventStatus: "success",
        metadata: { email },
      });

      return {
        userId: user.id,
        accountId: account.id,
        organizationName: account.name,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspacePublicRouteKey: workspace.publicRouteKey,
        sessionCookie,
      };
    } catch (error) {
      await this.rollbackCreatedAccount(account.id, account.id);
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

    const account = await this.dependencies.accountRepository.create({
      name: input.organizationName.trim(),
      email: user.email,
      passwordHash: user.passwordHash,
    });

    try {
      await this.dependencies.accountAccessService.ensureMembership({
        accountId: account.id,
        userId: user.id,
        role: "owner",
      });
      const workspace = await this.dependencies.workspaceService.createDefault(account.id);
      const sessionCookie = await this.createSessionCookie(user.id, account.id);

      await this.dependencies.auditService.record({
        accountId: account.id,
        eventType: "account.create",
        eventStatus: "success",
        metadata: {
          actorUserId: user.id,
          organizationName: account.name,
        },
      });

      return {
        userId: user.id,
        accountId: account.id,
        organizationName: account.name,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspacePublicRouteKey: workspace.publicRouteKey,
        sessionCookie,
      };
    } catch (error) {
      await this.rollbackCreatedAccount(account.id);
      throw error;
    }
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
          emailVerifiedAt: new Date(),
        });

    const createdUserId: string | null = existingUser ? null : user.id;

    let accountId: string;
    try {
      ({ accountId } = await this.dependencies.accountInvitationService.acceptInvitation(
        input.invitationToken,
        user.id,
      ));
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

  async authenticateApiToken(token: string): Promise<{ workspaceId: string; accountId: string }> {
    const tokenHash = sha256(token);
    const workspaceToken = await this.dependencies.workspaceTokenRepository.findByTokenHash(tokenHash);

    if (!workspaceToken) {
      throw unauthorized();
    }

    await this.dependencies.workspaceTokenRepository.touch(workspaceToken.workspaceId, new Date());
    return { workspaceId: workspaceToken.workspaceId, accountId: workspaceToken.accountId };
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
}
