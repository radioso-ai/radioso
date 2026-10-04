import { describe, expect, it } from "vitest";

import { PLAN_CATALOG, STRIPE_PLAN_METADATA_KEY, type Plan } from "@radioso/plan-catalog";

import type {
  StripePortalProduct,
  StripePriceState,
  StripeProductState,
} from "./stripeCatalogAdmin.js";
import {
  desiredStripeCatalog,
  planStripeCatalogSync,
  type DesiredStripeCatalog,
  type StripeCatalogState,
  type StripeCatalogSyncAction,
} from "./stripeCatalogSync.js";
import { STRIPE_WEBHOOK_EVENT_TYPES } from "./stripeGateway.js";

const WEBHOOK_URL = "https://app.example.com/api/v1/ee/billing/webhook";
const API_VERSION = "2026-08-26.dahlia";
const SAAS_TAX_CODE = "txcd_10103001";

const paidPlans: Plan[] = PLAN_CATALOG.plans.filter((plan) => plan.stripe !== null);
const satellite = PLAN_CATALOG.plans.find((plan) => plan.id === "satellite")!;

const desired = (webhook = true): DesiredStripeCatalog =>
  desiredStripeCatalog(PLAN_CATALOG, {
    metadataKey: STRIPE_PLAN_METADATA_KEY,
    webhook: webhook ? { url: WEBHOOK_URL, apiVersion: API_VERSION } : undefined,
  });

const priceIdFor = (lookupKey: string): string => `price_${lookupKey}`;

/** A Stripe account that already matches the desired catalog exactly. */
const matchingState = (target: DesiredStripeCatalog): StripeCatalogState => {
  const products = new Map<string, StripeProductState>(
    target.products.map((product) => [
      product.id,
      { id: product.id, name: product.name, active: true, taxCode: product.taxCode, metadata: { ...product.metadata } },
    ]),
  );
  const prices = new Map<string, StripePriceState>(
    target.prices.map((price) => [
      price.lookupKey,
      {
        id: priceIdFor(price.lookupKey),
        lookupKey: price.lookupKey,
        active: true,
        productId: price.productId,
        unitAmount: price.unitAmount,
        currency: price.currency,
        recurring: price.recurringInterval ? { interval: price.recurringInterval, intervalCount: 1 } : null,
        taxBehavior: price.taxBehavior,
      },
    ]),
  );
  const portalProducts: StripePortalProduct[] = target.portalProducts.map((product) => ({
    productId: product.productId,
    priceIds: product.lookupKeys.map(priceIdFor),
  }));
  return {
    products,
    prices,
    portal: {
      id: "bpc_default",
      isDefault: true,
      features: {
        customerUpdate: { enabled: true, allowedUpdates: ["name", "email", "address", "tax_id"] },
        invoiceHistory: { enabled: true },
        paymentMethodUpdate: { enabled: true },
        subscriptionCancel: { enabled: true, mode: "at_period_end" },
        subscriptionUpdate: {
          enabled: true,
          defaultAllowedUpdates: ["price"],
          prorationBehavior: "always_invoice",
          products: portalProducts,
        },
      },
    },
    webhookEndpoints: target.webhook
      ? [{ id: "we_1", url: target.webhook.url, enabledEvents: [...target.webhook.enabledEvents].reverse(), apiVersion: API_VERSION, enabled: true }]
      : [],
    tax: { status: "active", missingFields: [], defaultTaxBehavior: "exclusive", defaultTaxCode: SAAS_TAX_CODE },
    activeTaxRegistrations: 1,
  };
};

const emptyState = (): StripeCatalogState => ({
  products: new Map(),
  prices: new Map(),
  portal: null,
  webhookEndpoints: [],
  tax: { status: "pending", missingFields: ["head_office"], defaultTaxBehavior: null, defaultTaxCode: null },
  activeTaxRegistrations: 0,
});

