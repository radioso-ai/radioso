/**
 * Pure planner for the Stripe catalog sync: maps the plan catalog to the Stripe objects it needs
 * (`desiredStripeCatalog`), then diffs that against what an account holds (`planStripeCatalogSync`)
 * into an ordered list of actions. Knows the catalog and the {@link StripeCatalogAdmin} state shapes;
 * never calls Stripe, so the command decides when (and whether) to execute the plan.
 */
import type { PlanCatalog, PlanTaxBehavior } from "@radioso/plan-catalog";

import type {
  StripePortalConfigurationState,
  StripePortalFeatures,
  StripePortalProduct,
  StripePriceState,
  StripeProductPatch,
  StripeProductState,
  StripeRecurringInterval,
  StripeTaxDefaultsInput,
  StripeTaxSettingsState,
  StripeWebhookEndpointState,
} from "./stripeCatalogAdmin.js";
import { STRIPE_WEBHOOK_EVENT_TYPES, type StripeHandledWebhookEventType } from "./stripeGateway.js";

/** Stripe tax code "Software as a service (SaaS) - business use". */
const SAAS_TAX_CODE = "txcd_10103001";

const TOP_UP_PRODUCT_ID = "radioso_topup";

const planProductId = (planId: string): string => `radioso_plan_${planId}`;

interface DesiredStripeProduct {
  id: string;
  name: string;
  taxCode: string;
  /** `{ [metadataKey]: planId }` on a plan product; empty on products that grant no plan. */
  metadata: Readonly<Record<string, string>>;
}

export interface DesiredStripePrice {
  lookupKey: string;
  productId: string;
  unitAmount: number;
  currency: string;
  /** Null on a one-time price. */
  recurringInterval: StripeRecurringInterval | null;
  taxBehavior: PlanTaxBehavior;
}

/** A product the portal lets a subscriber switch to, with its prices named by lookup key. */
export interface DesiredPortalProduct {
  productId: string;
  lookupKeys: readonly string[];
}

interface DesiredStripeWebhook {
  url: string;
  enabledEvents: readonly StripeHandledWebhookEventType[];
  /** The version the endpoint must render events in: the one the runtime gateway parses. */
  apiVersion: string;
}

export interface DesiredStripeCatalog {
  metadataKey: string;
  products: readonly DesiredStripeProduct[];
  prices: readonly DesiredStripePrice[];
  portalProducts: readonly DesiredPortalProduct[];
  tax: StripeTaxDefaultsInput;
  /** Null when the run manages no webhook endpoint. */
  webhook: DesiredStripeWebhook | null;
}

interface DesiredStripeCatalogOptions {
  metadataKey: string;
  webhook?: { url: string; apiVersion: string };
}

export const desiredStripeCatalog = (
  catalog: PlanCatalog,
  options: DesiredStripeCatalogOptions,
): DesiredStripeCatalog => {
  const currency = catalog.currency.toLowerCase();
  const taxBehavior = catalog.taxBehavior;
  const price = (
    lookupKey: string,
    productId: string,
    unitAmount: number,
    recurringInterval: StripeRecurringInterval | null,
  ): DesiredStripePrice => ({ lookupKey, productId, unitAmount, currency, recurringInterval, taxBehavior });

  const products: DesiredStripeProduct[] = [];
  const prices: DesiredStripePrice[] = [];
  const portalProducts: DesiredPortalProduct[] = [];

  for (const plan of catalog.plans) {
    if (!plan.stripe) {
      continue;
    }
    const productId = planProductId(plan.id);
    products.push({
      id: productId,
      name: `Radioso ${plan.name}`,
      taxCode: SAAS_TAX_CODE,
      metadata: { [options.metadataKey]: plan.id },
    });
    const planPrices = [price(plan.stripe.monthLookupKey, productId, plan.priceCents, "month")];
    if (plan.annualPriceCents !== null) {
      planPrices.push(price(plan.stripe.yearLookupKey, productId, plan.annualPriceCents, "year"));
    }
    prices.push(...planPrices);
    portalProducts.push({ productId, lookupKeys: planPrices.map((entry) => entry.lookupKey) });
  }

  products.push({
    id: TOP_UP_PRODUCT_ID,
    name: `Radioso conversation top-up (${catalog.topUp.conversations} conversations)`,
    taxCode: SAAS_TAX_CODE,
    metadata: {},
  });
  prices.push(price(catalog.topUp.stripeLookupKey, TOP_UP_PRODUCT_ID, catalog.topUp.priceCents, null));

  return {
    metadataKey: options.metadataKey,
    products,
    prices,
    portalProducts,
    tax: { taxBehavior, taxCode: SAAS_TAX_CODE },
    webhook: options.webhook
      ? { url: options.webhook.url, enabledEvents: [...STRIPE_WEBHOOK_EVENT_TYPES], apiVersion: options.webhook.apiVersion }
      : null,
  };
};

