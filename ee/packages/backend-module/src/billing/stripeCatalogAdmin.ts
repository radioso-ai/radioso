/**
 * The narrow port the Stripe catalog sync drives: read and write the account-level objects the
 * plan catalog maps onto (products, lookup-keyed prices, the customer-portal configuration, webhook
 * endpoints, tax defaults). Only `stripeSdkCatalogAdmin.ts` implements it against the `stripe` SDK;
 * the planner and the command see these shapes, never Stripe's types. It is a separate port from
 * the runtime `StripeGateway` because its consumer is an operator CLI configuring an account, not
 * the request path taking payments.
 */
import type { PlanTaxBehavior } from "@radioso/plan-catalog";

import type { StripeHandledWebhookEventType } from "./stripeGateway.js";

export type StripeRecurringInterval = "month" | "year";

export interface StripeAccountSummary {
  id: string;
  name: string | null;
}

export interface StripeProductState {
  id: string;
  name: string;
  active: boolean;
  taxCode: string | null;
  metadata: Readonly<Record<string, string>>;
}

export interface StripeProductInput {
  /** Caller-chosen product id; Stripe keeps it, which is what makes re-runs find the same product. */
  id: string;
  name: string;
  taxCode: string;
  metadata: Readonly<Record<string, string>>;
}

export interface StripeProductPatch {
  name?: string;
  active?: boolean;
  taxCode?: string;
  /** Merged into the product's metadata; an empty-string value removes that key. */
  metadata?: Readonly<Record<string, string>>;
}

export interface StripePriceState {
  id: string;
  lookupKey: string;
  active: boolean;
  productId: string;
  unitAmount: number | null;
  currency: string;
  /** Null on a one-time price. */
  recurring: { interval: string; intervalCount: number } | null;
  taxBehavior: string | null;
}

export interface StripePriceInput {
  productId: string;
  lookupKey: string;
  unitAmount: number;
  currency: string;
  /** Null creates a one-time price. */
  recurringInterval: StripeRecurringInterval | null;
  taxBehavior: PlanTaxBehavior;
  /** Moves the lookup key off whichever price holds it, atomically with the create. */
  transferLookupKey: boolean;
}

export interface StripeWebhookEndpointState {
  id: string;
  url: string;
  enabledEvents: readonly string[];
  /** Null when the endpoint follows the account's default API version. */
  apiVersion: string | null;
  enabled: boolean;
}

export interface StripeWebhookEndpointInput {
  url: string;
  enabledEvents: readonly StripeHandledWebhookEventType[];
}

export interface StripeCreatedWebhookEndpoint {
  id: string;
  /** Stripe returns the signing secret only in the create response. */
  secret: string;
}

export interface StripePortalProduct {
  productId: string;
  priceIds: readonly string[];
}

export interface StripePortalFeatures {
  customerUpdate: { enabled: boolean; allowedUpdates: readonly string[] };
  invoiceHistory: { enabled: boolean };
  paymentMethodUpdate: { enabled: boolean };
  subscriptionCancel: { enabled: boolean; mode: string };
  subscriptionUpdate: {
    enabled: boolean;
    defaultAllowedUpdates: readonly string[];
    prorationBehavior: string;
    products: readonly StripePortalProduct[];
  };
}

export interface StripePortalConfigurationState {
  id: string;
  /** Portal sessions opened without an explicit configuration use the default one. */
  isDefault: boolean;
  features: StripePortalFeatures;
}

export interface StripeTaxSettingsState {
  /** `active` once Stripe Tax can calculate; `pending` until the head office address is set. */
  status: string;
  missingFields: readonly string[];
  defaultTaxBehavior: string | null;
  defaultTaxCode: string | null;
}

export interface StripeTaxDefaultsInput {
  taxBehavior: PlanTaxBehavior;
  taxCode: string;
}

export interface StripeCatalogAdmin {
  /**
   * The Stripe API version this adapter speaks, which is also the version the runtime gateway parses
   * webhook payloads in. Endpoints it creates are pinned to it.
   */
  readonly apiVersion: string;
  retrieveAccount(): Promise<StripeAccountSummary>;
  /** Null when no product has that id. */
  retrieveProduct(id: string): Promise<StripeProductState | null>;
  createProduct(input: StripeProductInput): Promise<void>;
  updateProduct(id: string, patch: StripeProductPatch): Promise<void>;
  /** The price holding the lookup key, preferring an active one; null when no price holds it. */
  findPriceByLookupKey(lookupKey: string): Promise<StripePriceState | null>;
  createPrice(input: StripePriceInput): Promise<{ id: string }>;
  listWebhookEndpoints(): Promise<StripeWebhookEndpointState[]>;
  createWebhookEndpoint(input: StripeWebhookEndpointInput): Promise<StripeCreatedWebhookEndpoint>;
  /** Sets the endpoint's events and turns it back on if it was disabled. */
  updateWebhookEndpoint(id: string, input: { enabledEvents: readonly StripeHandledWebhookEventType[] }): Promise<void>;
  /** The default portal configuration, or else the one an earlier sync run created; null when neither exists. */
  findPortalConfiguration(): Promise<StripePortalConfigurationState | null>;
  createPortalConfiguration(features: StripePortalFeatures): Promise<StripePortalConfigurationState>;
  updatePortalConfiguration(id: string, features: StripePortalFeatures): Promise<void>;
  retrieveTaxSettings(): Promise<StripeTaxSettingsState>;
  updateTaxDefaults(input: StripeTaxDefaultsInput): Promise<void>;
  countActiveTaxRegistrations(): Promise<number>;
}
