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
}

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
}
