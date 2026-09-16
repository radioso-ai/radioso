import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { createPlansRoutes } from "./plansRoutes.js";
import { EnterpriseManagedModelPolicy } from "../managedModels/managedModelPolicy.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";

// Stripe checkout and webhook handling land in this module in a later change; today it
// publishes the plan catalog and applies the plan's model lock.
export const createBillingApplicationModule = (): ApplicationModule => ({
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
  },
});
