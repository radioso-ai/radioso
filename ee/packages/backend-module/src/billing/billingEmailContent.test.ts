import { describe, expect, it } from "vitest";

import {
  buildAutoTopUpFailedEmail,
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

describe("buildAutoTopUpFailedEmail", () => {
  it("never mentions a Stripe invoice URL -- the log mail driver prints full text", () => {
    const email = buildAutoTopUpFailedEmail({ accountId, appBaseUrl });
    expect(email.content.paragraphs.some((p) => p.includes("http"))).toBe(false);
    expect(JSON.stringify(email)).not.toContain("invoice.stripe.com");
  });

  it("links to the usage tab, not the invoice", () => {
    const email = buildAutoTopUpFailedEmail({ accountId, appBaseUrl });
    expect(email.content.cta?.href).toBe(`${appBaseUrl}/account/${accountId}/account?tab=usage`);
  });
});

describe("resolveBillingNoticeRecipients", () => {
  it("returns every administrator email, and only administrator emails", () => {
    const admins = [
      { email: "owner@example.com", displayName: "Owner" },
      { email: "admin@example.com", displayName: "Admin" },
    ];
    expect(resolveBillingNoticeRecipients(admins)).toEqual(["owner@example.com", "admin@example.com"]);
  });

  it("returns no recipients for an account with no active owners or admins", () => {
    expect(resolveBillingNoticeRecipients([])).toEqual([]);
  });
});
