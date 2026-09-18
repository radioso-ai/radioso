import { describe, expect, it } from "vitest";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import {
  isTopUpPrice,
  lookupKeyFor,
  planIdForProduct,
  statusFromStripe,
  upgradePlanIdFor,
} from "./planPricing.js";

describe("lookupKeyFor", () => {
  it("returns the catalog's month lookup key for a self-serve plan", () => {
    const satellite = PLAN_CATALOG.plans.find((plan) => plan.id === "satellite")!;
    expect(lookupKeyFor("satellite", "month")).toBe(satellite.stripe!.monthLookupKey);
  });

  it("returns the catalog's year lookup key for a self-serve plan", () => {
    const planet = PLAN_CATALOG.plans.find((plan) => plan.id === "planet")!;
    expect(lookupKeyFor("planet", "year")).toBe(planet.stripe!.yearLookupKey);
  });

  it("returns null for the free plan (no Stripe pricing)", () => {
    expect(lookupKeyFor(PLAN_CATALOG.defaultPlanId, "month")).toBeNull();
  });

  it("returns null for an unknown plan id", () => {
    expect(lookupKeyFor("not-a-plan", "month")).toBeNull();
  });
});

describe("planIdForProduct", () => {
  it("resolves a product's plan metadata to a catalog plan id", () => {
    expect(planIdForProduct({ metadata: { plan: "satellite" } })).toBe("satellite");
  });

  it("respects a custom metadata key", () => {
    expect(planIdForProduct({ metadata: { tier: "planet" } }, "tier")).toBe("planet");
  });

  it("returns null when metadata is missing", () => {
    expect(planIdForProduct({ metadata: {} })).toBeNull();
    expect(planIdForProduct({ metadata: null })).toBeNull();
    expect(planIdForProduct({ metadata: undefined })).toBeNull();
  });

  it("returns null when metadata names a plan with no Stripe pricing", () => {
    expect(planIdForProduct({ metadata: { plan: PLAN_CATALOG.defaultPlanId } })).toBeNull();
  });

  it("returns null when metadata names an id the catalog does not recognize", () => {
    expect(planIdForProduct({ metadata: { plan: "made-up-plan" } })).toBeNull();
  });
});

describe("isTopUpPrice", () => {
  it("is true for the catalog's top-up lookup key", () => {
    expect(isTopUpPrice({ lookup_key: PLAN_CATALOG.topUp.stripeLookupKey })).toBe(true);
  });

  it("is false for any other lookup key", () => {
    expect(isTopUpPrice({ lookup_key: "satellite_month" })).toBe(false);
    expect(isTopUpPrice({ lookup_key: null })).toBe(false);
    expect(isTopUpPrice({ lookup_key: undefined })).toBe(false);
  });
});

describe("upgradePlanIdFor", () => {
  it("returns the next self-serve plan above the free plan", () => {
    const firstSelfServe = PLAN_CATALOG.plans.find((plan) => plan.stripe !== null)!;
    expect(upgradePlanIdFor(PLAN_CATALOG.defaultPlanId)).toBe(firstSelfServe.id);
  });

  it("returns the next self-serve plan above a mid-tier plan", () => {
    expect(upgradePlanIdFor("satellite")).toBe("planet");
  });

  it("returns null at the self-serve ceiling plan", () => {
    expect(upgradePlanIdFor(PLAN_CATALOG.selfServeCeilingPlanId)).toBeNull();
  });

  it("returns null for an unknown plan id", () => {
    expect(upgradePlanIdFor("not-a-plan")).toBeNull();
  });
});

describe("statusFromStripe", () => {
  it.each([
    ["active", "active"],
    ["trialing", "active"],
    ["past_due", "past_due"],
    ["unpaid", "past_due"],
    ["canceled", "canceled"],
    ["incomplete_expired", "canceled"],
    ["incomplete", "none"],
    ["paused", "none"],
  ] as const)("maps Stripe status %s to %s", (stripeStatus, expected) => {
    expect(statusFromStripe(stripeStatus)).toBe(expected);
  });
});
