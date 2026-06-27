import { describe, expect, it } from "vitest";

import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import { EmailVerificationService } from "../../src/modules/auth/services/emailVerificationService.js";
import { PasswordResetService } from "../../src/modules/auth/services/passwordResetService.js";
import { sha256, verifyPassword } from "../../src/modules/auth/domain/authPrimitives.js";
import { EmailService, type EmailDriver, type EmailMessage } from "../../src/modules/mail/public.js";
import { CustomerEmailConnectionService } from "../../src/modules/customerEmail/services/customerEmailConnectionService.js";
import { WorkspaceService } from "../../src/modules/workspace/public.js";
import { createTestEnv } from "../support/testApp.js";
import {
  createAuditService,
  InMemoryAccountMembershipRepository,
  InMemoryAccountRepository,
  InMemoryEmailVerificationTokenRepository,
  InMemoryPasswordResetTokenRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
} from "../support/fakes.js";

class RecordingEmailDriver implements EmailDriver {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }
}

class FailingEmailDriver implements EmailDriver {
  async send(): Promise<void> {
    throw new Error("delivery failed");
  }
}

const readTokenFromUrl = (url: string): string => new URL(url).searchParams.get("token") ?? "";

const createHarness = async (options: { verified?: boolean } = {}) => {
  const env = { ...createTestEnv(), APP_BASE_URL: "https://app.example.com" };
  const auditService = createAuditService();
  const accountRepository = new InMemoryAccountRepository();
  const userRepository = new InMemoryUserRepository();
  const accountMembershipRepository = new InMemoryAccountMembershipRepository();
  accountMembershipRepository.setUserRepository(userRepository);
  const accountAccessService = new AccountAccessService(accountMembershipRepository, auditService);
  const workspaceService = new WorkspaceService(new InMemoryWorkspaceRepository(), auditService);
  const sessionRepository = new InMemorySessionRepository();
  const passwordResetTokenRepository = new InMemoryPasswordResetTokenRepository();
  const emailVerificationTokenRepository = new InMemoryEmailVerificationTokenRepository();
  const mailDriver = new RecordingEmailDriver();
  const mailService = new EmailService(mailDriver, { fromEmail: "noreply@example.com", fromName: "Radioso" });
  const account = await accountRepository.create({
    name: "Ada Organization",
    email: "ada@example.com",
    passwordHash: "old-password-hash",
  });
  const user = await userRepository.create({
    id: account.id,
    email: "ada@example.com",
    passwordHash: "old-password-hash",
    emailVerifiedAt: options.verified === false ? null : new Date(),
  });
  await accountAccessService.ensureMembership({ accountId: account.id, userId: user.id, role: "owner" });
  await workspaceService.createDefault(account.id);

  return {
    passwordResetService: new PasswordResetService({
      env,
      auditService,
      accountRepository,
      userRepository,
      sessionRepository,
      accountAccessService,
      workspaceService,
      passwordResetTokenRepository,
      mailService,
      responsePaddingMs: 0,
    }),
    emailVerificationService: new EmailVerificationService({
      env,
      auditService,
      userRepository,
      emailVerificationTokenRepository,
      mailService,
      responsePaddingMs: 0,
    }),
    auditService,
    emailVerificationTokenRepository,
    mailDriver,
    passwordResetTokenRepository,
    sessionRepository,
    user,
    userRepository,
  };
};

