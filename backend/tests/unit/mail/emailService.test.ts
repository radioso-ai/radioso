import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EmailService,
  ResendEmailDriver,
  createMailService,
  type EmailDriver,
  type EmailMessage,
} from "../../../src/modules/mail/public.js";

class RecordingEmailDriver implements EmailDriver {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }
}

describe("mail service", () => {
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

    expect(driver.messages[0]).toMatchObject({
      to: "ada@example.com",
      from: { email: "noreply@example.com", name: "Radioso" },
      subject: "Welcome",
      text: "Hello",
    });
  });

  it("forwards replyTo to the driver when provided", async () => {
    const driver = new RecordingEmailDriver();
    const service = new EmailService(driver, { fromEmail: "noreply@example.com" });

    await service.send({
      to: "ada@example.com",
      replyTo: "visitor@example.com",
      subject: "Contact request",
      text: "Hello",
    });

    expect(driver.messages[0]?.replyTo).toBe("visitor@example.com");
  });

  it("respects an explicit per-message from override", async () => {
    const driver = new RecordingEmailDriver();
    const service = new EmailService(driver, { fromEmail: "default@example.com" });

    await service.send({
      to: "ada@example.com",
      from: { email: "override@example.com", name: "Override" },
      subject: "Hi",
      text: "Hello",
    });

    expect(driver.messages[0]?.from).toEqual({ email: "override@example.com", name: "Override" });
  });

  it("builds a Resend-backed service from environment configuration", () => {
    const service = createMailService({
      MAIL_DRIVER: "resend",
      MAIL_FROM_EMAIL: "support@example.com",
      RESEND_MAIL_API_KEY: "re_test",
    });

    expect(service).toBeInstanceOf(EmailService);
    expect(Reflect.get(service, "driver")).toBeInstanceOf(ResendEmailDriver);
  });

  it("requires a Resend API key when the Resend driver is selected", () => {
    expect(() => createMailService({ MAIL_DRIVER: "resend" })).toThrow(
      "RESEND_MAIL_API_KEY is required",
    );
  });

  it("rejects blank Resend API keys", () => {
    expect(() => createMailService({ MAIL_DRIVER: "resend", RESEND_MAIL_API_KEY: "   " })).toThrow(
      "RESEND_MAIL_API_KEY is required",
    );
  });

  it("logs plaintext mail body and redacts sensitive metadata keys", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = createMailService({ MAIL_DRIVER: "log" });

    await service.send({
      to: "grace@example.com",
      subject: "Verify your email",
      text: "https://app.example.com/verify-email?token=secret",
      metadata: { kind: "email_verification", verificationUrl: "https://app.example.com/verify-email?token=secret" },
    });

    expect(log).toHaveBeenCalledWith(
      "email.send",
      expect.objectContaining({
        text: expect.stringContaining("https://app.example.com/verify-email?token=secret"),
        metadata: {
          kind: "email_verification",
          verificationUrl: "[redacted]",
        },
      }),
    );
  });

  it("includes reply_to in the Resend payload when set", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response("", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = new ResendEmailDriver("re_test");

    await driver.send({
      to: "ada@example.com",
      from: { email: "noreply@example.com" },
      replyTo: "visitor@example.com",
      subject: "Contact request",
      text: "Hello",
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    const body = JSON.parse(String(init!.body));
    expect(body.reply_to).toBe("visitor@example.com");
  });
});
