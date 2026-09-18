import { STRIPE_PLAN_METADATA_KEY } from "@radioso/plan-catalog";

import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { createPlansRoutes } from "./plansRoutes.js";
import { EnterpriseManagedModelPolicy } from "../managedModels/managedModelPolicy.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";
import { billingMigrator } from "./billingMigrator.js";
import { createBillingRoutes, type BillingConfig } from "./billingRoutes.js";
import { StripeSdkGateway } from "./stripeSdkGateway.js";

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
        createRouter: (dependencies) =>
          createBillingRoutes(dependencies, config, {
            gateway:
              config.configured && config.secretKey && config.webhookSecret
                ? new StripeSdkGateway({ secretKey: config.secretKey, webhookSecret: config.webhookSecret })
                : undefined,
          }),
      });
    },
  };
};