describe("PasswordResetService", () => {
  it("accepts unknown emails without sending reset mail", async () => {
    const { passwordResetService, mailDriver, passwordResetTokenRepository } = await createHarness();

    await expect(passwordResetService.requestReset({ email: "missing@example.com" }))
      .resolves.toEqual({ accepted: true });

    expect(mailDriver.messages).toHaveLength(0);
    expect(passwordResetTokenRepository.items.size).toBe(0);
  });

  it("sends reset mail through the shared mail service with a hashed token", async () => {
    const { passwordResetService, mailDriver, passwordResetTokenRepository } = await createHarness();

    await expect(passwordResetService.requestReset({ email: "ADA@example.com" }))
      .resolves.toEqual({ accepted: true });

    expect(mailDriver.messages).toHaveLength(1);
    const resetUrl = mailDriver.messages[0]?.metadata?.resetUrl ?? "";
    const token = readTokenFromUrl(resetUrl);
    const stored = [...passwordResetTokenRepository.items.values()][0];
    expect(resetUrl).toContain("https://app.example.com/reset-password?token=");
    expect(stored?.tokenHash).toBe(sha256(token));
    expect(stored?.tokenHash).not.toBe(token);
  });

  it("continues to use modules/mail even when customer email connections exist", async () => {
    const { passwordResetService, mailDriver } = await createHarness();
    let customerEmailHealthChecks = 0;
    const customerEmailService = new CustomerEmailConnectionService({
      repository: {
        create: async () => {
          throw new Error("customer email repository must not be used by password reset");
        },
        findById: async () => null,
        listByWorkspace: async () => [],
        update: async () => null,
        countSkillReferences: async () => 0,
        remove: async () => false,
      },
      oauthConnections: {
        get: async () => {
          throw new Error("customer email OAuth must not be used by password reset");
        },
        list: async () => {
          throw new Error("customer email OAuth must not be used by password reset");
        },
      },
      providers: {
        get: () => ({
          provider: "google_mail",
          checkHealth: async () => {
            customerEmailHealthChecks += 1;
            return { status: "ok" };
          },
        }),
      },
    });

    expect(customerEmailService).toBeInstanceOf(CustomerEmailConnectionService);
    await expect(passwordResetService.requestReset({ email: "ada@example.com" }))
      .resolves.toEqual({ accepted: true });

    expect(mailDriver.messages).toHaveLength(1);
    expect(mailDriver.messages[0]?.from.email).toBe("noreply@example.com");
    expect(customerEmailHealthChecks).toBe(0);
  });

  it("confirms the latest active token, changes password, verifies email, revokes old sessions, and creates a new session", async () => {
    const { passwordResetService, mailDriver, sessionRepository, user, userRepository } = await createHarness({
      verified: false,
    });
    const oldSession = await sessionRepository.create({
      userId: user.id,
      accountId: user.id,
      sessionTokenHash: "old-session",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await passwordResetService.requestReset({ email: "ada@example.com" });
    const token = readTokenFromUrl(mailDriver.messages[0]?.metadata?.resetUrl ?? "");

    const response = await passwordResetService.confirmReset({
      token,
      password: "new-secure-password",
    });

    const updated = await userRepository.findById(user.id);
    expect(response.email).toBe("ada@example.com");
    expect(response.sessionCookie).toContain("radioso_session=");
    expect(await verifyPassword("new-secure-password", updated!.passwordHash)).toBe(true);
    expect(updated?.emailVerifiedAt).toBeInstanceOf(Date);
    expect((await sessionRepository.findActiveByTokenHash(oldSession.sessionTokenHash, new Date()))).toBeNull();
  });

  it("rejects older active tokens after a newer token is requested", async () => {
    const { passwordResetService, mailDriver, passwordResetTokenRepository } = await createHarness();
    await passwordResetService.requestReset({ email: "ada@example.com" });
    const firstToken = readTokenFromUrl(mailDriver.messages[0]?.metadata?.resetUrl ?? "");
    await passwordResetService.requestReset({ email: "ada@example.com" });

    await expect(passwordResetService.confirmReset({
      token: firstToken,
      password: "new-secure-password",
    })).rejects.toMatchObject({
      statusCode: 401,
      code: "unauthorized",
    });

    const firstRecord = [...passwordResetTokenRepository.items.values()]
      .find((record) => record.tokenHash === sha256(firstToken));
    expect(firstRecord?.usedAt).toBeInstanceOf(Date);
  });
});

describe("EmailVerificationService", () => {
  it("resends verification without enumerating missing or already verified users", async () => {
    const { emailVerificationService, mailDriver, emailVerificationTokenRepository } = await createHarness();

    await expect(emailVerificationService.resend({ email: "missing@example.com" }))
      .resolves.toEqual({ accepted: true });
    await expect(emailVerificationService.resend({ email: "ada@example.com" }))
      .resolves.toEqual({ accepted: true });

    expect(mailDriver.messages).toHaveLength(0);
    expect(emailVerificationTokenRepository.items.size).toBe(0);
  });

  it("sends verification mail for unverified users and verifies the latest token", async () => {
    const { emailVerificationService, mailDriver, user, userRepository } = await createHarness({
      verified: false,
    });
    await emailVerificationService.resend({ email: "ada@example.com" });
    const token = readTokenFromUrl(mailDriver.messages[0]?.metadata?.verificationUrl ?? "");

    await expect(emailVerificationService.verify({ token })).resolves.toEqual({ verified: true });

    const updated = await userRepository.findById(user.id);
    expect(updated?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("audits failed verification delivery as failure and consumes the unusable token", async () => {
    const harness = await createHarness({ verified: false });
    const failingMailService = new EmailService(new FailingEmailDriver(), {
      fromEmail: "noreply@example.com",
      fromName: "Radioso",
    });
    const emailVerificationService = new EmailVerificationService({
      env: { ...createTestEnv(), APP_BASE_URL: "https://app.example.com" },
      auditService: harness.auditService,
      userRepository: harness.userRepository,
      emailVerificationTokenRepository: harness.emailVerificationTokenRepository,
      mailService: failingMailService,
      responsePaddingMs: 0,
    });

    await expect(emailVerificationService.resend({ email: "ada@example.com" }))
      .resolves.toEqual({ accepted: true });

    const token = [...harness.emailVerificationTokenRepository.items.values()][0];
    const auditEvent = harness.auditService.events.find((event) =>
      event.eventType === "auth.email_verification.resend" && event.eventStatus === "failure"
    );
    expect(token?.usedAt).toBeInstanceOf(Date);
    expect(auditEvent?.metadata).toEqual({
      email: "ada@example.com",
      sent: false,
      reason: "delivery_failed",
    });
  });
});
