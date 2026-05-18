import { describe, expect, it } from "vitest";

import { renderEmailVerificationEmail } from "./emailVerificationEmail.js";
import { renderPasswordResetEmail } from "./passwordResetEmail.js";

describe("renderPasswordResetEmail", () => {
  it("embeds the reset URL in text + HTML and tags metadata", () => {
    const message = renderPasswordResetEmail({
      to: "grace@example.com",
      resetUrl: "https://app.example.com/reset?token=secret",
    });

    expect(message.subject).toBe("Reset your password");
    expect(message.text).toContain("https://app.example.com/reset?token=secret");
    expect(message.html).toContain("https://app.example.com/reset?token=secret");
    expect(message.metadata).toEqual({
      kind: "password_reset",
      resetUrl: "https://app.example.com/reset?token=secret",
    });
  });
});

describe("renderEmailVerificationEmail", () => {
  it("embeds the verification URL in text + HTML and tags metadata", () => {
    const message = renderEmailVerificationEmail({
      to: "grace@example.com",
      verificationUrl: "https://app.example.com/verify-email?token=secret",
    });

    expect(message.subject).toBe("Verify your email");
    expect(message.text).toContain("https://app.example.com/verify-email?token=secret");
    expect(message.html).toContain("https://app.example.com/verify-email?token=secret");
    expect(message.metadata).toEqual({
      kind: "email_verification",
      verificationUrl: "https://app.example.com/verify-email?token=secret",
    });
  });
});
