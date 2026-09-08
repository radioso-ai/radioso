import type { EmailMessage } from "../emailService.js";
import { renderEmail, renderEmailText, type EmailContent } from "./layout.js";

interface EmailVerificationInput {
  to: string;
  verificationUrl: string;
}

export const renderEmailVerificationEmail = (
  input: EmailVerificationInput,
): Omit<EmailMessage, "from"> => {
  const content: EmailContent = {
    preheader: "Confirm this address so we know your account reaches you.",
    heading: "Verify your email",
    paragraphs: [
      "Welcome to Radioso. Confirm this address to finish setting up your account.",
    ],
    cta: { href: input.verificationUrl, label: "Verify email address" },
    footnote: "If you did not create this account, you can ignore this email.",
  };

  return {
    to: input.to,
    subject: "Verify your email",
    text: renderEmailText(content),
    html: renderEmail(content),
    kind: "email_verification",
    metadata: {
      verificationUrl: input.verificationUrl,
    },
  };
};
