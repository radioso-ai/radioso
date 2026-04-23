import type { Env } from "../../../app/config/env.js";
import type { PasswordResetTokenRepositoryPort } from "../../../db/repositories/passwordResetTokenRepository.js";
import type { UserRepositoryPort } from "../../../db/repositories/userRepository.js";
import { emailVerificationRequired, unauthorized } from "../../../shared/domain/errors.js";
import type { AccountAccessService } from "../../account/services/accountAccessService.js";
import type { AuditService } from "../../audit/services/auditService.js";
import { generateSessionToken, hashPassword, normalizeEmail, serializeSessionCookie, sha256 } from "../domain/authPrimitives.js";
import { generatePasswordResetToken } from "../domain/passwordReset.js";
import type { AccountRepositoryPort, SessionRepositoryPort } from "./authService.js";
import type { WorkspaceService } from "../../workspace/services/workspaceService.js";

interface PasswordResetServiceDependencies {
  env: Env;
  auditService: AuditService;
  accountRepository: AccountRepositoryPort;
  accountAccessService: AccountAccessService;
  emailService: {
    sendPasswordResetEmail(input: { to: string; resetUrl: string }): Promise<void>;
  };
  passwordResetTokenRepository: PasswordResetTokenRepositoryPort;
  sessionRepository: SessionRepositoryPort;
  userRepository: UserRepositoryPort;
  workspaceService: WorkspaceService;
}

export class PasswordResetService {
  constructor(private readonly dependencies: PasswordResetServiceDependencies) {}

  async requestReset(input: {
    email: string;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<{ accepted: true }> {
    const email = normalizeEmail(input.email);
    const user = await this.dependencies.userRepository.findByEmail(email);

    if (!user) {
      await this.dependencies.auditService.record({
        eventType: "auth.password_reset.request",
        eventStatus: "success",
        metadata: { email, userExists: false },
      });
      return { accepted: true };
    }

    const token = generatePasswordResetToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.dependencies.env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    const createdToken = await this.dependencies.passwordResetTokenRepository.create({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt,
      requestIp: input.requestIp ?? null,
      requestUserAgent: input.requestUserAgent ?? null,
    });

    const resetUrl = new URL("/reset-password", this.dependencies.env.APP_BASE_URL);
    resetUrl.searchParams.set("token", token);

    try {
      await this.dependencies.emailService.sendPasswordResetEmail({
        to: email,
        resetUrl: resetUrl.toString(),
      });
    } catch (error) {
      await this.dependencies.passwordResetTokenRepository.markUsed(createdToken.id, now);
      await this.dependencies.auditService.record({
        eventType: "auth.password_reset.request",
        eventStatus: "failure",
        metadata: { email, reason: "email_delivery_failed" },
      });
      return { accepted: true };
    }

    await this.dependencies.passwordResetTokenRepository.markOlderActiveForUserUsed(
      user.id,
      createdToken.createdAt,
      now,
    );

    await this.dependencies.auditService.record({
      eventType: "auth.password_reset.request",
      eventStatus: "success",
      metadata: { email, userExists: true },
    });

    return { accepted: true };
  }

  async confirmReset(input: { token: string; password: string }): Promise<{
    userId: string;
    accountId: string;
    email: string;
    organizationName: string;
    workspaceId: string;
    workspaceName: string;
    sessionCookie: string;
  }> {
    const now = new Date();
    const record = await this.dependencies.passwordResetTokenRepository.findByTokenHash(sha256(input.token));

    if (!record || record.usedAt || record.expiresAt <= now) {
      await this.dependencies.auditService.record({
        eventType: "auth.password_reset.confirm",
        eventStatus: "failure",
        metadata: { reason: "invalid_or_expired_token" },
      });
      throw unauthorized("Password reset link is invalid or expired");
    }

    const latestActive = await this.dependencies.passwordResetTokenRepository.findLatestActiveByUserId(record.userId, now);
    if (!latestActive || latestActive.id !== record.id) {
      await this.dependencies.passwordResetTokenRepository.markUsed(record.id, now);
      await this.dependencies.auditService.record({
        eventType: "auth.password_reset.confirm",
        eventStatus: "failure",
        metadata: { userId: record.userId, reason: "stale_token" },
      });
      throw unauthorized("Password reset link is invalid or expired");
    }

    const user = await this.dependencies.userRepository.findById(record.userId);
    if (!user) {
      throw unauthorized("Password reset link is invalid or expired");
    }

    await this.dependencies.userRepository.updatePassword(user.id, await hashPassword(input.password));
    await this.dependencies.passwordResetTokenRepository.markAllActiveForUserUsed(user.id, now);
    await this.dependencies.sessionRepository.revokeAllForUser(user.id, now);

    if (!this.dependencies.env.AUTH_SKIP_EMAIL_VERIFICATION && !user.emailVerifiedAt) {
      await this.dependencies.auditService.record({
        eventType: "auth.password_reset.confirm",
        eventStatus: "failure",
        metadata: { userId: user.id, reason: "email_verification_required" },
      });
      throw emailVerificationRequired();
    }

    const membership = await this.dependencies.accountAccessService.resolveLoginAccount(user.id);
    const workspace = await this.dependencies.workspaceService.resolveLoginWorkspace(membership.accountId);
    const account = await this.dependencies.accountRepository.findById(membership.accountId);
    const sessionCookie = await this.createSessionCookie(user.id, membership.accountId);

    await this.dependencies.auditService.record({
      accountId: membership.accountId,
      workspaceId: workspace.id,
      eventType: "auth.password_reset.confirm",
      eventStatus: "success",
      metadata: { userId: user.id },
    });

    return {
      userId: user.id,
      accountId: membership.accountId,
      email: user.email,
      organizationName: account?.name ?? "Organization",
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      sessionCookie,
    };
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
}
