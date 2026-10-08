import { STRIPE_PLAN_METADATA_KEY } from "@radioso/plan-catalog";

import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { createPlansRoutes } from "./plansRoutes.js";
import { EnterpriseManagedModelPolicy } from "../managedModels/managedModelPolicy.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";
import { billingMigrator } from "./billingMigrator.js";
import { createBillingRoutes, type BillingConfig } from "./billingRoutes.js";
import { AutoTopUpDispatcher } from "./autoTopUpDispatcher.js";
import { StripeSdkGateway } from "./stripeSdkGateway.js";

// 60s: the same sweep-latency ceiling the usage-alert dispatcher uses -- auto top-up reacts to
// a usage level that the alert sweep already reports on the same cadence, so there is no reason
// for this sweep to run any tighter or looser.
const AUTO_TOP_UP_SWEEP_INTERVAL_MS = 60_000;

/**
 * Reads Stripe config from the environment, the way `googleLogin/applicationModule.ts` reads its
 * OAuth config. Missing `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` means billing is
 * unconfigured -- self-hosted installs never set these -- and `createBillingRoutes` degrades
 * `/me` to `{configured:false}` and 503s checkout/portal/webhook instead of throwing at boot.
 */
export const resolveBillingConfig = (processEnv: NodeJS.ProcessEnv = process.env): BillingConfig => {
  const secretKey = processEnv.STRIPE_SECRET_KEY?.trim() || null;
  const webhookSecret = processEnv.STRIPE_WEBHOOK_SECRET?.trim() || null;
  const metadataKey = processEnv.STRIPE_PLAN_METADATA_KEY?.trim() || STRIPE_PLAN_METADATA_KEY;
  return { configured: Boolean(secretKey && webhookSecret), secretKey, webhookSecret, metadataKey };
};

export const createBillingApplicationModule = (): ApplicationModule => {
  const config = resolveBillingConfig();
  // Shared between the route mount and the auto-top-up sweep below -- one Stripe client per
  // process, not one per consumer. `undefined` when billing is unconfigured (self-hosted
  // installs without Stripe); both consumers degrade accordingly (routes 503, the sweep no-ops).
  const gateway =
    config.configured && config.secretKey && config.webhookSecret
      ? new StripeSdkGateway({ secretKey: config.secretKey, webhookSecret: config.webhookSecret })
      : undefined;

  return {
    id: "radioso-enterprise-billing",
    name: "Radioso Enterprise Billing",
    register(context) {
      context.registerRouteMount({
        path: "/api/v1/plans",
        createRouter: () => createPlansRoutes(),
      });
      // The plan decides which models a managed workspace runs; the usage-limit service already
      // knows which plan an account is on, so the policy reads through it rather than re-deriving.
      context.registerManagedModelPolicy?.(({ database }) =>
        new EnterpriseManagedModelPolicy(new EnterpriseUsageLimitService(database)));

      context.registerDatabaseMigrator(billingMigrator);
      context.registerRouteMount({
        path: "/api/v1/ee/billing",
        createRouter: (dependencies) => createBillingRoutes(dependencies, config, { gateway }),
      });

      // Opt-in auto top-up's sweep: API runtime only, 60s tick (see `registerPeriodicTask`'s own
      // contract). No-ops immediately when `gateway` is undefined.
      context.registerPeriodicTask?.({
        id: "ee-billing-auto-top-up",
        intervalMs: AUTO_TOP_UP_SWEEP_INTERVAL_MS,
        create: (taskContext) =>
          new AutoTopUpDispatcher({
            database: taskContext.database,
            gateway,
            audit: taskContext.audit,
            logger: taskContext.logger,
          }),
      });
    },
  };
};
