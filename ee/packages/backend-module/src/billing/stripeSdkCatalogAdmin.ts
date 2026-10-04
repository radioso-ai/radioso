import Stripe from "stripe";

import type {
  StripeAccountSummary,
  StripeCatalogAdmin,
  StripeCreatedWebhookEndpoint,
  StripePortalConfigurationState,
  StripePortalFeatures,
  StripePriceInput,
  StripePriceState,
  StripeProductInput,
  StripeProductPatch,
  StripeProductState,
  StripeTaxDefaultsInput,
  StripeTaxSettingsState,
  StripeWebhookEndpointInput,
  StripeWebhookEndpointState,
} from "./stripeCatalogAdmin.js";

/** Metadata on portal configurations this adapter creates, so a later run finds the same one. */
const PORTAL_TAG = { key: "radioso_catalog_sync", value: "true" } as const;

/** Portal configurations omit `subscription_update.products` unless it is expanded. */
const PORTAL_PRODUCTS_FIELD = "features.subscription_update.products";

/**
 * Adapts the `stripe` SDK to the {@link StripeCatalogAdmin} port. Every Stripe-specific shape the
 * catalog sync touches (expansions, pagination, 404 handling, snake_case params) lives here.
 */
export class StripeSdkCatalogAdmin implements StripeCatalogAdmin {
  readonly apiVersion: string = Stripe.API_VERSION;
  private readonly client: Stripe;

  constructor(secretKey: string) {
    this.client = new Stripe(secretKey);
  }

  async retrieveAccount(): Promise<StripeAccountSummary> {
    const account = await this.client.accounts.retrieveCurrent();
    return {
      id: account.id,
      name: account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? null,
    };
  }

  async retrieveProduct(id: string): Promise<StripeProductState | null> {
    try {
      const product = await this.client.products.retrieve(id);
      return {
        id: product.id,
        name: product.name,
        active: product.active,
        taxCode: product.tax_code ? refId(product.tax_code) : null,
        metadata: product.metadata ?? {},
      };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async createProduct(input: StripeProductInput): Promise<void> {
    await this.client.products.create({
      id: input.id,
      name: input.name,
      tax_code: input.taxCode,
      metadata: { ...input.metadata },
    });
  }

  async updateProduct(id: string, patch: StripeProductPatch): Promise<void> {
    await this.client.products.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.taxCode !== undefined ? { tax_code: patch.taxCode } : {}),
      ...(patch.metadata !== undefined ? { metadata: { ...patch.metadata } } : {}),
    });
  }

  async findPriceByLookupKey(lookupKey: string): Promise<StripePriceState | null> {
    // A lookup key is held by at most one price at a time, and `prices.list` without an `active`
    // filter returns both active and archived prices, so one call finds whichever price holds it.
    const result = await this.client.prices.list({ lookup_keys: [lookupKey], limit: 1 });
    const price = result.data[0];
    if (!price) {
      return null;
    }
    return {
      id: price.id,
      lookupKey,
      active: price.active,
      productId: refId(price.product),
      unitAmount: price.unit_amount ?? null,
      currency: price.currency,
      recurring: price.recurring
        ? { interval: price.recurring.interval, intervalCount: price.recurring.interval_count }
        : null,
      taxBehavior: price.tax_behavior ?? null,
    };
  }

  async createPrice(input: StripePriceInput): Promise<{ id: string }> {
    const price = await this.client.prices.create({
      product: input.productId,
      lookup_key: input.lookupKey,
      transfer_lookup_key: input.transferLookupKey,
      unit_amount: input.unitAmount,
      currency: input.currency,
      tax_behavior: input.taxBehavior,
      ...(input.recurringInterval ? { recurring: { interval: input.recurringInterval } } : {}),
    });
    return { id: price.id };
  }

  async listWebhookEndpoints(): Promise<StripeWebhookEndpointState[]> {
    const endpoints: StripeWebhookEndpointState[] = [];
    for await (const endpoint of this.client.webhookEndpoints.list({ limit: 100 })) {
      endpoints.push({
        id: endpoint.id,
        url: endpoint.url,
        enabledEvents: endpoint.enabled_events,
        apiVersion: endpoint.api_version ?? null,
        enabled: endpoint.status === "enabled",
      });
    }
    return endpoints;
  }

  async createWebhookEndpoint(input: StripeWebhookEndpointInput): Promise<StripeCreatedWebhookEndpoint> {
    const endpoint = await this.client.webhookEndpoints.create({
      url: input.url,
      enabled_events: [...input.enabledEvents],
      // Pinned so payloads arrive in the shape the runtime gateway (same SDK) reads, whatever the
      // account's default version is. `input.apiVersion` is this adapter's own `apiVersion` field
      // (the planner only ever asks for that value), narrower than the SDK's literal union of known
      // versions just because the port type is a plain `string`.
      api_version: input.apiVersion as Stripe.WebhookEndpointCreateParams.ApiVersion,
      description: "Radioso billing",
    });
    if (!endpoint.secret) {
      throw new Error(`Stripe created webhook endpoint ${endpoint.id} without returning its signing secret`);
    }
    return { id: endpoint.id, secret: endpoint.secret };
  }

  async updateWebhookEndpoint(id: string, input: { enabledEvents: readonly string[] }): Promise<void> {
    // These events are either ones the account's endpoint already has (Stripe gave them to us) or
    // ones this sync manages, so they are valid Stripe event names despite the port's wider type.
    const enabledEvents = [...input.enabledEvents] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[];
    await this.client.webhookEndpoints.update(id, { enabled_events: enabledEvents, disabled: false });
  }

  async findPortalConfiguration(): Promise<StripePortalConfigurationState | null> {
    const configurations: Stripe.BillingPortal.Configuration[] = [];
    for await (const configuration of this.client.billingPortal.configurations.list({
      active: true,
      limit: 100,
      expand: [`data.${PORTAL_PRODUCTS_FIELD}`],
    })) {
      configurations.push(configuration);
    }
    const found =
      configurations.find((configuration) => configuration.is_default) ??
      configurations.find((configuration) => configuration.metadata?.[PORTAL_TAG.key] === PORTAL_TAG.value);
    return found ? adaptPortalConfiguration(found) : null;
  }

  async createPortalConfiguration(features: StripePortalFeatures): Promise<StripePortalConfigurationState> {
    const created = await this.client.billingPortal.configurations.create({
      features: portalFeaturesParams(features),
      metadata: { [PORTAL_TAG.key]: PORTAL_TAG.value },
      expand: [PORTAL_PRODUCTS_FIELD],
    });
    return adaptPortalConfiguration(created);
  }

  async updatePortalConfiguration(id: string, features: StripePortalFeatures): Promise<void> {
    await this.client.billingPortal.configurations.update(id, { features: portalFeaturesParams(features) });
  }

  async retrieveTaxSettings(): Promise<StripeTaxSettingsState> {
    const settings = await this.client.tax.settings.retrieve();
    return {
      status: settings.status,
      missingFields: settings.status_details.pending?.missing_fields ?? [],
      defaultTaxBehavior: settings.defaults.tax_behavior ?? null,
      defaultTaxCode: settings.defaults.tax_code ?? null,
    };
  }

  async updateTaxDefaults(input: StripeTaxDefaultsInput): Promise<void> {
    await this.client.tax.settings.update({
      defaults: { tax_behavior: input.taxBehavior, tax_code: input.taxCode },
    });
  }

  async countActiveTaxRegistrations(): Promise<number> {
    let count = 0;
    for await (const _registration of this.client.tax.registrations.list({ status: "active", limit: 100 })) {
      count += 1;
    }
    return count;
  }
}