/** What an account holds for the desired catalog. Maps hold only the entries that exist. */
export interface StripeCatalogState {
  /** By product id. */
  products: ReadonlyMap<string, StripeProductState>;
  /** By lookup key. */
  prices: ReadonlyMap<string, StripePriceState>;
  portal: StripePortalConfigurationState | null;
  webhookEndpoints: readonly StripeWebhookEndpointState[];
  tax: StripeTaxSettingsState;
  activeTaxRegistrations: number;
}

export type StripeCatalogSyncAction =
  | { kind: "create_product"; product: DesiredStripeProduct }
  | { kind: "update_product"; productId: string; patch: StripeProductPatch }
  | {
      kind: "create_price";
      price: DesiredStripePrice;
      /** True when another price holds the lookup key; that price stays active for its subscribers. */
      transferLookupKey: boolean;
      replaces: { priceId: string; productId: string } | null;
    }
  | ({ kind: "update_tax_defaults" } & StripeTaxDefaultsInput)
  | { kind: "create_portal_configuration"; products: readonly DesiredPortalProduct[] }
  | { kind: "update_portal_configuration"; configurationId: string; products: readonly DesiredPortalProduct[] }
  | {
      kind: "create_webhook_endpoint";
      url: string;
      enabledEvents: readonly StripeHandledWebhookEventType[];
      apiVersion: string;
    }
  | {
      kind: "update_webhook_endpoint";
      endpointId: string;
      url: string;
      /** The existing endpoint's events plus `addedEvents`; never drops an event the endpoint already has. */
      enabledEvents: readonly string[];
      /** Required events the endpoint was missing. Empty when the update only re-enables the endpoint. */
      addedEvents: readonly string[];
    };

export type StripeCatalogSyncNotice =
  | { kind: "webhook_secret_unreadable"; endpointId: string; url: string }
  | {
      kind: "webhook_api_version_mismatch";
      endpointId: string;
      url: string;
      currentApiVersion: string;
      expectedApiVersion: string;
    }
  | {
      /** `null` API version means the endpoint tracks the account default, which may already be right. */
      kind: "webhook_api_version_account_default";
      endpointId: string;
      url: string;
      expectedApiVersion: string;
    }
  | { kind: "portal_not_default"; configurationId: string }
  | { kind: "tax_not_active"; status: string; missingFields: readonly string[] }
  | { kind: "tax_no_active_registrations" };

export interface StripeCatalogSyncPlan {
  actions: readonly StripeCatalogSyncAction[];
  notices: readonly StripeCatalogSyncNotice[];
}

/**
 * The portal features the catalog wants, with each lookup key resolved to a price id. Returns null
 * when a lookup key has no price id yet (its price is about to be created).
 */
export const portalFeaturesFor = (
  products: readonly DesiredPortalProduct[],
  priceIdFor: (lookupKey: string) => string | undefined,
): StripePortalFeatures | null => {
  const resolved: StripePortalProduct[] = [];
  for (const product of products) {
    const priceIds = product.lookupKeys.map(priceIdFor);
    if (priceIds.some((priceId) => priceId === undefined)) {
      return null;
    }
    resolved.push({ productId: product.productId, priceIds: priceIds.filter((id) => id !== undefined) });
  }
  return {
    customerUpdate: { enabled: true, allowedUpdates: ["email", "address", "tax_id", "name"] },
    invoiceHistory: { enabled: true },
    paymentMethodUpdate: { enabled: true },
    subscriptionCancel: { enabled: true, mode: "at_period_end" },
    // Upgrades invoice the proration immediately because a plan grants its quota the moment it starts.
    subscriptionUpdate: {
      enabled: true,
      defaultAllowedUpdates: ["price"],
      prorationBehavior: "always_invoice",
      products: resolved,
    },
  };
};

