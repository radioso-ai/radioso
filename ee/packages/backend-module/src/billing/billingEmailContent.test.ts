import { describe, expect, it } from "vitest";

import {
  buildPaymentFailedEmail,
  buildPlanChangedEmail,
  buildSubscriptionEndedEmail,
  resolveBillingNoticeRecipients,
} from "./billingEmailContent.js";

const accountId = "11111111-1111-1111-1111-111111111111";
const appBaseUrl = "https://app.example.com";

describe("buildPlanChangedEmail", () => {
  it("names the new plan and its conversation allowance", () => {
    const email = buildPlanChangedEmail({ accountId, planName: "Satellite", monthlyConversations: 1000, appBaseUrl });
    expect(email.subject).toContain("Satellite");
    expect(email.content.paragraphs.join(" ")).toContain("Satellite: 1000 conversations a month");
    expect(email.content.cta?.href).toBe(`${appBaseUrl}/account/${accountId}/account?tab=usage`);
  });

  it("omits the CTA when appBaseUrl is null", () => {
    const email = buildPlanChangedEmail({ accountId, planName: "Satellite", monthlyConversations: 1000, appBaseUrl: null });
    expect(email.content.cta).toBeUndefined();
  });
});

describe("buildSubscriptionEndedEmail", () => {
  it("names the fallback plan and its conversation allowance", () => {
    const email = buildSubscriptionEndedEmail({ accountId, planName: "Comet", monthlyConversations: 50, appBaseUrl });
    expect(email.content.heading).toBe("Your subscription ended");
    expect(email.content.paragraphs.join(" ")).toContain("Comet: 50 conversations a month");
  });
});

describe("buildPaymentFailedEmail", () => {
  it("builds a subject and CTA matching every other transactional template's voice", () => {
    const email = buildPaymentFailedEmail({ accountId, appBaseUrl });
    expect(email.subject).toBe("Your Radioso payment didn't go through");
    expect(email.content.cta?.label).toBeTruthy();
  });
});

describe("resolveBillingNoticeRecipients", () => {
  it("returns every administrator email when there is no billing email", () => {
    const admins = [{ email: "owner@example.com", displayName: "Owner" }];
    expect(resolveBillingNoticeRecipients(admins, null)).toEqual(["owner@example.com"]);
  });

  it("adds the billing email when it differs from every administrator's", () => {
    const admins = [{ email: "owner@example.com", displayName: "Owner" }];
    expect(resolveBillingNoticeRecipients(admins, "billing@example.com")).toEqual([
      "owner@example.com",
      "billing@example.com",
    ]);
  });

  it("does not duplicate the billing email when it matches an administrator's, case-insensitively", () => {
    const admins = [{ email: "Owner@Example.com", displayName: "Owner" }];
    expect(resolveBillingNoticeRecipients(admins, "owner@example.com")).toEqual(["Owner@Example.com"]);
  });
});