const refId = (value: string | { id: string }): string => (typeof value === "string" ? value : value.id);

const portalFeaturesParams = (
  features: StripePortalFeatures,
): Stripe.BillingPortal.ConfigurationCreateParams.Features => ({
  customer_update: { enabled: features.customerUpdate.enabled, allowed_updates: [...features.customerUpdate.allowedUpdates] },
  invoice_history: { enabled: features.invoiceHistory.enabled },
  payment_method_update: { enabled: features.paymentMethodUpdate.enabled },
  subscription_cancel: { enabled: features.subscriptionCancel.enabled, mode: features.subscriptionCancel.mode },
  subscription_update: {
    enabled: features.subscriptionUpdate.enabled,
    default_allowed_updates: [...features.subscriptionUpdate.defaultAllowedUpdates],
    proration_behavior: features.subscriptionUpdate.prorationBehavior,
    products: features.subscriptionUpdate.products.map((product) => ({
      product: product.productId,
      prices: [...product.priceIds],
    })),
  },
});

const adaptPortalConfiguration = (configuration: Stripe.BillingPortal.Configuration): StripePortalConfigurationState => {
  const { features } = configuration;
  return {
    id: configuration.id,
    isDefault: configuration.is_default,
    features: {
      customerUpdate: {
        enabled: features.customer_update.enabled,
        allowedUpdates: features.customer_update.allowed_updates,
      },
      invoiceHistory: { enabled: features.invoice_history.enabled },
      paymentMethodUpdate: { enabled: features.payment_method_update.enabled },
      subscriptionCancel: { enabled: features.subscription_cancel.enabled, mode: features.subscription_cancel.mode },
      subscriptionUpdate: {
        enabled: features.subscription_update.enabled,
        defaultAllowedUpdates: features.subscription_update.default_allowed_updates,
        prorationBehavior: features.subscription_update.proration_behavior,
        products: (features.subscription_update.products ?? []).map((product) => ({
          productId: product.product,
          priceIds: product.prices,
        })),
      },
    },
  };
};
