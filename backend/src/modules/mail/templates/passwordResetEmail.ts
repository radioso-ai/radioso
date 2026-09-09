import type { EmailMessage } from "../emailService.js";
import { renderEmail, renderEmailText, type EmailContent } from "./layout.js";

interface PasswordResetEmailInput {
  to: string;
  /** Public frontend origin; the layout serves the brand lockup from it. */
  appBaseUrl?: string | null;
  resetUrl: string;
}

export const renderPasswordResetEmail = (
  input: PasswordResetEmailInput,
): Omit<EmailMessage, "from"> => {
  const content: EmailContent = {
    preheader: "Choose a new password using the link inside.",
    heading: "Reset your password",
    paragraphs: [
      "We received a request to reset the password for your Radioso account.",
    ],
    cta: { href: input.resetUrl, label: "Choose a new password" },
    footnote: "If you did not request this, you can ignore this email. Your password stays as it is.",
  };

  return {
    to: input.to,
    subject: "Reset your password",
    text: renderEmailText(content),
    html: renderEmail(content, { appBaseUrl: input.appBaseUrl }),
    kind: "password_reset",
    metadata: {
      resetUrl: input.resetUrl,
    },
  };
};
