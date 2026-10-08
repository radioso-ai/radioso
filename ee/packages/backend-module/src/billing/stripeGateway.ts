/**
 * The narrow port every other module and every test sees. Nothing outside `stripeSdkGateway.ts`
 * imports the `stripe` SDK. Knows only the EE-local event/price/product/subscription/invoice
 * shapes this module reads (never the full Stripe types); must never know plans or the database.
 */
import type { BillingInterval } from "./planPricing.js";

export interface StripePriceRef {
  id: string;
  lookupKey: string | null;
  productId: string;
}

export interface StripeProductRef {
  id: string;
  metadata: Record<string, string>;
}

export interface StripeCustomerRef {
  id: string;
}

export interface StripeCheckoutSessionParams {
  mode: "subscription" | "payment";
  customerId: string;
  clientReferenceId: string;
  successUrl: string;
  cancelUrl: string;
  lineItems: ReadonlyArray<{ price: string; quantity: number }>;
  /** `mode: "subscription"` only. */
  subscriptionMetadata?: Record<string, string>;
  /** `mode: "payment"` only. */
  paymentMetadata?: Record<string, string>;
}

export interface StripePortalSessionParams {
  customerId: string;
  returnUrl: string;
}

export interface StripeCheckoutSessionEventData {
  id: string;
  mode: "subscription" | "payment" | "setup";
  customerId: string | null;
  clientReferenceId: string | null;
  subscriptionId: string | null;
  priceId: string | null;
  priceLookupKey: string | null;
  productId: string | null;
  interval: BillingInterval | null;
  currentPeriodEnd: number | null;
}

export interface StripeSubscriptionEventData {
  id: string;
  customerId: string;
  status: string;
  priceId: string | null;
  productId: string | null;
  interval: BillingInterval | null;
  currentPeriodEnd: number | null;
}

export interface StripeInvoiceEventData {
  id: string;
  customerId: string;
  /** Stripe's own invoice metadata. The webhook branches on `radioso_kind` here first, before
   *  falling into the subscription-invoice handling every other invoice event takes. */
  metadata: Record<string, string>;
  /** Null until the invoice is finalized. Carried into the auto-top-up-failed email when
   *  present, so the recipient can jump straight to the invoice. */
  hostedInvoiceUrl: string | null;
}

export interface StripeTopUpInvoiceParams {
  customerId: string;
  subscriptionId: string;
  priceId: string;
  metadata: Record<string, string>;
  /** Derived from the auto-top-up row's id, so a retried sweep attempt against the same row
   *  dedupes at Stripe rather than charging twice. */
  idempotencyKey: string;
}

export interface StripeTopUpInvoiceResult {
  invoiceId: string;
}

/**
 * The Stripe event types billing acts on. `StripeWebhookEvent` carries a typed payload for exactly
 * these, and the catalog sync subscribes the webhook endpoint to exactly these.
 */
export const STRIPE_WEBHOOK_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

export type StripeHandledWebhookEventType = (typeof STRIPE_WEBHOOK_EVENT_TYPES)[number];

export type StripeWebhookEvent =
  | { id: string; type: "checkout.session.completed"; session: StripeCheckoutSessionEventData }
  | { id: string; type: "customer.subscription.updated"; subscription: StripeSubscriptionEventData }
  | { id: string; type: "customer.subscription.deleted"; subscription: StripeSubscriptionEventData }
  | { id: string; type: "invoice.paid"; invoice: StripeInvoiceEventData }
  | { id: string; type: "invoice.payment_failed"; invoice: StripeInvoiceEventData }
  | { id: string; type: string };

export class StripeSignatureVerificationError extends Error {
  constructor(message = "Invalid Stripe webhook signature") {
    super(message);
    this.name = "StripeSignatureVerificationError";
  }
}

export interface StripeGateway {
  findPriceByLookupKey(key: string): Promise<StripePriceRef | null>;
  getProduct(id: string): Promise<StripeProductRef | null>;
  createCustomer(input: { email: string; accountId: string }): Promise<StripeCustomerRef>;
  createCheckoutSession(params: StripeCheckoutSessionParams): Promise<{ url: string }>;
  createPortalSession(params: StripePortalSessionParams): Promise<{ url: string }>;
  /** Verifies the signature, then adapts the raw event to our narrow shape. Throws
   *  {@link StripeSignatureVerificationError} on a bad signature. Async: a `checkout.session.completed`
   *  event needs a follow-up Stripe call (line items / subscription) to resolve the price. */
  constructWebhookEvent(rawBody: Buffer, signature: string): Promise<StripeWebhookEvent>;
  /**
   * Charges an existing subscription customer for one top-up pack, out of band from the
   * subscription's own billing cycle. Resolves the subscription's own default payment method and
   * passes it explicitly -- a standalone invoice (no `subscription` link) does not inherit it
   * automatically the way a subscription-cycle invoice would. Throws on any Stripe-side failure
   * (declined charge, network error); the caller marks its own bookkeeping row failed with a code
   * read off the thrown error.
   */
  createTopUpInvoice(params: StripeTopUpInvoiceParams): Promise<StripeTopUpInvoiceResult>;
}
