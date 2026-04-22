import type { Env } from "../../../app/config/env.js";
import type { EmailVerificationTokenRepositoryPort } from "../../../db/repositories/emailVerificationTokenRepository.js";
import type { UserRepositoryPort } from "../../../db/repositories/userRepository.js";
import { unauthorized } from "../../../shared/domain/errors.js";
import type { AuditService } from "../../audit/services/auditService.js";
import { EmailService } from "../../email/services/emailService.js";
import { generateEmailVerificationToken } from "../domain/emailVerification.js";
import { normalizeEmail, sha256 } from "../domain/authPrimitives.js";

interface EmailVerificationServiceDependencies {
  env: Env;
  auditService: AuditService;
  emailService: EmailService;
  tokenRepository: EmailVerificationTokenRepositoryPort;
  userRepository: UserRepositoryPort;
}

export class EmailVerificationService {
  constructor(private readonly dependencies: EmailVerificationServiceDependencies) {}

  async issueVerification(input: {
    userId: string;
    email: string;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<void> {
    const now = new Date();
    const token = generateEmailVerificationToken();
    const expiresAt = new Date(now.getTime() + this.dependencies.env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    await this.dependencies.tokenRepository.markAllActiveForUserUsed(input.userId, now);
    await this.dependencies.tokenRepository.create({
      userId: input.userId,
      tokenHash: sha256(token),
      expiresAt,
      requestIp: input.requestIp ?? null,
      requestUserAgent: input.requestUserAgent ?? null,
    });

    const verificationUrl = new URL("/verify-email", this.dependencies.env.APP_BASE_URL);
    verificationUrl.searchParams.set("token", token);

    await this.dependencies.emailService.sendEmailVerificationEmail({
      to: input.email,
      verificationUrl: verificationUrl.toString(),
    });

    await this.dependencies.auditService.record({
      eventType: "auth.email_verification.issue",
      eventStatus: "success",
      metadata: { userId: input.userId, email: normalizeEmail(input.email) },
    });
  }

  async resend(input: {
    email: string;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<{ accepted: true }> {
    const email = normalizeEmail(input.email);
    const user = await this.dependencies.userRepository.findByEmail(email);

    if (!user || user.emailVerifiedAt) {
      await this.dependencies.auditService.record({
        eventType: "auth.email_verification.resend",
        eventStatus: "success",
        metadata: { email, userExists: Boolean(user), alreadyVerified: user?.emailVerifiedAt != null },
      });
      return { accepted: true };
    }

    await this.issueVerification({
      userId: user.id,
      email: user.email,
      requestIp: input.requestIp,
      requestUserAgent: input.requestUserAgent,
    });

    await this.dependencies.auditService.record({
      eventType: "auth.email_verification.resend",
      eventStatus: "success",
      metadata: { email, userExists: true, alreadyVerified: false },
    });
    return { accepted: true };
  }

  async verify(input: { token: string }): Promise<{ verified: true }> {
    const now = new Date();
    const record = await this.dependencies.tokenRepository.findByTokenHash(sha256(input.token));

    if (!record || record.usedAt || record.expiresAt <= now) {
      await this.dependencies.auditService.record({
        eventType: "auth.email_verification.verify",
        eventStatus: "failure",
        metadata: { reason: "invalid_or_expired_token" },
      });
      throw unauthorized("Verification link is invalid or expired");
    }

    const latestActive = await this.dependencies.tokenRepository.findLatestActiveByUserId(record.userId, now);
    if (!latestActive || latestActive.id !== record.id) {
      await this.dependencies.tokenRepository.markUsed(record.id, now);
      await this.dependencies.auditService.record({
        eventType: "auth.email_verification.verify",
        eventStatus: "failure",
        metadata: { userId: record.userId, reason: "stale_token" },
      });
      throw unauthorized("Verification link is invalid or expired");
    }

    await this.dependencies.userRepository.markEmailVerified(record.userId, now);
    await this.dependencies.tokenRepository.markAllActiveForUserUsed(record.userId, now);
    await this.dependencies.auditService.record({
      eventType: "auth.email_verification.verify",
      eventStatus: "success",
      metadata: { userId: record.userId },
    });

    return { verified: true };
  }
}
