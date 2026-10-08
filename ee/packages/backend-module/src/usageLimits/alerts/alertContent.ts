import { isTopUpEligible } from "../../billing/planPricing.js";
import type { NoticeEmailContent } from "../../radiosoModuleTypes.js";
import type { AlertLevel } from "./alertLevelOrder.js";

interface AlertEmailInput {
  level: AlertLevel;
  accountId: string;
  /** The catalog plan id backing the account's assigned profile, or `null` when the profile is
   *  not a catalog plan (a legacy or hand-assigned profile) — treated as not top-up eligible,
   *  the same default `isTopUpEligible` gives an unrecognized plan id. */
  planId: string | null;
  /** Conversations, not tenths. */
  used: number;
  capacity: number;
  graceLimit: number;
  /** ISO timestamp of the next period's start. */
  resetAt: string;
  /** Null when `APP_BASE_URL` is unset; the call to action is omitted entirely. */
  appBaseUrl: string | null;
}

export interface AlertEmail {
  subject: string;
  content: NoticeEmailContent;
}

/** Whole counts print with no decimal; everything else to one, since ten test runs are one
 *  conversation and a half-spent grace reads as "2.5", not "2.50" or "2". */
const formatConversations = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

const formatResetDate = (resetAt: string): string =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(resetAt));

const usageSentence = (input: AlertEmailInput): string =>
  `You've used ${formatConversations(input.used)} of ${formatConversations(input.capacity)} conversations ` +
  `this month. The next reset is ${formatResetDate(input.resetAt)}.`;

const deepLink = (input: AlertEmailInput): string | null =>
  input.appBaseUrl ? `${input.appBaseUrl}/account/${input.accountId}/account?tab=usage` : null;

const topUpEligible = (input: AlertEmailInput): boolean =>
  input.planId !== null && isTopUpEligible(input.planId);

const callToAction = (input: AlertEmailInput): NoticeEmailContent["cta"] => {
  const href = deepLink(input);
  if (!href) {
    return undefined;
  }
  return { href, label: topUpEligible(input) ? "Top up or upgrade" : "Upgrade" };
};

/**
 * One pure email per alert level. English-only copy (the product is multilingual elsewhere, but
 * these are operator-facing account-admin notices sent by the platform, not agent output) —
 * terse, no exclamation marks, matching the voice of every other transactional template
 * (`backend/src/modules/mail/templates/`). The CTA wording and the repayment clause both depend
 * on whether the account's plan sells the conversation top-up pack; neither appears when the
 * plan does not, or when `appBaseUrl` leaves no link to send.
 */
export const buildAlertEmail = (input: AlertEmailInput): AlertEmail => {
  const cta = callToAction(input);
  const grace = formatConversations(input.graceLimit);
  const repaidClause = topUpEligible(input) ? ", repaid from your next top-up" : "";

  switch (input.level) {
    case "nearing_limit":
      return {
        subject: "You've used 80% of this month's conversations",
        content: {
          preheader: "80% of this month's conversations used.",
          heading: "You're nearing this month's conversation limit",
          paragraphs: [
            usageSentence(input),
            `At 100%, visitors keep getting answered — up to ${grace} extra conversations${repaidClause}. ` +
              "Ray, Test Chat, and Pulse will pause until the reset date.",
          ],
          ...(cta ? { cta } : {}),
        },
      };
    case "limit_reached":
      return {
        subject: "This month's conversations are used up",
        content: {
          preheader: "This month's conversations are used up.",
          heading: "This month's conversations are used up",
          paragraphs: [
            usageSentence(input),
            `Visitors keep getting answered — up to ${grace} more conversations${repaidClause}. ` +
              "Ray, Test Chat, and Pulse are paused until the reset date.",
          ],
          ...(cta ? { cta } : {}),
        },
      };
    case "grace_exhausted": {
      const untilClause = topUpEligible(input) ? " or until you add conversations" : "";
      return {
        subject: "Your agents stopped answering visitors",
        content: {
          preheader: "Visitors are not getting answers right now.",
          heading: "Your agents stopped answering visitors",
          paragraphs: [
            usageSentence(input),
            `Visitors now see an unavailable message until the reset date${untilClause}.`,
          ],
          ...(cta ? { cta } : {}),
        },
      };
    }
  }
};