const withPrice = (
  state: StripeCatalogState,
  lookupKey: string,
  patch: Partial<StripePriceState>,
): StripeCatalogState => {
  const prices = new Map(state.prices);
  prices.set(lookupKey, { ...prices.get(lookupKey)!, ...patch });
  return { ...state, prices };
};

const withProduct = (
  state: StripeCatalogState,
  productId: string,
  patch: Partial<StripeProductState>,
): StripeCatalogState => {
  const products = new Map(state.products);
  products.set(productId, { ...products.get(productId)!, ...patch });
  return { ...state, products };
};

const kinds = (actions: readonly StripeCatalogSyncAction[]): string[] => actions.map((action) => action.kind);

describe("desiredStripeCatalog", () => {
  it("maps every paid plan to one product with a fixed id, the plan metadata, and the SaaS tax code", () => {
    const target = desired();
    for (const plan of paidPlans) {
      expect(target.products).toContainEqual({
        id: `radioso_plan_${plan.id}`,
        name: `Radioso ${plan.name}`,
        taxCode: SAAS_TAX_CODE,
        metadata: { [STRIPE_PLAN_METADATA_KEY]: plan.id },
      });
    }
    expect(target.products.map((product) => product.id)).not.toContain("radioso_plan_comet");
  });

  it("gives each plan product a monthly and an annual price under the catalog lookup keys", () => {
    const target = desired();
    for (const plan of paidPlans) {
      expect(target.prices).toContainEqual({
        lookupKey: plan.stripe!.monthLookupKey,
        productId: `radioso_plan_${plan.id}`,
        unitAmount: plan.priceCents,
        currency: PLAN_CATALOG.currency.toLowerCase(),
        recurringInterval: "month",
        taxBehavior: PLAN_CATALOG.taxBehavior,
      });
      expect(target.prices).toContainEqual({
        lookupKey: plan.stripe!.yearLookupKey,
        productId: `radioso_plan_${plan.id}`,
        unitAmount: plan.annualPriceCents,
        currency: PLAN_CATALOG.currency.toLowerCase(),
        recurringInterval: "year",
        taxBehavior: PLAN_CATALOG.taxBehavior,
      });
    }
  });

  it("maps the top-up to a one-time price on a product that grants no plan", () => {
    const target = desired();
    const product = target.products.find((candidate) => candidate.id === "radioso_topup");
    expect(product?.metadata).toEqual({});
    expect(product?.name).toContain(String(PLAN_CATALOG.topUp.conversations));
    expect(target.prices).toContainEqual({
      lookupKey: PLAN_CATALOG.topUp.stripeLookupKey,
      productId: "radioso_topup",
      unitAmount: PLAN_CATALOG.topUp.priceCents,
      currency: "eur",
      recurringInterval: null,
      taxBehavior: "exclusive",
    });
  });

  it("maps the managed service to a monthly price on a product that grants no plan", () => {
    const target = desired();
    const product = target.products.find((candidate) => candidate.id === "radioso_managed_service");
    expect(product?.metadata).toEqual({});
    expect(product?.taxCode).toBe(SAAS_TAX_CODE);
    expect(target.prices).toContainEqual({
      lookupKey: PLAN_CATALOG.managedService.stripeLookupKey,
      productId: "radioso_managed_service",
      unitAmount: PLAN_CATALOG.managedService.priceCents,
      currency: "eur",
      recurringInterval: "month",
      taxBehavior: "exclusive",
    });
  });

  it("writes the plan id under an overridden metadata key", () => {
    const target = desiredStripeCatalog(PLAN_CATALOG, { metadataKey: "radioso_plan" });
    expect(target.metadataKey).toBe("radioso_plan");
    expect(target.products.find((product) => product.id === "radioso_plan_satellite")?.metadata).toEqual({
      radioso_plan: "satellite",
    });
  });

  it("offers every plan's monthly and annual price in the customer portal", () => {
    expect(desired().portalProducts).toEqual(
      paidPlans.map((plan) => ({
        productId: `radioso_plan_${plan.id}`,
        lookupKeys: [plan.stripe!.monthLookupKey, plan.stripe!.yearLookupKey],
      })),
    );
  });

  it("subscribes the webhook to exactly the events the billing runtime acts on", () => {
    expect(desired().webhook).toEqual({
      url: WEBHOOK_URL,
      enabledEvents: [...STRIPE_WEBHOOK_EVENT_TYPES],
      apiVersion: API_VERSION,
    });
    expect(desired(false).webhook).toBeNull();
  });

  it("sets the account tax defaults to the catalog tax behavior and the SaaS tax code", () => {
    expect(desired().tax).toEqual({ taxBehavior: "exclusive", taxCode: SAAS_TAX_CODE });
  });
});

