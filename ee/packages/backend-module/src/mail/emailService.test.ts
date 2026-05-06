import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EmailService,
  ResendEmailDriver,
  createEnterpriseEmailService,
  type EmailDriver,
  type EmailMessage,
} from "./emailService.js";

class RecordingEmailDriver implements EmailDriver {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }
}

describe("enterprise email service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies default sender details when sending mail", async () => {
    const driver = new RecordingEmailDriver();
    const service = new EmailService(driver, {
      fromEmail: "noreply@example.com",
      fromName: "Radioso",
    });

    await service.send({
      to: "ada@example.com",
      subject: "Welcome",
      text: "Hello",
    });

    expect(driver.messages).toHaveLength(1);
    expect(driver.messages[0]).toMatchObject({
      to: "ada@example.com",
      from: {
        email: "noreply@example.com",
        name: "Radioso",
      },
      subject: "Welcome",
      text: "Hello",
    });
  });

  it("composes password reset mail for the configured driver", async () => {
    const driver = new RecordingEmailDriver();
    const service = new EmailService(driver, {
      fromEmail: "support@example.com",
    });

    await service.sendPasswordResetEmail({
      to: "grace@example.com",
      resetUrl: "https://app.example.com/reset?token=secret",
    });

    expect(driver.messages[0]).toMatchObject({
      to: "grace@example.com",
      from: {
        email: "support@example.com",
        name: null,
      },
      subject: "Reset your password",
      metadata: {
        kind: "password_reset",
        resetUrl: "https://app.example.com/reset?token=secret",
      },
    });
    expect(driver.messages[0]?.text).toContain("https://app.example.com/reset?token=secret");
  });

  it("builds a Resend-backed service from Enterprise mail environment", () => {
    const service = createEnterpriseEmailService({
      EE_MAIL_DRIVER: "resend",
      EE_MAIL_FROM_EMAIL: "support@example.com",
      RESEND_MAIL_API_KEY: "re_test",
    });

    expect(service).toBeInstanceOf(EmailService);
    expect(Reflect.get(service, "driver")).toBeInstanceOf(ResendEmailDriver);
  });

  it("requires a Resend API key when the Enterprise Resend driver is selected", () => {
    expect(() => createEnterpriseEmailService({
      EE_MAIL_DRIVER: "resend",
    })).toThrow("RESEND_MAIL_API_KEY is required");
  });

  it("rejects blank Resend API keys when the Enterprise Resend driver is selected", () => {
    expect(() => createEnterpriseEmailService({
      EE_MAIL_DRIVER: "resend",
      RESEND_MAIL_API_KEY: "   ",
    })).toThrow("RESEND_MAIL_API_KEY is required");
  });

  it("logs plaintext mail body for local Enterprise auth link testing", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = createEnterpriseEmailService({
      EE_MAIL_DRIVER: "log",
    });

    await service.sendEmailVerificationEmail({
      to: "grace@example.com",
      verificationUrl: "https://app.example.com/verify-email?token=secret",
    });

    expect(log).toHaveBeenCalledWith("email.send", expect.objectContaining({
      text: expect.stringContaining("https://app.example.com/verify-email?token=secret"),
      metadata: {
        kind: "email_verification",
        verificationUrl: "[redacted]",
      },
    }));
  });
});
