import Stripe from "stripe";

import type { BillingInterval } from "./planPricing.js";
import {
  StripeDefinitiveChargeError,
  StripeSignatureVerificationError,
  type StripeCheckoutSessionEventData,
  type StripeCheckoutSessionParams,
  type StripeCustomerRef,
  type StripeGateway,
  type StripeInvoiceEventData,
  type StripePortalSessionParams,
  type StripePriceRef,
  type StripeProductRef,
  type StripeSubscriptionEventData,
  type StripeTopUpChargeParams,
  type StripeTopUpChargeResult,
  type StripeTopUpInvoiceDraftParams,
  type StripeWebhookEvent,
} from "./stripeGateway.js";

/**
 * Adapts the `stripe` SDK to the narrow {@link StripeGateway} port. Everything Stripe-specific
 * (API calls, expansions, raw field shapes) lives here; nothing outside this file imports `stripe`.
 */
export class StripeSdkGateway implements StripeGateway {
  private readonly client: Stripe;
  private readonly webhookSecret: string;

  constructor(input: { secretKey: string; webhookSecret: string }) {
    this.client = new Stripe(input.secretKey);
    this.webhookSecret = input.webhookSecret;
  }

  async findPriceByLookupKey(key: string): Promise<StripePriceRef | null> {
    const result = await this.client.prices.list({ lookup_keys: [key], active: true, limit: 1 });
    const price = result.data[0];
    if (!price) {
      return null;
    }
    return { id: price.id, lookupKey: price.lookup_key ?? null, productId: refId(price.product) };
  }

  async getProduct(id: string): Promise<StripeProductRef | null> {
    try {
      const product = await this.client.products.retrieve(id);
      return { id: product.id, metadata: product.metadata ?? {} };
    } catch {
      return null;
    }
  }

  async createCustomer(input: { email: string; accountId: string }): Promise<StripeCustomerRef> {
    const customer = await this.client.customers.create({
      email: input.email || undefined,
      metadata: { accountId: input.accountId },
    });
    return { id: customer.id };
  }

  async createCheckoutSession(params: StripeCheckoutSessionParams): Promise<{ url: string }> {
    const shared: Stripe.Checkout.SessionCreateParams = {
      mode: params.mode,
      customer: params.customerId,
      client_reference_id: params.clientReferenceId,
      line_items: params.lineItems.map((item) => ({ price: item.price, quantity: item.quantity })),
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      billing_address_collection: "required",
      allow_promotion_codes: true,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    };
    const modeParams: Stripe.Checkout.SessionCreateParams =
      params.mode === "subscription"
        ? {
            customer_update: { address: "auto", name: "auto" },
            subscription_data: { metadata: params.subscriptionMetadata ?? {} },
          }
        : {
            customer_update: { address: "auto", name: "auto" },
            metadata: params.paymentMetadata ?? {},
            invoice_creation: { enabled: true },
          };

    const session = await this.client.checkout.sessions.create({ ...shared, ...modeParams });
    if (!session.url) {
      throw new Error("Stripe did not return a checkout session URL");
    }
    return { url: session.url };
  }

  async createPortalSession(params: StripePortalSessionParams): Promise<{ url: string }> {
    const session = await this.client.billingPortal.sessions.create({
      customer: params.customerId,
      return_url: params.returnUrl,
    });
    return { url: session.url };
  }

  async createTopUpInvoiceDraft(params: StripeTopUpInvoiceDraftParams): Promise<{ invoiceId: string }> {
    // Resolved explicitly: `InvoiceCreateParams.default_payment_method`'s own fallback ("the
    // subscription's default payment method, if any, or the customer's invoice settings")
    // applies when Stripe can tie the invoice to that subscription. This invoice is deliberately
    // standalone (no `subscription` field -- it is an out-of-cycle charge, not a renewal), so we
    // read the subscription's payment method ourselves rather than rely on that fallback.
    const subscription = await this.client.subscriptions.retrieve(params.subscriptionId);
    const defaultPaymentMethod = subscription.default_payment_method
      ? refId(subscription.default_payment_method)
      : undefined;

    const invoice = await this.client.invoices.create(
      {
        customer: params.customerId,
        collection_method: "charge_automatically",
        // Stripe must never retry collection on its own schedule -- a retry outside our control
        // could succeed on an invoice we already decided, from `invoice.payment_failed`, to void.
        // Only `chargeTopUpInvoice`'s own explicit `pay` call (and a later re-drive) may attempt it.
        auto_advance: false,
        automatic_tax: { enabled: true },
        // Explicit even though it is the API default: a stray pending item for this customer
        // (e.g. a future manual adjustment) must never ride along on an auto-top-up charge.
        pending_invoice_items_behavior: "exclude",
        ...(defaultPaymentMethod ? { default_payment_method: defaultPaymentMethod } : {}),
        metadata: params.metadata,
      },
      { idempotencyKey: params.idempotencyKey },
    );

    return { invoiceId: invoice.id };
  }

