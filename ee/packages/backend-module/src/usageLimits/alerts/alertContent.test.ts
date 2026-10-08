import { describe, expect, it } from "vitest";

import { buildAlertEmail } from "./alertContent.js";

const baseInput = {
  accountId: "11111111-1111-4111-8111-111111111111",
  used: 400,
  capacity: 500,
  graceLimit: 5,
  resetAt: "2026-11-01T00:00:00.000Z",
  appBaseUrl: "https://app.example.com",
};

describe("buildAlertEmail", () => {
  it("builds the nearing_limit email: subject, usage sentence, 100% preview, and a top-up CTA on a plan that sells them", () => {
    const email = buildAlertEmail({ ...baseInput, level: "nearing_limit", planId: "satellite" });

    expect(email.subject).toBe("You've used 80% of this month's conversations");
    expect(email.content.paragraphs[0]).toContain("400 of 500 conversations this month");
    expect(email.content.paragraphs[1]).toMatch(/100%/);
    expect(email.content.paragraphs[1]).toContain("up to 5 extra conversations");
    expect(email.content.paragraphs[1]).toContain("repaid from your next top-up");
    expect(email.content.cta).toEqual({
      href: "https://app.example.com/account/11111111-1111-4111-8111-111111111111/account?tab=usage",
      label: "Top up or upgrade",
    });
  });

  it("builds the limit_reached email without a repayment clause on a plan with no top-up pack", () => {
    const email = buildAlertEmail({ ...baseInput, level: "limit_reached", planId: "comet" });

    expect(email.subject).toBe("This month's conversations are used up");
    expect(email.content.paragraphs[1]).toContain("up to 5 more conversations");
    expect(email.content.paragraphs[1]).not.toContain("repaid");
    expect(email.content.paragraphs[1]).toContain("Ray, Test Chat, and Pulse");
    expect(email.content.cta).toEqual({
      href: "https://app.example.com/account/11111111-1111-4111-8111-111111111111/account?tab=usage",
      label: "Upgrade",
    });
  });

  it("builds the grace_exhausted email describing the visitor-facing unavailable state", () => {
    const email = buildAlertEmail({ ...baseInput, level: "grace_exhausted", planId: "satellite" });

    expect(email.subject).toBe("Your agents stopped answering visitors");
    expect(email.content.paragraphs[1]).toContain("unavailable message");
    expect(email.content.paragraphs[1]).toContain("until you add conversations");
  });

  it("omits the call to action and uses an upgrade-only clause for an unrecognized plan id", () => {
    const email = buildAlertEmail({ ...baseInput, level: "limit_reached", planId: "legacy_profile", appBaseUrl: null });

    expect(email.content.cta).toBeUndefined();
    expect(email.content.paragraphs[1]).not.toContain("repaid");
  });

  it("omits the call to action when appBaseUrl is null even on a top-up-eligible plan", () => {
    const email = buildAlertEmail({ ...baseInput, level: "nearing_limit", planId: "satellite", appBaseUrl: null });

    expect(email.content.cta).toBeUndefined();
  });

  it("treats a null plan id as not top-up eligible", () => {
    const email = buildAlertEmail({ ...baseInput, level: "limit_reached", planId: null });

    expect(email.content.cta?.label).toBe("Upgrade");
    expect(email.content.paragraphs[1]).not.toContain("repaid");
  });

  it("formats a fractional conversation count to one decimal and a whole count with no decimal", () => {
    const whole = buildAlertEmail({ ...baseInput, level: "nearing_limit", planId: "satellite", used: 80, capacity: 100 });
    expect(whole.content.paragraphs[0]).toContain("80 of 100");

    const fractional = buildAlertEmail({
      ...baseInput, level: "nearing_limit", planId: "satellite", used: 40.5, capacity: 50, graceLimit: 2.5,
    });
    expect(fractional.content.paragraphs[0]).toContain("40.5 of 50");
  });

  it("includes a preheader distinct from the heading for every level", () => {
    for (const level of ["nearing_limit", "limit_reached", "grace_exhausted"] as const) {
      const email = buildAlertEmail({ ...baseInput, level, planId: "satellite" });
      expect(email.content.preheader.length).toBeGreaterThan(0);
      expect(email.content.heading.length).toBeGreaterThan(0);
    }
  });
});
