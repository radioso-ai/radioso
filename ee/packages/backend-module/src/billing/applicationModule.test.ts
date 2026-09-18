import { describe, expect, it } from "vitest";

import { STRIPE_PLAN_METADATA_KEY } from "@radioso/plan-catalog";

import { resolveBillingConfig } from "./applicationModule.js";

describe("resolveBillingConfig", () => {
  it("is unconfigured when the Stripe secret or webhook secret is missing", () => {
    expect(resolveBillingConfig({}).configured).toBe(false);
    expect(resolveBillingConfig({ STRIPE_SECRET_KEY: "sk_test_123" }).configured).toBe(false);
    expect(resolveBillingConfig({ STRIPE_WEBHOOK_SECRET: "whsec_123" }).configured).toBe(false);
  });

  it("is configured once both secrets are present", () => {
    const config = resolveBillingConfig({
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
    });

    expect(config).toEqual({
      configured: true,
      secretKey: "sk_test_123",
      webhookSecret: "whsec_123",
      metadataKey: STRIPE_PLAN_METADATA_KEY,
    });
  });

  it("defaults the metadata key to the catalog's constant", () => {
    expect(resolveBillingConfig({}).metadataKey).toBe(STRIPE_PLAN_METADATA_KEY);
  });

  it("honors a custom metadata key override", () => {
    const config = resolveBillingConfig({
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PLAN_METADATA_KEY: "tier",
    });

    expect(config.metadataKey).toBe("tier");
  });

  it("treats blank env values as missing", () => {
    expect(resolveBillingConfig({ STRIPE_SECRET_KEY: "  ", STRIPE_WEBHOOK_SECRET: "  " }).configured).toBe(false);
  });
});
