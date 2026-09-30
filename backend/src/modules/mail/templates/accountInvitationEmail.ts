import type { EmailMessage } from "../emailService.js";
import { renderEmail, renderEmailText, type EmailContent } from "./layout.js";

interface AccountInvitationEmailInput {
  to: string;
  /** Public frontend origin; the layout serves the brand lockup from it. */
  appBaseUrl?: string | null;
  acceptanceUrl: string;
  invitedByEmail: string | null;
  /** The inviter's chosen name. Shown with their address, since the invitee may not know the name. */
  invitedByName: string | null;
  expiresAt: Date;
}

const formatExpiry = (expiresAt: Date): string =>
  expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const inviterLabel = (input: { invitedByEmail: string | null; invitedByName: string | null }): string | null => {
  if (input.invitedByName && input.invitedByEmail) {
    return `${input.invitedByName} (${input.invitedByEmail})`;
  }
  return input.invitedByEmail ?? input.invitedByName;
};

export const renderAccountInvitationEmail = (
  input: AccountInvitationEmailInput,
): Omit<EmailMessage, "from"> => {
  const inviter = inviterLabel(input);
  const invitedBy = inviter
    ? `${inviter} invited you to join their Radioso organization.`
    : "You have been invited to join a Radioso organization.";

  const content: EmailContent = {
    preheader: "Accept the invitation to join the organization.",
    heading: "You have been invited to Radioso",
    paragraphs: [invitedBy],
    cta: { href: input.acceptanceUrl, label: "Accept invitation" },
    metaRows: [{ label: "Expires", value: formatExpiry(input.expiresAt) }],
    footnote: "If you were not expecting this, you can ignore this email.",
  };

  return {
    to: input.to,
    subject: "You have been invited to Radioso",
    text: renderEmailText(content),
    html: renderEmail(content, { appBaseUrl: input.appBaseUrl }),
    kind: "account_invitation",
    // The acceptance URL carries a live invitation token, so it is deliberately absent from
    // metadata, which the log driver writes verbatim.
  };
};
