import type { AccountAdministratorContact, NoticeEmailContent } from "../radiosoModuleTypes.js";

/**
 * Pure branded billing-notice builders, mirroring `usageLimits/alerts/alertContent.ts`'s split
 * from its dispatcher: this file only assembles `{ subject, content }`; `billingWebhookHandler.ts`
 * resolves recipients and sends. English-only copy, matching every other transactional template
 * (`backend/src/modules/mail/templates/`) -- these are account-admin notices the platform sends,
 * not agent output, so the multilingual rule for conversational copy does not apply.
 */

interface BillingEmail {
  subject: string;
  content: NoticeEmailContent;
}

const usageCta = (accountId: string, appBaseUrl: string | null): NoticeEmailContent["cta"] =>
  appBaseUrl ? { href: `${appBaseUrl}/account/${accountId}/account?tab=usage`, label: "View usage and billing" } : undefined;

export const buildPlanChangedEmail = (input: {
  accountId: string;
  planName: string;
  monthlyConversations: number;
  appBaseUrl: string | null;
}): BillingEmail => {
  const cta = usageCta(input.accountId, input.appBaseUrl);
  return {
    subject: `Your plan is now ${input.planName}`,
    content: {
      preheader: `Your plan is now ${input.planName}.`,
      heading: `Your plan is now ${input.planName}`,
      paragraphs: [`Your plan is now ${input.planName}: ${input.monthlyConversations} conversations a month.`],
      ...(cta ? { cta } : {}),
    },
  };
};

export const buildSubscriptionEndedEmail = (input: {
  accountId: string;
  planName: string;
  monthlyConversations: number;
  appBaseUrl: string | null;
}): BillingEmail => {
  const cta = usageCta(input.accountId, input.appBaseUrl);
  return {
    subject: "Your subscription ended",
    content: {
      preheader: "Your subscription ended.",
      heading: "Your subscription ended",
      paragraphs: [
        `Your subscription ended. You're on ${input.planName}: ${input.monthlyConversations} conversations a month.`,
      ],
      ...(cta ? { cta } : {}),
    },
  };
};

export const buildPaymentFailedEmail = (input: { accountId: string; appBaseUrl: string | null }): BillingEmail => {
  const cta = usageCta(input.accountId, input.appBaseUrl);
  return {
    subject: "Your Radioso payment didn't go through",
    content: {
      preheader: "We couldn't process your latest payment.",
      heading: "Your payment didn't go through",
      paragraphs: ["We couldn't process your latest payment.", "Update your billing details to keep agents answering."],
      ...(cta ? { cta } : {}),
    },
  };
};

/** Active owners + admins, plus the customer's billing email when it is set and differs from
 *  every admin contact's -- deduped case-insensitively, since the same mailbox should never get
 *  the same notice twice. */
export const resolveBillingNoticeRecipients = (
  administrators: readonly AccountAdministratorContact[],
  billingEmail: string | null,
): string[] => {
  const emails = administrators.map((admin) => admin.email);
  if (!billingEmail) {
    return emails;
  }
  const known = new Set(emails.map((email) => email.toLowerCase()));
  return known.has(billingEmail.toLowerCase()) ? emails : [...emails, billingEmail];
};
