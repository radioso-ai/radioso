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
  /** Null until the invoice is finalized. Never surfaced in a notice email -- the log mail
   *  driver prints full message text, and Stripe's hosted invoice URL is not something to put
   *  there; a notice links to the dashboard's usage tab instead, where Manage billing opens the
   *  portal with every invoice. */
  hostedInvoiceUrl: string | null;
}

export interface StripeTopUpInvoiceDraftParams {
  customerId: string;
  subscriptionId: string;
  metadata: Record<string, string>;
  /** Derived from the auto-top-up row's id (`<rowId>:create`), so a re-drive after an ambiguous
   *  failure returns the SAME invoice Stripe already created rather than a second one. */
  idempotencyKey: string;
}

export interface StripeTopUpChargeParams {
  invoiceId: string;
  customerId: string;
  priceId: string;
  /** The bare auto-top-up row id. Item/finalize/pay each derive their own sub-key from it
   *  (`<id>:item`, `<id>:finalize`, `<id>:pay`), so a re-drive replays the exact same sequence
   *  Stripe already has idempotency records for (kept 24h), rather than double-charging. */
  idempotencyKey: string;
}

export interface StripeTopUpChargeResult {
  /** `"open"` only in the rare case neither `finalizeInvoice` nor `pay` resolved it -- the row
   *  stays `pending` and a later re-drive tries `pay` again. A decline or invalid request throws
   *  {@link StripeDefinitiveChargeError} instead of returning `"open"`. */
  status: "paid" | "open";
}

/**
 * Thrown by {@link StripeGateway.chargeTopUpInvoice} for a definitive, non-retryable charge
 * failure -- a card decline or an invalid request -- as opposed to an ambiguous failure (network,
 * timeout, 5xx, rate limit) where the charge's outcome at Stripe is unknown. Callers must treat
 * only this type as "the charge failed"; anything else must leave the row `pending` for re-drive,
 * since Stripe may have charged the card before the response was lost.
 */
export class StripeDefinitiveChargeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "StripeDefinitiveChargeError";
  }
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
   * Creates the draft invoice for one top-up pack charge, out of band from the subscription's own
   * billing cycle (`auto_advance: false` -- Stripe must never retry collection on its own
   * schedule; only an explicit {@link chargeTopUpInvoice} call attempts payment). Resolves the
   * subscription's own default payment method and passes it explicitly, since a standalone
   * invoice (no `subscription` link) does not inherit it automatically the way a
   * subscription-cycle invoice would. Returns as soon as the invoice exists -- before any item,
   * finalize, or pay call -- so the caller can persist the invoice id first and never lose track
   * of a charge that may already be in flight at Stripe.
   */
  createTopUpInvoiceDraft(params: StripeTopUpInvoiceDraftParams): Promise<{ invoiceId: string }>;
  /**
   * Attaches the top-up price as a line item, finalizes, and pays the given draft invoice.
   * Throws {@link StripeDefinitiveChargeError} on a card decline or invalid request; any other
   * thrown error is ambiguous (network, timeout, 5xx, rate limit) and the caller must leave its
   * bookkeeping row `pending` for a later re-drive with the same `idempotencyKey`, since the
   * charge's outcome at Stripe is unknown.
   */
  chargeTopUpInvoice(params: StripeTopUpChargeParams): Promise<StripeTopUpChargeResult>;
  /** Voids an invoice so a later attempt cannot succeed against it. Safe to call defensively --
   *  Stripe rejects voiding an invoice that is already paid or already void; callers swallow that. */
  voidInvoice(invoiceId: string): Promise<void>;
}
