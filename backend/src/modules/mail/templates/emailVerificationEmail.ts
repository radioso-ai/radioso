import type { EmailMessage } from "../emailService.js";
import { button } from "./layout.js";

export interface EmailVerificationInput {
  to: string;
  verificationUrl: string;
}

export const renderEmailVerificationEmail = (
  input: EmailVerificationInput,
): Omit<EmailMessage, "from"> => ({
  to: input.to,
  subject: "Verify your email",
  text: [
    "Welcome to Radioso.",
    "",
    `Verify your email address: ${input.verificationUrl}`,
    "",
    "If you did not create this account, you can ignore this email.",
  ].join("\n"),
  html: [
    "<p>Welcome to Radioso.</p>",
    "<p>Verify your email address.</p>",
    button({ href: input.verificationUrl, label: "Verify email address" }),
    "<p>If you did not create this account, you can ignore this email.</p>",
  ].join(""),
  metadata: {
    kind: "email_verification",
    verificationUrl: input.verificationUrl,
  },
});
