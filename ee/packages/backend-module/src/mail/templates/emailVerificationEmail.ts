import { button } from "../layout/index.js";
import type { RenderedEmail } from "./passwordResetEmail.js";

export interface EmailVerificationInput {
  to: string;
  verificationUrl: string;
}

export const renderEmailVerificationEmail = (input: EmailVerificationInput): RenderedEmail => ({
  to: input.to,
  subject: "Verify your email",
  text: [
    "Welcome to Radioso.",
    "",
    `Verify your email address to finish setting up your account: ${input.verificationUrl}`,
    "",
    "If you did not create this account, you can ignore this email.",
  ].join("\n"),
  html: [
    "<p>Welcome to Radioso.</p>",
    "<p>Verify your email address to finish setting up your account.</p>",
    button({ href: input.verificationUrl, label: "Verify email address" }),
    "<p>If you did not create this account, you can ignore this email.</p>",
  ].join(""),
  metadata: {
    kind: "email_verification",
    verificationUrl: input.verificationUrl,
  },
});
