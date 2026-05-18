import { randomBytes } from "node:crypto";

import type { Env } from "../../../app/config/env.js";
import type { AccountAccessService } from "../../account/public.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { WorkspaceService } from "../../workspace/public.js";
import type { UserRepositoryPort } from "../../../db/repositories/userRepository.js";
import type { PasswordResetTokenRepositoryPort } from "../../../db/repositories/passwordResetTokenRepository.js";
import type {
  AccountRepositoryPort,
  SessionRepositoryPort,
} from "./authService.js";
import type { EmailService } from "../../mail/public.js";
import { renderPasswordResetEmail } from "../../mail/templates/passwordResetEmail.js";
import {
  deriveOrganizationName,
  generateSessionToken,
  hashPassword,
  normalizeEmail,
  serializeSessionCookie,
  sha256,
} from "../domain/authPrimitives.js";
import { unauthorized } from "../../../shared/domain/errors.js";
import { DEFAULT_AUTH_EMAIL_FLOW_MIN_RESPONSE_MS, waitForMinimumElapsed } from "./responsePadding.js";

const generateRecoveryToken = (): string => randomBytes(32).toString("base64url");

const appBaseUrl = (env: Env): string => env.APP_BASE_URL ?? "http://localhost:3000";

export class PasswordResetService {
  constructor(private readonly dependencies: {
    env: Env;
    userRepository: UserRepositoryPort;
    accountRepository: AccountRepositoryPort;
    accountAccessService: AccountAccessService;
    workspaceService: WorkspaceService;
    sessionRepository: SessionRepositoryPort;
    passwordResetTokenRepository: PasswordResetTokenRepositoryPort;
    mailService: EmailService;
    auditService: AuditService;
    responsePaddingMs?: number;
  }) {}

  async requestReset(input: {
    email: string;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<{ accepted: true }> {
    const startedAtMs = Date.now();
    try {
      const email = normalizeEmail(input.email);
      const user = await this.dependencies.userRepository.findByEmail(email);

      if (!user) {
        await this.dependencies.auditService.record({
          eventType: "auth.password_reset.request",
          eventStatus: "success",
          metadata: { email, userFound: false },
        });
        return { accepted: true };
      }

      const now = new Date();
      const token = generateRecoveryToken();
      const expiresAt = new Date(
        now.getTime() + this.dependencies.env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000,
      );
      const record = await this.dependencies.passwordResetTokenRepository.create({
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt,
        requestIp: input.requestIp ?? null,
        requestUserAgent: input.requestUserAgent ?? null,
      });
      const resetUrl = new URL("/reset-password", appBaseUrl(this.dependencies.env));
      resetUrl.searchParams.set("token", token);

      try {
        await this.dependencies.mailService.send(renderPasswordResetEmail({
          to: email,
          resetUrl: resetUrl.toString(),
        }));
      } catch {
        await this.dependencies.passwordResetTokenRepository.markUsed(record.id, now);
        await this.dependencies.auditService.record({
          eventType: "auth.password_reset.request",
          eventStatus: "failure",
          metadata: { email, reason: "delivery_failed" },
        });
        return { accepted: true };
      }

      await this.dependencies.auditService.record({
        eventType: "auth.password_reset.request",
        eventStatus: "success",
        metadata: { email, userFound: true },
      });

      return { accepted: true };
    } finally {
      await waitForMinimumElapsed(
        startedAtMs,
        this.dependencies.responsePaddingMs ?? DEFAULT_AUTH_EMAIL_FLOW_MIN_RESPONSE_MS,
      );
    }
  }

  async confirmReset(input: {
    token: string;
    password: string;
    preferredAccountId?: string | null;
    preferredWorkspaceId?: string | null;
  }): Promise<{
    userId: string;
    accountId: string;
    email: string;
    organizationName: string;
    workspaceId: string;
    workspaceName: string;
    workspacePublicRouteKey: string;
    sessionCookie: string;
  }> {
    const now = new Date();
    const record = await this.dependencies.passwordResetTokenRepository.findByTokenHash(sha256(input.token));

    if (!record || record.usedAt || record.expiresAt <= now) {
      throw unauthorized("Password reset link is invalid or expired");
    }

    const latestActive = await this.dependencies.passwordResetTokenRepository.findLatestActiveForUser(
      record.userId,
      now,
    );
    if (!latestActive || latestActive.id !== record.id) {
      await this.dependencies.passwordResetTokenRepository.markUsed(record.id, now);
      throw unauthorized("Password reset link is invalid or expired");
    }

    const user = await this.dependencies.userRepository.findById(record.userId);
    if (!user) {
      throw unauthorized("Password reset link is invalid or expired");
    }

    const passwordHash = await hashPassword(input.password);
    const consumedCount = await this.dependencies.passwordResetTokenRepository.markUsed(record.id, now);
    if (consumedCount !== 1) {
      throw unauthorized("Password reset link is invalid or expired");
    }

    // These repository ports do not share a transaction boundary. Consume the one-time
    // token before mutating account state so a retry cannot replay the same reset link.
    await this.dependencies.userRepository.updatePassword(user.id, passwordHash);
    // Reset possession proves control of the mailbox, so a successful reset also verifies the email.
    await this.dependencies.userRepository.markEmailVerified(user.id, now);
    await this.dependencies.passwordResetTokenRepository.markAllActiveUsedForUser(user.id, now);
    await this.dependencies.sessionRepository.revokeAllForUser(user.id, now);

    const membership = await this.dependencies.accountAccessService.resolveLoginAccount(
      user.id,
      input.preferredAccountId ?? null,
    );
    const workspace = await this.dependencies.workspaceService.resolveLoginWorkspace(
      membership.accountId,
      input.preferredWorkspaceId ?? null,
    );
    const account = await this.dependencies.accountRepository.findById(membership.accountId);
    const sessionToken = generateSessionToken();
    await this.dependencies.sessionRepository.create({
      userId: user.id,
      accountId: membership.accountId,
      sessionTokenHash: sha256(sessionToken),
      expiresAt: new Date(now.getTime() + this.dependencies.env.SESSION_TTL_HOURS * 60 * 60 * 1000),
    });
    const sessionCookie = serializeSessionCookie(sessionToken, this.dependencies.env);

    await this.dependencies.auditService.record({
      accountId: membership.accountId,
      workspaceId: workspace.id,
      eventType: "auth.password_reset.confirm",
      eventStatus: "success",
      metadata: { userId: user.id, revokedSessions: true },
    });

    return {
      userId: user.id,
      accountId: membership.accountId,
      email: user.email,
      organizationName: account?.name ?? deriveOrganizationName(user.email),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePublicRouteKey: workspace.publicRouteKey,
      sessionCookie,
    };
  }
}
