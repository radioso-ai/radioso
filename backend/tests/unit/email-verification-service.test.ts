import { describe, expect, it } from "vitest";

import { EmailVerificationService } from "../../src/modules/auth/services/emailVerificationService.js";
import type {
  EmailVerificationTokenRecord,
  EmailVerificationTokenRepositoryPort,
} from "../../src/db/repositories/emailVerificationTokenRepository.js";
import {
  InMemoryUserRepository,
  createAuditService,
} from "../support/fakes.js";
import { createTestEnv } from "../support/testApp.js";

class InMemoryEmailVerificationTokenRepository implements EmailVerificationTokenRepositoryPort {
  readonly items = new Map<string, EmailVerificationTokenRecord>();

  async create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<EmailVerificationTokenRecord> {
    const record: EmailVerificationTokenRecord = {
      id: `verification-${this.items.size + 1}`,
      userId: params.userId,
      tokenHash: params.tokenHash,
      expiresAt: params.expiresAt,
      usedAt: null,
      createdAt: new Date(Date.now() + this.items.size),
      requestIp: params.requestIp ?? null,
      requestUserAgent: params.requestUserAgent ?? null,
    };
    this.items.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationTokenRecord | null> {
    return [...this.items.values()].find((item) => item.tokenHash === tokenHash) ?? null;
  }

  async findLatestActiveByUserId(userId: string, now: Date): Promise<EmailVerificationTokenRecord | null> {
    return [...this.items.values()]
      .filter((item) => item.userId === userId && item.usedAt === null && item.expiresAt > now)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  async markUsed(id: string, usedAt: Date): Promise<void> {
    const record = this.items.get(id);
    if (record) {
      record.usedAt = usedAt;
    }
  }

  async markAllActiveForUserUsed(userId: string, usedAt: Date): Promise<void> {
    for (const record of this.items.values()) {
      if (record.userId === userId && record.usedAt === null && record.expiresAt > usedAt) {
        record.usedAt = usedAt;
      }
    }
  }
}

class RecordingEmailService {
  readonly messages: Array<{ to: string; verificationUrl: string }> = [];

  async sendEmailVerificationEmail(input: { to: string; verificationUrl: string }): Promise<void> {
    this.messages.push(input);
  }
}

class FailingEmailService {
  async sendEmailVerificationEmail(): Promise<never> {
    throw new Error("smtp unavailable");
  }
}

describe("EmailVerificationService", () => {
  it("returns accepted for resend even when delivery fails for an unverified user", async () => {
    const env = createTestEnv();
    const auditService = createAuditService();
    const userRepository = new InMemoryUserRepository();
    const tokenRepository = new InMemoryEmailVerificationTokenRepository();
    const user = await userRepository.create({
      email: "verify@example.com",
      passwordHash: "hash",
      emailVerifiedAt: null,
    });

    const service = new EmailVerificationService({
      env,
      auditService,
      emailService: new FailingEmailService() as never,
      tokenRepository,
      userRepository,
    });

    const response = await service.resend({
      email: "verify@example.com",
      requestIp: "127.0.0.1",
    });

    expect(response).toEqual({ accepted: true });
    expect(await tokenRepository.findLatestActiveByUserId(user.id, new Date())).toBeTruthy();
    expect(auditService.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "auth.email_verification.resend",
          eventStatus: "failure",
          metadata: expect.objectContaining({
            email: "verify@example.com",
            reason: "email_delivery_failed",
          }),
        }),
      ]),
    );
  });

  it("issues a verification email with a verify-email URL", async () => {
    const env = createTestEnv();
    const auditService = createAuditService();
    const userRepository = new InMemoryUserRepository();
    const tokenRepository = new InMemoryEmailVerificationTokenRepository();
    const emailService = new RecordingEmailService();

    const user = await userRepository.create({
      email: "verify@example.com",
      passwordHash: "hash",
      emailVerifiedAt: null,
    });

    const service = new EmailVerificationService({
      env,
      auditService,
      emailService: emailService as never,
      tokenRepository,
      userRepository,
    });

    await service.issueVerification({
      userId: user.id,
      email: user.email,
    });

    expect(emailService.messages).toHaveLength(1);
    expect(emailService.messages[0]?.verificationUrl).toContain("/verify-email?token=");
  });
});
