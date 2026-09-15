import { describe, expect, it } from "vitest";

import { findPlan, formatPrice, PLAN_CATALOG } from "../src/index.js";

describe("findPlan", () => {
  it("returns the plan for a known id", () => {
    const plan = findPlan("satellite");
    expect(plan?.name).toBe("Satellite");
  });

  it("returns undefined for an unknown id", () => {
    expect(findPlan("moon")).toBeUndefined();
  });
});

describe("formatPrice", () => {
  it("formats a whole-euro amount with no fraction digits", () => {
    expect(formatPrice(14900)).toBe("€149");
  });

  it("formats a four-digit amount with a thousands separator", () => {
    expect(formatPrice(149000)).toBe("€1,490");
  });

  it("formats a small whole amount", () => {
    expect(formatPrice(5000)).toBe("€50");
  });

  it("keeps fraction digits when the amount is not whole", () => {
    expect(formatPrice(14950)).toBe("€149.50");
  });

  it("accepts an explicit currency override", () => {
    expect(formatPrice(10000, "USD")).toBe("$100");
  });
});

describe("catalog invariants", () => {
  it("keeps every enum-like field inside its declared union (the JSON import is cast, not checked)", () => {
    const models = new Set(["managed", "byok"]);
    const support = new Set(["community", "email", "priority"]);
    for (const plan of PLAN_CATALOG.plans) {
      expect(models.has(plan.models)).toBe(true);
      expect(support.has(plan.support)).toBe(true);
      expect(plan.interval).toBe("month");
    }
    expect(PLAN_CATALOG.managedService.interval).toBe("month");
    expect(Object.keys(PLAN_CATALOG.countsAs).sort()).toEqual(
      ["conversation", "copilot", "other", "pulse_report", "test_run"],
    );
  });

  it("has unique plan ids", () => {
    const ids = PLAN_CATALOG.plans.map((plan) => plan.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves defaultPlanId to a real plan", () => {
    expect(findPlan(PLAN_CATALOG.defaultPlanId)).toBeDefined();
  });

  it("resolves selfServeCeilingPlanId to a real plan", () => {
    expect(findPlan(PLAN_CATALOG.selfServeCeilingPlanId)).toBeDefined();
  });

  it("has exactly one free plan, and it is the default plan", () => {
    const freePlans = PLAN_CATALOG.plans.filter((plan) => plan.priceCents === 0);
    expect(freePlans).toHaveLength(1);
    expect(freePlans[0]?.id).toBe(PLAN_CATALOG.defaultPlanId);
  });

  it("gives every non-free plan a Stripe lookup key per interval", () => {
    for (const plan of PLAN_CATALOG.plans) {
      if (plan.priceCents === 0) {
        expect(plan.stripe).toBeNull();
      } else {
        expect(plan.stripe).not.toBeNull();
        expect(plan.stripe?.monthLookupKey).toBeTruthy();
        expect(plan.stripe?.yearLookupKey).toBeTruthy();
      }
    }
  });

  it("never reuses a Stripe lookup key across plans, top-up, or the managed service", () => {
    const lookupKeys = [
      ...PLAN_CATALOG.plans.flatMap((plan) => (plan.stripe ? [plan.stripe.monthLookupKey, plan.stripe.yearLookupKey] : [])),
      PLAN_CATALOG.topUp.stripeLookupKey,
      PLAN_CATALOG.managedService.stripeLookupKey,
    ];
    expect(new Set(lookupKeys).size).toBe(lookupKeys.length);
  });

  it("indexes at least as many bytes per month as it stores", () => {
    for (const plan of PLAN_CATALOG.plans) {
      expect(plan.monthlyIndexedBytes).toBeGreaterThanOrEqual(plan.storedBytes);
    }
  });
});