describe("planStripeCatalogSync", () => {
  it("creates everything on an empty account, products before prices before the portal", () => {
    const target = desired();
    const plan = planStripeCatalogSync(target, emptyState());

    expect(kinds(plan.actions)).toEqual([
      ...target.products.map(() => "create_product"),
      ...target.prices.map(() => "create_price"),
      "update_tax_defaults",
      "create_portal_configuration",
      "create_webhook_endpoint",
    ]);
    for (const action of plan.actions) {
      if (action.kind === "create_price") {
        expect(action.transferLookupKey).toBe(false);
      }
    }
  });

  it("plans nothing for an account that already matches the catalog", () => {
    const target = desired();
    expect(planStripeCatalogSync(target, matchingState(target)).actions).toEqual([]);
  });

  it("creates a new price and transfers the lookup key when the amount changed, leaving the old price active", () => {
    const target = desired();
    const key = satellite.stripe!.monthLookupKey;
    const state = withPrice(matchingState(target), key, { unitAmount: satellite.priceCents - 1000 });

    const plan = planStripeCatalogSync(target, state);

    expect(plan.actions).toContainEqual({
      kind: "create_price",
      price: target.prices.find((price) => price.lookupKey === key),
      transferLookupKey: true,
      replaces: { priceId: priceIdFor(key), productId: "radioso_plan_satellite" },
    });
    // The new price id only exists after the create, so the portal must be re-pointed.
    expect(kinds(plan.actions)).toEqual(["create_price", "update_portal_configuration"]);
  });

  it("transfers the lookup key when the price sits on the wrong product", () => {
    const target = desired();
    const key = satellite.stripe!.yearLookupKey;
    const state = withPrice(matchingState(target), key, { productId: "prod_handmade" });

    const create = planStripeCatalogSync(target, state).actions.find((action) => action.kind === "create_price");

    expect(create).toMatchObject({ transferLookupKey: true, replaces: { productId: "prod_handmade" } });
  });

  it("transfers the lookup key when the interval, currency, or tax behavior differ, or the price is archived", () => {
    const target = desired();
    const key = satellite.stripe!.monthLookupKey;
    const patches: Partial<StripePriceState>[] = [
      { recurring: { interval: "year", intervalCount: 1 } },
      { recurring: { interval: "month", intervalCount: 3 } },
      { recurring: null },
      { currency: "usd" },
      { taxBehavior: "inclusive" },
      { active: false },
    ];
    for (const patch of patches) {
      const plan = planStripeCatalogSync(target, withPrice(matchingState(target), key, patch));
      expect(plan.actions[0], JSON.stringify(patch)).toMatchObject({ kind: "create_price", transferLookupKey: true });
    }
  });

  it("corrects drifted plan metadata, name, archive state, and tax code without touching other metadata", () => {
    const target = desired();
    const state = withProduct(matchingState(target), "radioso_plan_satellite", {
      name: "Old name",
      active: false,
      taxCode: "txcd_99999999",
      metadata: { [STRIPE_PLAN_METADATA_KEY]: "planet", owner: "finance" },
    });

    expect(planStripeCatalogSync(target, state).actions).toEqual([
      {
        kind: "update_product",
        productId: "radioso_plan_satellite",
        patch: {
          name: "Radioso Satellite",
          active: true,
          taxCode: SAAS_TAX_CODE,
          metadata: { [STRIPE_PLAN_METADATA_KEY]: "satellite" },
        },
      },
    ]);
  });

  it("removes a plan metadata key from a product that grants no plan", () => {
    const target = desired();
    const state = withProduct(matchingState(target), "radioso_topup", {
      metadata: { [STRIPE_PLAN_METADATA_KEY]: "satellite" },
    });

    expect(planStripeCatalogSync(target, state).actions).toEqual([
      { kind: "update_product", productId: "radioso_topup", patch: { metadata: { [STRIPE_PLAN_METADATA_KEY]: "" } } },
    ]);
  });

  it("plans a portal configuration offering every plan price when none exists", () => {
    const target = desired();
    const plan = planStripeCatalogSync(target, { ...matchingState(target), portal: null });

    expect(plan.actions).toEqual([{ kind: "create_portal_configuration", products: target.portalProducts }]);
  });

  it("updates the default portal configuration when its features or offered prices drift", () => {
    const target = desired();
    const state = matchingState(target);
    const drifted: StripeCatalogState = {
      ...state,
      portal: {
        ...state.portal!,
        features: {
          ...state.portal!.features,
          subscriptionUpdate: {
            ...state.portal!.features.subscriptionUpdate,
            prorationBehavior: "create_prorations",
            products: state.portal!.features.subscriptionUpdate.products.slice(1),
          },
        },
      },
    };

    expect(planStripeCatalogSync(target, drifted).actions).toEqual([
      { kind: "update_portal_configuration", configurationId: "bpc_default", products: target.portalProducts },
    ]);
  });

  it("warns when the portal configuration it manages is not the default one", () => {
    const target = desired();
    const state = matchingState(target);
    const plan = planStripeCatalogSync(target, { ...state, portal: { ...state.portal!, isDefault: false } });

    expect(plan.actions).toEqual([]);
    expect(plan.notices).toContainEqual({ kind: "portal_not_default", configurationId: "bpc_default" });
  });

  it("creates the webhook endpoint when no endpoint has that URL", () => {
    const target = desired();
    const state = { ...matchingState(target), webhookEndpoints: [] };

    expect(planStripeCatalogSync(target, state).actions).toEqual([
      { kind: "create_webhook_endpoint", url: WEBHOOK_URL, enabledEvents: target.webhook!.enabledEvents, apiVersion: API_VERSION },
    ]);
  });

  it("adds only the events an existing endpoint is missing, keeping events it holds outside the managed set", () => {
    const target = desired();
    const state = matchingState(target);
    const plan = planStripeCatalogSync(target, {
      ...state,
      webhookEndpoints: [{ ...state.webhookEndpoints[0], enabledEvents: ["invoice.paid", "custom.unmanaged_event"] }],
    });

    expect(plan.actions).toEqual([
      {
        kind: "update_webhook_endpoint",
        endpointId: "we_1",
        url: WEBHOOK_URL,
        enabledEvents: [
          "invoice.paid",
          "custom.unmanaged_event",
          ...target.webhook!.enabledEvents.filter((event) => event !== "invoice.paid"),
        ],
        addedEvents: target.webhook!.enabledEvents.filter((event) => event !== "invoice.paid"),
      },
    ]);
    expect(plan.notices).toContainEqual({ kind: "webhook_secret_unreadable", endpointId: "we_1", url: WEBHOOK_URL });
  });

  it("re-enables a disabled endpoint without touching its events when it already covers every required one", () => {
    const target = desired();
    const state = matchingState(target);
    const plan = planStripeCatalogSync(target, {
      ...state,
      webhookEndpoints: [{ ...state.webhookEndpoints[0], enabled: false }],
    });

    expect(plan.actions).toEqual([
      {
        kind: "update_webhook_endpoint",
        endpointId: "we_1",
        url: WEBHOOK_URL,
        enabledEvents: state.webhookEndpoints[0].enabledEvents,
        addedEvents: [],
      },
    ]);
  });

  it("treats a wildcard endpoint as covering every required event, and never adds events on top of a wildcard", () => {
    const target = desired();
    const state = matchingState(target);

    const alreadyEnabled = planStripeCatalogSync(target, {
      ...state,
      webhookEndpoints: [{ ...state.webhookEndpoints[0], enabledEvents: ["*"] }],
    });
    expect(alreadyEnabled.actions).toEqual([]);

    const disabled = planStripeCatalogSync(target, {
      ...state,
      webhookEndpoints: [{ ...state.webhookEndpoints[0], enabledEvents: ["*"], enabled: false }],
    });
    expect(disabled.actions).toEqual([
      { kind: "update_webhook_endpoint", endpointId: "we_1", url: WEBHOOK_URL, enabledEvents: ["*"], addedEvents: [] },
    ]);
  });

  it("leaves a matching endpoint alone and still says its secret cannot be read back", () => {
    const target = desired();
    const plan = planStripeCatalogSync(target, matchingState(target));

    expect(plan.actions).toEqual([]);
    expect(plan.notices).toContainEqual({ kind: "webhook_secret_unreadable", endpointId: "we_1", url: WEBHOOK_URL });
  });

  it("ignores webhook endpoints entirely when no webhook URL was given", () => {
    const target = desired(false);
    const plan = planStripeCatalogSync(target, { ...matchingState(target), webhookEndpoints: [] });

    expect(plan.actions).toEqual([]);
    expect(plan.notices.map((notice) => notice.kind)).not.toContain("webhook_secret_unreadable");
  });

  it("warns when an existing endpoint renders events in a specific, different API version than the runtime parses", () => {
    const target = desired();
    const state = matchingState(target);
    const plan = planStripeCatalogSync(target, {
      ...state,
      webhookEndpoints: [{ ...state.webhookEndpoints[0], apiVersion: "2024-06-20" }],
    });

    expect(plan.notices).toContainEqual({
      kind: "webhook_api_version_mismatch",
      endpointId: "we_1",
      url: WEBHOOK_URL,
      currentApiVersion: "2024-06-20",
      expectedApiVersion: API_VERSION,
    });
  });

  it("notices, rather than warns, when an endpoint follows the account's default API version", () => {
    const target = desired();
    const state = matchingState(target);
    const plan = planStripeCatalogSync(target, {
      ...state,
      webhookEndpoints: [{ ...state.webhookEndpoints[0], apiVersion: null }],
    });

    expect(plan.notices).toContainEqual({
      kind: "webhook_api_version_account_default",
      endpointId: "we_1",
      url: WEBHOOK_URL,
      expectedApiVersion: API_VERSION,
    });
    expect(plan.notices.map((notice) => notice.kind)).not.toContain("webhook_api_version_mismatch");
  });

  it("does not warn about API version when an existing endpoint already matches", () => {
    const target = desired();
    const plan = planStripeCatalogSync(target, matchingState(target));

    expect(plan.notices.map((notice) => notice.kind)).not.toContain("webhook_api_version_mismatch");
    expect(plan.notices.map((notice) => notice.kind)).not.toContain("webhook_api_version_account_default");
  });

  it("sets tax defaults that differ, and warns while Stripe Tax is not active or has no registrations", () => {
    const target = desired();
    const state: StripeCatalogState = {
      ...matchingState(target),
      tax: { status: "pending", missingFields: ["head_office"], defaultTaxBehavior: "inferred_by_currency", defaultTaxCode: null },
      activeTaxRegistrations: 0,
    };

    const plan = planStripeCatalogSync(target, state);

    expect(plan.actions).toEqual([{ kind: "update_tax_defaults", taxBehavior: "exclusive", taxCode: SAAS_TAX_CODE }]);
    expect(plan.notices).toContainEqual({ kind: "tax_not_active", status: "pending", missingFields: ["head_office"] });
    expect(plan.notices).toContainEqual({ kind: "tax_no_active_registrations" });
  });
});
