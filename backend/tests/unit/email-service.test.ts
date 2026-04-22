import { describe, expect, it } from "vitest";

import { EmailService } from "../../src/modules/email/services/emailService.js";
import type { EmailDriver } from "../../src/modules/email/services/emailService.js";

class RecordingDriver implements EmailDriver {
  readonly sent: Parameters<EmailDriver["send"]>[0][] = [];

  async send(message: Parameters<EmailDriver["send"]>[0]): Promise<void> {
    this.sent.push(message);
  }
}

describe("EmailService", () => {
  it("composes password reset email through the shared message contract", async () => {
    const driver = new RecordingDriver();
    const service = new EmailService(driver, {
      fromEmail: "noreply@example.com",
      fromName: "Radioso",
    });

    await service.sendPasswordResetEmail({
      to: "user@example.com",
      resetUrl: "https://app.example.com/reset-password?token=abc123",
    });

    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]).toMatchObject({
      to: "user@example.com",
      from: {
        email: "noreply@example.com",
        name: "Radioso",
      },
    });
    expect(driver.sent[0]?.subject).toContain("password");
    expect(driver.sent[0]?.text).toContain("https://app.example.com/reset-password?token=abc123");
  });
});
