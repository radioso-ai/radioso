import { describe, expect, it } from "vitest";

import { findModelListPrice, findPlan, formatPrice, MODEL_SPEND_ESTIMATE, PLAN_CATALOG } from "../src/index.js";

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
    expect(["exclusive", "inclusive"]).toContain(PLAN_CATALOG.taxBehavior);
    expect(Object.keys(PLAN_CATALOG.countsAs).sort()).toEqual(
      ["conversation", "copilot", "other", "pulse_report", "test_run"],
    );
  });

  it("prices every Stripe price excluding VAT, so Stripe Tax adds VAT on top of the catalog number", () => {
    expect(PLAN_CATALOG.taxBehavior).toBe("exclusive");
  });

  it("has unique plan ids", () => {
    const ids = PLAN_CATALOG.plans.map((plan) => plan.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sets a positive daily notification email allowance on every plan", () => {
    expect(PLAN_CATALOG.plans.map((plan) => [plan.id, plan.dailyNotificationEmails])).toEqual([
      ["comet", 10],
      ["satellite", 100],
      ["planet", 500],
    ]);
    for (const plan of PLAN_CATALOG.plans) {
      expect(Number.isInteger(plan.dailyNotificationEmails)).toBe(true);
      expect(plan.dailyNotificationEmails).toBeGreaterThan(0);
    }
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
    ];
    expect(new Set(lookupKeys).size).toBe(lookupKeys.length);
  });

  it("indexes at least as many bytes per month as it stores", () => {
    for (const plan of PLAN_CATALOG.plans) {
      expect(plan.monthlyIndexedBytes).toBeGreaterThanOrEqual(plan.storedBytes);
    }
  });

  it("has at least one managed plan and one byok plan", () => {
    const models = new Set(PLAN_CATALOG.plans.map((plan) => plan.models));
    expect(models.has("managed")).toBe(true);
    expect(models.has("byok")).toBe(true);
  });

  it("prices a Ray turn at half a conversation, the same as a test run (CFO-approved 2026-09-15)", () => {
    expect(PLAN_CATALOG.countsAs.copilot).toBe(0.5);
  });

  it("keeps the conversation grace share a small fraction of the plan limit (0 to 0.5)", () => {
    expect(PLAN_CATALOG.conversationGraceShare).toBeGreaterThanOrEqual(0);
    expect(PLAN_CATALOG.conversationGraceShare).toBeLessThanOrEqual(0.5);
  });

  it("marks every plan's top-up eligibility, off for the free plan and on for every priced plan (CFO-approved 2026-09-15)", () => {
    for (const plan of PLAN_CATALOG.plans) {
      expect(typeof plan.topUps).toBe("boolean");
    }
    const freePlan = findPlan(PLAN_CATALOG.defaultPlanId)!;
    expect(freePlan.priceCents).toBe(0);
    expect(freePlan.topUps).toBe(false);
    for (const plan of PLAN_CATALOG.plans) {
      if (plan.priceCents > 0) {
        expect(plan.topUps).toBe(true);
      }
    }
  });

  it("keeps the auto top-up pack cap between 1 and the per-account limit, and the limit at or under 50", () => {
    const { defaultMaxPacksPerMonth, maxPacksPerMonthLimit } = PLAN_CATALOG.autoTopUp;
    expect(defaultMaxPacksPerMonth).toBeGreaterThanOrEqual(1);
    expect(defaultMaxPacksPerMonth).toBeLessThanOrEqual(maxPacksPerMonthLimit);
    expect(maxPacksPerMonthLimit).toBeLessThanOrEqual(50);
  });
});

describe("findModelListPrice", () => {
  it("returns the list price for a priced provider/model pair", () => {
    expect(findModelListPrice("openai", "gpt-5.4-mini")).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      input: 0.75,
      output: 4.5,
    });
  });

  it("returns undefined for a model the table does not price, or the right model under another provider", () => {
    expect(findModelListPrice("openai", "gpt-unknown")).toBeUndefined();
    expect(findModelListPrice("openai-compatible", "gpt-5.4-mini")).toBeUndefined();
  });
});

describe("model spend estimate (staff-only, never part of the public PLAN_CATALOG)", () => {
  it("keeps list prices, the exchange rate, and the flag out of PLAN_CATALOG, which GET /api/v1/plans serves", () => {
    const publicKeys = Object.keys(PLAN_CATALOG);
    for (const staffKey of [...Object.keys(MODEL_SPEND_ESTIMATE), "modelListPrices"]) {
      expect(publicKeys).not.toContain(staffKey);
    }
  });

  it("prices both managed model slots, so a managed workspace's spend is never left unpriced", () => {
    for (const slot of ["chat", "default"] as const) {
      const { provider, model } = PLAN_CATALOG.managedModels[slot];
      expect(findModelListPrice(provider, model)).toBeDefined();
    }
  });

  it("lists each provider/model pair once, with non-negative prices and an input price on every model", () => {
    const pairs = MODEL_SPEND_ESTIMATE.usdPerMillionTokens.map((price) => `${price.provider}/${price.model}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const price of MODEL_SPEND_ESTIMATE.usdPerMillionTokens) {
      expect(price.input).toBeGreaterThan(0);
      expect(price.output).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps every priced provider inside the set of providers the backend can resolve (the JSON import is cast, not checked)", () => {
    const providers = new Set<string>(["openai", "openai-compatible", "gemini", "claude"]);
    for (const price of MODEL_SPEND_ESTIMATE.usdPerMillionTokens) {
      expect(providers.has(price.provider)).toBe(true);
    }
  });

  it("converts USD list prices into the catalog currency, which eurPerUsd assumes is EUR", () => {
    expect(PLAN_CATALOG.currency).toBe("EUR");
    expect(MODEL_SPEND_ESTIMATE.eurPerUsd).toBe(0.9);
  });

  it("flags an account above €0.04 of model spend per metered conversation, where Planet at full quota drops below 50% gross margin (#1569)", () => {
    expect(MODEL_SPEND_ESTIMATE.conversationSpendFlagEur).toBe(0.04);
  });
});

describe("managed models", () => {
  it("names a chat selection and a default selection, each with a provider and a model", () => {
    for (const slot of ["chat", "default"] as const) {
      const selection = PLAN_CATALOG.managedModels[slot];
      expect(selection.provider.length).toBeGreaterThan(0);
      expect(selection.model.length).toBeGreaterThan(0);
    }
  });

  it("runs both managed slots on the same provider, so one deployment key covers a managed workspace", () => {
    expect(PLAN_CATALOG.managedModels.chat.provider).toBe(PLAN_CATALOG.managedModels.default.provider);
  });

  it("keeps the managed provider inside the set of providers the backend can resolve (the JSON import is cast, not checked)", () => {
    const providers = new Set<string>(["openai", "openai-compatible", "gemini", "claude"]);
    expect(providers.has(PLAN_CATALOG.managedModels.chat.provider)).toBe(true);
    expect(providers.has(PLAN_CATALOG.managedModels.default.provider)).toBe(true);
  });
});
