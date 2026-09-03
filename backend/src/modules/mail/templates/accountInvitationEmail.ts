import type { EmailMessage } from "../emailService.js";
import { button, escapeHtml } from "./layout.js";

export interface AccountInvitationEmailInput {
  to: string;
  acceptanceUrl: string;
  invitedByEmail: string | null;
  expiresAt: Date;
}

const formatExpiry = (expiresAt: Date): string =>
  expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export const renderAccountInvitationEmail = (
  input: AccountInvitationEmailInput,
): Omit<EmailMessage, "from"> => {
  const invitedBy = input.invitedByEmail
    ? `${input.invitedByEmail} invited you to join their Radioso organization.`
    : "You have been invited to join a Radioso organization.";
  const expiry = `This invitation expires on ${formatExpiry(input.expiresAt)}.`;

  return {
    to: input.to,
    subject: "You have been invited to Radioso",
    text: [
      invitedBy,
      "",
      `Accept the invitation here: ${input.acceptanceUrl}`,
      "",
      expiry,
      "If you were not expecting this, you can ignore this email.",
    ].join("\n"),
    html: [
      `<p>${escapeHtml(invitedBy)}</p>`,
      button({ href: input.acceptanceUrl, label: "Accept invitation" }),
      `<p>${escapeHtml(expiry)}</p>`,
      "<p>If you were not expecting this, you can ignore this email.</p>",
    ].join(""),
    // The acceptance URL carries a live invitation token, so it is deliberately absent from
    // metadata, which the log driver writes verbatim.
    metadata: {
      kind: "account_invitation",
    },
  };
};
