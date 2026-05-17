import { button } from "../layout/index.js";

export interface PasswordResetEmailInput {
  to: string;
  resetUrl: string;
}

export interface RenderedEmail {
  to: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html?: string;
  metadata?: Record<string, string>;
}

export const renderPasswordResetEmail = (input: PasswordResetEmailInput): RenderedEmail => ({
  to: input.to,
  subject: "Reset your password",
  text: [
    "We received a request to reset your Radioso password.",
    "",
    `Use this link to choose a new password: ${input.resetUrl}`,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n"),
  html: [
    "<p>We received a request to reset your Radioso password.</p>",
    button({ href: input.resetUrl, label: "Choose a new password" }),
    "<p>If you did not request this, you can ignore this email.</p>",
  ].join(""),
  metadata: {
    kind: "password_reset",
    resetUrl: input.resetUrl,
  },
});