export const planStripeCatalogSync = (
  desired: DesiredStripeCatalog,
  current: StripeCatalogState,
): StripeCatalogSyncPlan => {
  const priceActions = desired.prices.flatMap((price) => planPrice(price, current.prices.get(price.lookupKey)));
  const replacedLookupKeys = new Set(
    priceActions.flatMap((action) => (action.kind === "create_price" ? [action.price.lookupKey] : [])),
  );
  const keptPriceId = (lookupKey: string): string | undefined =>
    replacedLookupKeys.has(lookupKey) ? undefined : current.prices.get(lookupKey)?.id;

  const actions: StripeCatalogSyncAction[] = [
    ...desired.products.flatMap((product) =>
      planProduct(product, current.products.get(product.id), desired.metadataKey),
    ),
    ...priceActions,
    ...planTaxDefaults(desired.tax, current.tax),
    ...planPortal(desired.portalProducts, current.portal, keptPriceId),
    ...(desired.webhook ? planWebhook(desired.webhook, current.webhookEndpoints) : []),
  ];

  return { actions, notices: planNotices(desired, current) };
};

const planProduct = (
  desired: DesiredStripeProduct,
  current: StripeProductState | undefined,
  metadataKey: string,
): StripeCatalogSyncAction[] => {
  if (!current) {
    return [{ kind: "create_product", product: desired }];
  }
  const patch: StripeProductPatch = {};
  if (current.name !== desired.name) {
    patch.name = desired.name;
  }
  if (!current.active) {
    patch.active = true;
  }
  if (current.taxCode !== desired.taxCode) {
    patch.taxCode = desired.taxCode;
  }
  // Only the plan key is ours: webhooks read it to resolve a price to a plan. Other keys stay.
  const desiredPlan = desired.metadata[metadataKey] ?? null;
  const currentPlan = current.metadata[metadataKey] ?? null;
  if (desiredPlan !== currentPlan) {
    patch.metadata = { [metadataKey]: desiredPlan ?? "" };
  }
  return Object.keys(patch).length > 0 ? [{ kind: "update_product", productId: desired.id, patch }] : [];
};

const priceMatches = (desired: DesiredStripePrice, current: StripePriceState): boolean => {
  const recurringMatches = desired.recurringInterval
    ? current.recurring?.interval === desired.recurringInterval && current.recurring.intervalCount === 1
    : current.recurring === null;
  return (
    current.active &&
    current.productId === desired.productId &&
    current.unitAmount === desired.unitAmount &&
    current.currency === desired.currency &&
    current.taxBehavior === desired.taxBehavior &&
    recurringMatches
  );
};

// A changed price is a new price that takes over the lookup key. The old price is never archived:
// subscribers on it keep renewing at their price, and webhooks still resolve its product to a plan.
const planPrice = (desired: DesiredStripePrice, current: StripePriceState | undefined): StripeCatalogSyncAction[] => {
  if (!current) {
    return [{ kind: "create_price", price: desired, transferLookupKey: false, replaces: null }];
  }
  if (priceMatches(desired, current)) {
    return [];
  }
  return [
    {
      kind: "create_price",
      price: desired,
      transferLookupKey: true,
      replaces: { priceId: current.id, productId: current.productId },
    },
  ];
};

const planTaxDefaults = (desired: StripeTaxDefaultsInput, current: StripeTaxSettingsState): StripeCatalogSyncAction[] =>
  current.defaultTaxBehavior === desired.taxBehavior && current.defaultTaxCode === desired.taxCode
    ? []
    : [{ kind: "update_tax_defaults", taxBehavior: desired.taxBehavior, taxCode: desired.taxCode }];

const planPortal = (
  products: readonly DesiredPortalProduct[],
  current: StripePortalConfigurationState | null,
  keptPriceId: (lookupKey: string) => string | undefined,
): StripeCatalogSyncAction[] => {
  if (!current) {
    return [{ kind: "create_portal_configuration", products }];
  }
  const wanted = portalFeaturesFor(products, keptPriceId);
  if (wanted && portalFeaturesEqual(wanted, current.features)) {
    return [];
  }
  return [{ kind: "update_portal_configuration", configurationId: current.id, products }];
};

const sameMembers = (left: readonly string[], right: readonly string[]): boolean => {
  const rightSet = new Set(right);
  return new Set(left).size === rightSet.size && left.every((entry) => rightSet.has(entry));
};

/** True when every member of `required` is already in `held`. */
const isSuperset = (held: readonly string[], required: readonly string[]): boolean => {
  const heldSet = new Set(held);
  return required.every((event) => heldSet.has(event));
};

