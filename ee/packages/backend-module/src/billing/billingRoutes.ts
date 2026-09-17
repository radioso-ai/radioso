import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";

import { PLAN_CATALOG, findPlan } from "@radioso/plan-catalog";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { HttpError } from "../shared/httpError.js";
import { requireAccountSession } from "../shared/requireAccountSession.js";
import { createEeKysely } from "../db/eeSchema.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";
import type { BillingCustomerRepository, BillingCustomerRow } from "./billingCustomerRepository.js";
import { PostgresBillingCustomerRepository } from "./billingCustomerRepository.js";
import { lookupKeyFor, upgradePlanIdFor } from "./planPricing.js";
import { handleBillingWebhookEvent } from "./billingWebhookHandler.js";
import { StripeSignatureVerificationError, type StripeGateway } from "./stripeGateway.js";

export interface BillingConfig {
  configured: boolean;
  secretKey: string | null;
  webhookSecret: string | null;
  metadataKey: string;
}

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

type BillingLogger = {
  info?(entry: Record<string, unknown>, message?: string): void;
  warn?(entry: Record<string, unknown>, message?: string): void;
};

const resolveLogger = (dependencies: RouteDependencies): BillingLogger => {
  const logger = (dependencies as RouteDependencies & { logger?: BillingLogger }).logger;
  return logger ?? {};
};

// Every catalog plan id, not just self-serve ones: a request naming a real but non-self-serve
// plan (the free plan, or a future hand-sold tier) must reach the handler's 409 check below
// rather than being rejected as 400 malformed input.
const catalogPlanIds = PLAN_CATALOG.plans.map((plan) => plan.id) as [string, ...string[]];

/** Relative to the dashboard origin. `//host/path` is protocol-relative -- an open redirect --
 *  so a leading double slash is rejected even though it "starts with /". */
const isValidReturnPath = (value: string): boolean => value.startsWith("/") && !value.startsWith("//");

const returnPathSchema = z.string().trim().min(1).max(500).refine(isValidReturnPath, {
  message: "returnPath must be a relative path starting with a single /",
});

const checkoutSubscriptionBodySchema = z.object({
  plan: z.enum(catalogPlanIds),
  interval: z.enum(["month", "year"]),
  returnPath: returnPathSchema,
});

const checkoutPackBodySchema = z.object({
  pack: z.literal(true),
  returnPath: returnPathSchema,
});

const checkoutBodySchema = z.union([checkoutSubscriptionBodySchema, checkoutPackBodySchema]);

const portalBodySchema = z.object({
  returnPath: returnPathSchema,
});

const parseRequest = <T>(schema: z.ZodType<T>, value: unknown, message: string): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new HttpError(400, "bad_request", message, parsed.error.flatten());
};

const requireConfigured = (config: BillingConfig): void => {
  if (!config.configured) {
    throw new HttpError(503, "billing_not_configured", "Billing is not configured.");
  }
};

const buildReturnUrl = (appBaseUrl: string, returnPath: string, query: string): string =>
  `${appBaseUrl}${returnPath}${returnPath.includes("?") ? "&" : "?"}billing=${query}`;

interface BillingRouteOverrides {
  gateway?: StripeGateway;
  repository?: BillingCustomerRepository;
  usageService?: Pick<EnterpriseUsageLimitService, "getAccountUsage" | "assignProfile" | "addCredits">;
}

const ensureCustomer = async (
  gateway: StripeGateway,
  repository: BillingCustomerRepository,
  input: { accountId: string; userEmail: string | null },
): Promise<BillingCustomerRow> => {
  const existing = await repository.findByAccount(input.accountId);
  if (existing) {
    return input.userEmail
      ? repository.upsertCustomer({
          accountId: input.accountId,
          stripeCustomerId: existing.stripeCustomerId,
          billingEmail: input.userEmail,
        })
      : existing;
  }
  const customer = await gateway.createCustomer({ email: input.userEmail ?? "", accountId: input.accountId });
  return repository.upsertCustomer({
    accountId: input.accountId,
    stripeCustomerId: customer.id,
    status: "none",
    billingEmail: input.userEmail,
  });
};

