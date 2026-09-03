import { describe, expect, it, vi } from "vitest";

import { createMailAccountInvitationNotifier } from "../../src/app/composition/accountInvitationNotifier.js";
import {
  EmailService,
  ResendEmailDeliveryError,
  createMailService,
  type EmailDriver,
  type EmailMessage,
  type EmailSendResult,
} from "../../src/modules/mail/public.js";

class RecordingDriver implements EmailDriver {
  readonly sent: EmailMessage[] = [];

  constructor(private readonly failure?: unknown) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.failure) {
      throw this.failure;
    }
    this.sent.push(message);
    return { dispatched: true };
  }
}

const notification = {
  email: "teammate@example.com",
  acceptancePath: "/invite/token-123",
  invitedByEmail: "owner@example.com",
  expiresAt: new Date("2026-09-09T10:00:00.000Z"),
};

describe("createMailAccountInvitationNotifier", () => {
  it("resolves the acceptance path against the app base URL and reports delivery", async () => {
    const driver = new RecordingDriver();
    const notifier = createMailAccountInvitationNotifier({
      env: { APP_BASE_URL: "https://app.radioso.ai" },
      mailService: new EmailService(driver, { fromEmail: "noreply@radioso.ai", fromName: "Radioso" }),
    });

    const result = await notifier.notifyInvited(notification);

    expect(result).toEqual({ delivered: true });
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.to).toBe("teammate@example.com");
    expect(driver.sent[0]?.text).toContain("https://app.radioso.ai/invite/token-123");
  });

  it("falls back to the local app origin when APP_BASE_URL is unset", async () => {
    const driver = new RecordingDriver();
    const notifier = createMailAccountInvitationNotifier({
      env: {},
      mailService: new EmailService(driver, { fromEmail: "noreply@radioso.ai" }),
    });

    await notifier.notifyInvited(notification);

    expect(driver.sent[0]?.text).toContain("http://localhost:3000/invite/token-123");
  });

  it("reports undelivered when the deployment has no mail provider configured", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.fn();
    const notifier = createMailAccountInvitationNotifier({
      env: { APP_BASE_URL: "https://app.radioso.ai" },
      mailService: createMailService({}),
      logger: { warn },
    });

    const result = await notifier.notifyInvited(notification);

    expect(result).toEqual({ delivered: false });
    // An unconfigured mailer is a deployment choice, not a provider failure, so it must not
    // raise the warning that means "the provider rejected this".
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports undelivered and logs provider detail when the driver fails", async () => {
    const driver = new RecordingDriver(new ResendEmailDeliveryError(422, "validation_error"));
    const warn = vi.fn();
    const notifier = createMailAccountInvitationNotifier({
      env: { APP_BASE_URL: "https://app.radioso.ai" },
      mailService: new EmailService(driver, { fromEmail: "noreply@radioso.ai" }),
      logger: { warn },
    });

    const result = await notifier.notifyInvited(notification);

    expect(result).toEqual({ delivered: false });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "account_invitation_mail_delivery_failed",
        providerStatusCode: 422,
        providerErrorName: "validation_error",
        errorClass: "ResendEmailDeliveryError",
      }),
      expect.any(String),
    );
  });

  it("keeps the invitee mailbox and acceptance link out of the failure log", async () => {
    const driver = new RecordingDriver(new Error("network down"));
    const warn = vi.fn();
    const notifier = createMailAccountInvitationNotifier({
      env: { APP_BASE_URL: "https://app.radioso.ai" },
      mailService: new EmailService(driver, { fromEmail: "noreply@radioso.ai" }),
      logger: { warn },
    });

    await notifier.notifyInvited(notification);

    const [payload] = warn.mock.calls[0] ?? [];
    expect(JSON.stringify(payload)).not.toContain("teammate@example.com");
    expect(JSON.stringify(payload)).not.toContain("token-123");
  });
});
