import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EmailService,
  ResendEmailDriver,
  createMailService,
  renderHumanContactRequestEmail,
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

  it("composes password reset mail for the configured driver", async () => {
    const driver = new RecordingEmailDriver();
    const service = new EmailService(driver, { fromEmail: "support@example.com" });

    await service.sendPasswordResetEmail({
      to: "grace@example.com",
      resetUrl: "https://app.example.com/reset?token=secret",
    });

    expect(driver.messages[0]).toMatchObject({
      to: "grace@example.com",
      subject: "Reset your password",
      metadata: {
        kind: "password_reset",
        resetUrl: "https://app.example.com/reset?token=secret",
      },
    });
    expect(driver.messages[0]?.text).toContain("https://app.example.com/reset?token=secret");
  });

  it("builds a Resend-backed service from environment configuration", () => {
    const service = createMailService({
      EE_MAIL_DRIVER: "resend",
      EE_MAIL_FROM_EMAIL: "support@example.com",
      RESEND_MAIL_API_KEY: "re_test",
    });

    expect(service).toBeInstanceOf(EmailService);
    expect(Reflect.get(service, "driver")).toBeInstanceOf(ResendEmailDriver);
  });

  it("requires a Resend API key when the Resend driver is selected", () => {
    expect(() => createMailService({ EE_MAIL_DRIVER: "resend" })).toThrow(
      "RESEND_MAIL_API_KEY is required",
    );
  });

  it("rejects blank Resend API keys", () => {
    expect(() => createMailService({ EE_MAIL_DRIVER: "resend", RESEND_MAIL_API_KEY: "   " })).toThrow(
      "RESEND_MAIL_API_KEY is required",
    );
  });

  it("logs plaintext mail body for local link testing", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = createMailService({ EE_MAIL_DRIVER: "log" });

    await service.sendEmailVerificationEmail({
      to: "grace@example.com",
      verificationUrl: "https://app.example.com/verify-email?token=secret",
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

describe("renderHumanContactRequestEmail", () => {
  const baseInput = {
    to: "support@example.com",
    visitorEmail: "user@example.com",
    message: "Please contact me.",
    workspace: { name: "Acme Workspace", publicRouteKey: "acme" },
    sourceChannel: "website_embed",
    createdAt: new Date("2026-05-04T10:00:00.000Z"),
    requestId: "request-1",
    workspaceId: "workspace-1",
    dashboardUrl: "https://app.example.com/w/acme/activity?filter=contact&itemKind=contact&itemId=request-1",
  };

  it("renders subject, reply-to, deep link, and metadata when workspace + dashboard URL are provided", () => {
    const message = renderHumanContactRequestEmail(baseInput);

    expect(message.subject).toBe("[Acme Workspace] New contact request from user@example.com");
    expect(message.replyTo).toBe("user@example.com");
    expect(message.text).toContain("Acme Workspace");
    expect(message.text).toContain("via website embed");
    expect(message.text).toContain("Please contact me.");
    expect(message.text).toContain(baseInput.dashboardUrl);
    expect(message.text).not.toContain("workspace-1");
    expect(message.html).toContain("Please contact me.");
    expect(message.html).toContain(
      "https://app.example.com/w/acme/activity?filter=contact&amp;itemKind=contact&amp;itemId=request-1",
    );
    expect(message.metadata).toEqual({
      kind: "human_contact_request",
      requestId: "request-1",
      workspaceId: "workspace-1",
    });
  });

  it("omits dashboard link and workspace prefix when not provided", () => {
    const message = renderHumanContactRequestEmail({
      ...baseInput,
      workspace: null,
      dashboardUrl: null,
      sourceChannel: null,
    });

    expect(message.subject).toBe("New contact request from user@example.com");
    expect(message.text).not.toContain("Open in Radioso");
    expect(message.html).not.toContain("Open in Radioso");
  });

  it("escapes HTML in user-provided content", () => {
    const message = renderHumanContactRequestEmail({
      ...baseInput,
      message: "<script>alert(1)</script>",
    });

    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });
});