export const createBillingRoutes = (
  dependencies: RouteDependencies,
  config: BillingConfig,
  overrides: BillingRouteOverrides = {},
): ExpressRouter => {
  const router = Router();
  const logger = resolveLogger(dependencies);
  const appBaseUrl = (dependencies.env.APP_BASE_URL ?? "").replace(/\/+$/, "");

  if (!config.configured) {
    logger.warn?.({}, "EE billing is not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET missing); checkout, portal, and webhook routes will return 503.");
  }

  const repository =
    overrides.repository ?? new PostgresBillingCustomerRepository(createEeKysely(dependencies.connectorDb.pool));
  const usageService = overrides.usageService ?? new EnterpriseUsageLimitService(dependencies.connectorDb);
  const gateway = overrides.gateway ?? null;

  const requireGateway = (): StripeGateway => {
    requireConfigured(config);
    if (!gateway) {
      throw new HttpError(503, "billing_not_configured", "Billing is not configured.");
    }
    return gateway;
  };

  router.get("/me", requireAccountSession(dependencies), async (_req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      if (!config.configured) {
        res.status(200).json({ configured: false });
        return;
      }

      const usage = await usageService.getAccountUsage(accountId);
      const planId = usage.profile?.key ?? PLAN_CATALOG.defaultPlanId;
      const plan = findPlan(planId) ?? findPlan(PLAN_CATALOG.defaultPlanId)!;
      const row = await repository.findByAccount(accountId);

      res.status(200).json({
        configured: true,
        planId: plan.id,
        planName: plan.name,
        status: row?.status ?? "none",
        hasCustomer: Boolean(row),
        interval: row?.interval ?? null,
        currentPeriodEnd: row?.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
        upgradePlanId: upgradePlanIdFor(plan.id),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/checkout", requireAccountSession(dependencies), async (req, res, next) => {
    try {
      const activeGateway = requireGateway();
      const body = parseRequest(checkoutBodySchema, req.body, "Invalid checkout payload");
      const { accountId, userId } = res.locals as { accountId: string; userId: string };
      const user = await dependencies.userRepository.findById(userId);

      if ("pack" in body) {
        const priceRef = await activeGateway.findPriceByLookupKey(PLAN_CATALOG.topUp.stripeLookupKey);
        if (!priceRef) {
          throw new HttpError(503, "billing_not_configured", "The top-up price is not configured in Stripe.");
        }
        const customer = await ensureCustomer(activeGateway, repository, {
          accountId,
          userEmail: user?.email ?? null,
        });
        const session = await activeGateway.createCheckoutSession({
          mode: "payment",
          customerId: customer.stripeCustomerId,
          clientReferenceId: accountId,
          lineItems: [{ price: priceRef.id, quantity: 1 }],
          paymentMetadata: { accountId, kind: "topup" },
          successUrl: buildReturnUrl(appBaseUrl, body.returnPath, "success"),
          cancelUrl: buildReturnUrl(appBaseUrl, body.returnPath, "canceled"),
        });
        res.status(200).json({ url: session.url });
        return;
      }

      const plan = findPlan(body.plan);
      const lookupKey = lookupKeyFor(body.plan, body.interval);
      if (!plan?.stripe || !lookupKey) {
        throw new HttpError(409, "plan_not_self_serve", "This plan cannot be purchased through self-serve checkout.");
      }
      const priceRef = await activeGateway.findPriceByLookupKey(lookupKey);
      if (!priceRef) {
        throw new HttpError(503, "billing_not_configured", "The plan price is not configured in Stripe.");
      }
      const customer = await ensureCustomer(activeGateway, repository, {
        accountId,
        userEmail: user?.email ?? null,
      });
      const session = await activeGateway.createCheckoutSession({
        mode: "subscription",
        customerId: customer.stripeCustomerId,
        clientReferenceId: accountId,
        lineItems: [{ price: priceRef.id, quantity: 1 }],
        subscriptionMetadata: { accountId },
        successUrl: buildReturnUrl(appBaseUrl, body.returnPath, "success"),
        cancelUrl: buildReturnUrl(appBaseUrl, body.returnPath, "canceled"),
      });
      res.status(200).json({ url: session.url });
    } catch (error) {
      next(error);
    }
  });

  router.post("/portal", requireAccountSession(dependencies), async (req, res, next) => {
    try {
      const activeGateway = requireGateway();
      const body = parseRequest(portalBodySchema, req.body, "Invalid portal payload");
      const { accountId } = res.locals as { accountId: string };

      const existing = await repository.findByAccount(accountId);
      if (!existing) {
        throw new HttpError(404, "no_billing_customer", "This account has no billing customer yet.");
      }

      const session = await activeGateway.createPortalSession({
        customerId: existing.stripeCustomerId,
        returnUrl: `${appBaseUrl}${body.returnPath}`,
      });
      res.status(200).json({ url: session.url });
    } catch (error) {
      next(error);
    }
  });

  router.post("/webhook", async (req, res, next) => {
    try {
      const activeGateway = requireGateway();
      const signature = req.header("stripe-signature");
      const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
      if (!signature || !rawBody) {
        logger.warn?.({ outcome: "invalid_signature" }, "billing webhook");
        throw new HttpError(400, "invalid_signature", "Missing Stripe-Signature header or request body.");
      }

      let event;
      try {
        event = await activeGateway.constructWebhookEvent(rawBody, signature);
      } catch (error) {
        if (error instanceof StripeSignatureVerificationError) {
          logger.warn?.({ outcome: "invalid_signature" }, "billing webhook");
          throw new HttpError(400, "invalid_signature", "Invalid Stripe webhook signature.");
        }
        throw error;
      }

      const result = await handleBillingWebhookEvent(event, {
        repository,
        usage: usageService,
        gateway: activeGateway,
        mail: dependencies.mailService,
        audit: dependencies.auditService,
        logger: {
          info: (entry, message) => logger.info?.(entry, message),
          warn: (entry, message) => logger.warn?.(entry, message),
        },
        appBaseUrl,
        metadataKey: config.metadataKey,
      });
      res.status(200).json({ received: true, outcome: result.outcome });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
