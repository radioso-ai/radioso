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
    `<p><a href="${input.verificationUrl}">Verify your email address</a> to finish setting up your account.</p>`,
    "<p>If you did not create this account, you can ignore this email.</p>",
  ].join(""),
  metadata: {
    kind: "email_verification",
    verificationUrl: input.verificationUrl,
  },
});