  async chargeTopUpInvoice(params: StripeTopUpChargeParams): Promise<StripeTopUpChargeResult> {
    try {
      await this.client.invoiceItems.create(
        { customer: params.customerId, invoice: params.invoiceId, pricing: { price: params.priceId } },
        { idempotencyKey: `${params.idempotencyKey}:item` },
      );

      const finalized = await this.client.invoices.finalizeInvoice(params.invoiceId, undefined, {
        idempotencyKey: `${params.idempotencyKey}:finalize`,
      });
      if (finalized.status === "paid") {
        return { status: "paid" };
      }

      // `auto_advance: false` means finalizing never attempts collection by itself; this is the
      // one and only payment attempt for this charge.
      const paid = await this.client.invoices.pay(finalized.id, undefined, {
        idempotencyKey: `${params.idempotencyKey}:pay`,
      });
      return { status: paid.status === "paid" ? "paid" : "open" };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeCardError || error instanceof Stripe.errors.StripeInvalidRequestError) {
        throw new StripeDefinitiveChargeError(error.message, error.code ?? error.type);
      }
      // Ambiguous (network, timeout, 5xx, rate limit, auth, ...): rethrown as-is. The caller must
      // not treat this as a failed charge -- Stripe may have already collected payment.
      throw error;
    }
  }

  async voidInvoice(invoiceId: string): Promise<void> {
    await this.client.invoices.voidInvoice(invoiceId);
  }

  async constructWebhookEvent(rawBody: Buffer, signature: string): Promise<StripeWebhookEvent> {
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new StripeSignatureVerificationError();
    }
    return this.adaptEvent(event);
  }

  private async adaptEvent(event: Stripe.Event): Promise<StripeWebhookEvent> {
    switch (event.type) {
      case "checkout.session.completed":
        return {
          id: event.id,
          type: "checkout.session.completed",
          session: await this.adaptCheckoutSession(event.data.object),
        };
      case "customer.subscription.updated":
        return {
          id: event.id,
          type: "customer.subscription.updated",
          subscription: adaptSubscription(event.data.object),
        };
      case "customer.subscription.deleted":
        return {
          id: event.id,
          type: "customer.subscription.deleted",
          subscription: adaptSubscription(event.data.object),
        };
      case "invoice.paid":
        return { id: event.id, type: "invoice.paid", invoice: adaptInvoice(event.data.object) };
      case "invoice.payment_failed":
        return { id: event.id, type: "invoice.payment_failed", invoice: adaptInvoice(event.data.object) };
      default:
        return { id: event.id, type: event.type };
    }
  }

  private async adaptCheckoutSession(raw: Stripe.Checkout.Session): Promise<StripeCheckoutSessionEventData> {
    const full = await this.client.checkout.sessions.retrieve(raw.id, {
      expand: ["line_items.data.price"],
    });
    const lineItem = full.line_items?.data[0];
    const price = lineItem?.price ?? null;

    let productId: string | null = price ? refId(price.product) : null;
    let interval: BillingInterval | null = price?.recurring ? normalizeInterval(price.recurring.interval) : null;
    let currentPeriodEnd: number | null = null;

    if (full.mode === "subscription" && typeof full.subscription === "string") {
      const subscription = await this.client.subscriptions.retrieve(full.subscription);
      const item = subscription.items.data[0];
      if (item) {
        productId = refId(item.price.product);
        interval = normalizeInterval(item.price.recurring?.interval);
        currentPeriodEnd = item.current_period_end ?? null;
      }
    }

    return {
      id: full.id,
      mode: normalizeMode(full.mode),
      customerId: full.customer ? refId(full.customer) : null,
      clientReferenceId: full.client_reference_id ?? null,
      subscriptionId: full.subscription ? refId(full.subscription) : null,
      priceId: price?.id ?? null,
      priceLookupKey: price?.lookup_key ?? null,
      productId,
      interval,
      currentPeriodEnd,
    };
  }
}

const refId = (value: string | { id: string } | null | undefined): string => {
  if (!value) {
    throw new Error("Expected a Stripe object reference but received none");
  }
  return typeof value === "string" ? value : value.id;
};

const normalizeInterval = (value: string | null | undefined): BillingInterval | null =>
  value === "month" || value === "year" ? value : null;

// Stripe's own `Session.Mode` type is `'payment' | 'setup' | 'subscription' | (string & {})` --
// a forward-compatible "branded string" that widens past our narrower literal union.
const normalizeMode = (value: string): "subscription" | "payment" | "setup" =>
  value === "subscription" || value === "setup" ? value : "payment";

const adaptSubscription = (subscription: Stripe.Subscription): StripeSubscriptionEventData => {
  const item = subscription.items.data[0];
  return {
    id: subscription.id,
    customerId: refId(subscription.customer),
    status: subscription.status,
    priceId: item?.price.id ?? null,
    productId: item ? refId(item.price.product) : null,
    interval: item?.price.recurring ? normalizeInterval(item.price.recurring.interval) : null,
    currentPeriodEnd: item?.current_period_end ?? null,
  };
};

const adaptInvoice = (invoice: Stripe.Invoice): StripeInvoiceEventData => ({
  id: invoice.id,
  customerId: invoice.customer ? refId(invoice.customer) : "",
  metadata: invoice.metadata ?? {},
  hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
});