const portalProductsEqual = (left: readonly StripePortalProduct[], right: readonly StripePortalProduct[]): boolean =>
  left.length === right.length &&
  left.every((product) => {
    const match = right.find((candidate) => candidate.productId === product.productId);
    return match !== undefined && sameMembers(product.priceIds, match.priceIds);
  });

const portalFeaturesEqual = (wanted: StripePortalFeatures, current: StripePortalFeatures): boolean =>
  wanted.customerUpdate.enabled === current.customerUpdate.enabled &&
  sameMembers(wanted.customerUpdate.allowedUpdates, current.customerUpdate.allowedUpdates) &&
  wanted.invoiceHistory.enabled === current.invoiceHistory.enabled &&
  wanted.paymentMethodUpdate.enabled === current.paymentMethodUpdate.enabled &&
  wanted.subscriptionCancel.enabled === current.subscriptionCancel.enabled &&
  wanted.subscriptionCancel.mode === current.subscriptionCancel.mode &&
  wanted.subscriptionUpdate.enabled === current.subscriptionUpdate.enabled &&
  sameMembers(wanted.subscriptionUpdate.defaultAllowedUpdates, current.subscriptionUpdate.defaultAllowedUpdates) &&
  wanted.subscriptionUpdate.prorationBehavior === current.subscriptionUpdate.prorationBehavior &&
  portalProductsEqual(wanted.subscriptionUpdate.products, current.subscriptionUpdate.products);

const findWebhookEndpoint = (
  desired: DesiredStripeWebhook,
  endpoints: readonly StripeWebhookEndpointState[],
): StripeWebhookEndpointState | undefined => endpoints.find((endpoint) => endpoint.url === desired.url);

/** Stripe's shorthand for "every event", which by construction already covers anything required. */
const WILDCARD_EVENT = "*";

const planWebhook = (
  desired: DesiredStripeWebhook,
  endpoints: readonly StripeWebhookEndpointState[],
): StripeCatalogSyncAction[] => {
  const existing = findWebhookEndpoint(desired, endpoints);
  if (!existing) {
    return [
      { kind: "create_webhook_endpoint", url: desired.url, enabledEvents: desired.enabledEvents, apiVersion: desired.apiVersion },
    ];
  }
  const hasWildcard = existing.enabledEvents.includes(WILDCARD_EVENT);
  const coversRequired = hasWildcard || isSuperset(existing.enabledEvents, desired.enabledEvents);
  if (existing.enabled && coversRequired) {
    return [];
  }
  // Never remove an event the endpoint already has: an operator or another integration may rely on it.
  const addedEvents = hasWildcard ? [] : desired.enabledEvents.filter((event) => !existing.enabledEvents.includes(event));
  const enabledEvents = hasWildcard ? existing.enabledEvents : [...existing.enabledEvents, ...addedEvents];
  return [{ kind: "update_webhook_endpoint", endpointId: existing.id, url: desired.url, enabledEvents, addedEvents }];
};

const planNotices = (desired: DesiredStripeCatalog, current: StripeCatalogState): StripeCatalogSyncNotice[] => {
  const notices: StripeCatalogSyncNotice[] = [];
  const endpoint = desired.webhook ? findWebhookEndpoint(desired.webhook, current.webhookEndpoints) : undefined;
  if (desired.webhook && endpoint) {
    notices.push({ kind: "webhook_secret_unreadable", endpointId: endpoint.id, url: endpoint.url });
    if (endpoint.apiVersion === null) {
      // `null` means the endpoint tracks the account's default version, which may already be the one
      // the runtime expects; that can only be checked in the Dashboard, so this is a notice, not a warning.
      notices.push({
        kind: "webhook_api_version_account_default",
        endpointId: endpoint.id,
        url: endpoint.url,
        expectedApiVersion: desired.webhook.apiVersion,
      });
    } else if (endpoint.apiVersion !== desired.webhook.apiVersion) {
      notices.push({
        kind: "webhook_api_version_mismatch",
        endpointId: endpoint.id,
        url: endpoint.url,
        currentApiVersion: endpoint.apiVersion,
        expectedApiVersion: desired.webhook.apiVersion,
      });
    }
  }
  if (current.portal && !current.portal.isDefault) {
    notices.push({ kind: "portal_not_default", configurationId: current.portal.id });
  }
  if (current.tax.status !== "active") {
    notices.push({ kind: "tax_not_active", status: current.tax.status, missingFields: current.tax.missingFields });
  }
  if (current.activeTaxRegistrations === 0) {
    notices.push({ kind: "tax_no_active_registrations" });
  }
  return notices;
};
