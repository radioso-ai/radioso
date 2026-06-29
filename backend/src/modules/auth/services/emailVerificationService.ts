import { randomBytes } from "node:crypto";

import type { Env } from "../../../app/config/env.js";
import type { EmailVerificationTokenRepositoryPort } from "../../../db/repositories/emailVerificationTokenRepository.js";
import type { UserRepositoryPort } from "../../../db/repositories/userRepository.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { EmailService } from "../../mail/public.js";
import { renderEmailVerificationEmail } from "../../mail/templates/emailVerificationEmail.js";
import { normalizeEmail, sha256 } from "../domain/authPrimitives.js";
import { unauthorized } from "../../../shared/domain/errors.js";
import { logAuthMailDeliveryFailure, type AuthMailDeliveryLogger } from "./authMailDeliveryLogging.js";
import { DEFAULT_AUTH_EMAIL_FLOW_MIN_RESPONSE_MS, waitForMinimumElapsed } from "./responsePadding.js";

const generateVerificationToken = (): string => randomBytes(32).toString("base64url");

const appBaseUrl = (env: Env): string => env.APP_BASE_URL ?? "http://localhost:3000";

export class EmailVerificationService {
  constructor(private readonly dependencies: {
    env: Env;
    userRepository: UserRepositoryPort;
    emailVerificationTokenRepository: EmailVerificationTokenRepositoryPort;
    mailService: EmailService;
    auditService: AuditService;
    logger?: AuthMailDeliveryLogger;
    responsePaddingMs?: number;
  }) {}

  async resend(input: {
    email: string;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<{ accepted: true }> {
    const startedAtMs = Date.now();
    try {
      const email = normalizeEmail(input.email);
      const user = await this.dependencies.userRepository.findByEmail(email);

      if (!user || user.emailVerifiedAt) {
        await this.dependencies.auditService.record({
          eventType: "auth.email_verification.resend",
          eventStatus: "success",
          metadata: { email, sent: false },
        });
        return { accepted: true };
      }

      const now = new Date();
      const token = generateVerificationToken();
      const expiresAt = new Date(
        now.getTime() + this.dependencies.env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES * 60 * 1000,
      );
      const record = await this.dependencies.emailVerificationTokenRepository.create({
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt,
        requestIp: input.requestIp ?? null,
        requestUserAgent: input.requestUserAgent ?? null,
      });
      const verificationUrl = new URL("/verify-email", appBaseUrl(this.dependencies.env));
      verificationUrl.searchParams.set("token", token);

      let sent = true;
      try {
        await this.dependencies.mailService.send(renderEmailVerificationEmail({
          to: email,
          verificationUrl: verificationUrl.toString(),
        }));
      } catch (error) {
        sent = false;
        logAuthMailDeliveryFailure(this.dependencies.logger, {
          flow: "email_verification",
          userId: user.id,
          tokenRecordId: record.id,
          error,
        });
        await this.dependencies.emailVerificationTokenRepository.markUsed(record.id, now);
      }

      await this.dependencies.auditService.record({
        eventType: "auth.email_verification.resend",
        eventStatus: sent ? "success" : "failure",
        metadata: sent ? { email, sent: true } : { email, sent: false, reason: "delivery_failed" },
      });
      return { accepted: true };
    } finally {
      await waitForMinimumElapsed(
        startedAtMs,
        this.dependencies.responsePaddingMs ?? DEFAULT_AUTH_EMAIL_FLOW_MIN_RESPONSE_MS,
      );
    }
  }

  async verify(input: { token: string }): Promise<{ verified: true }> {
    const now = new Date();
    const record = await this.dependencies.emailVerificationTokenRepository.findByTokenHash(sha256(input.token));

    if (!record || record.usedAt || record.expiresAt <= now) {
      throw unauthorized("Email verification link is invalid or expired");
    }

    const latestActive = await this.dependencies.emailVerificationTokenRepository.findLatestActiveForUser(
      record.userId,
      now,
    );
    if (!latestActive || latestActive.id !== record.id) {
      await this.dependencies.emailVerificationTokenRepository.markUsed(record.id, now);
      throw unauthorized("Email verification link is invalid or expired");
    }

    const existingUser = await this.dependencies.userRepository.findById(record.userId);
    if (!existingUser) {
      throw unauthorized("Email verification link is invalid or expired");
    }

    const user = await this.dependencies.userRepository.markEmailVerified(record.userId, now);
    await this.dependencies.emailVerificationTokenRepository.markAllActiveUsedForUser(record.userId, now);
    await this.dependencies.auditService.record({
      eventType: "auth.email_verification.verify",
      eventStatus: "success",
      metadata: { userId: user.id },
    });
    return { verified: true };
  }
}
