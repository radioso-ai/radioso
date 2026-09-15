import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { createPlansRoutes } from "./plansRoutes.js";

// Stripe checkout and webhook handling land in this module in a later change; today it only
// publishes the plan catalog.
export const createBillingApplicationModule = (): ApplicationModule => ({
  id: "radioso-enterprise-billing",
  name: "Radioso Enterprise Billing",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/plans",
      createRouter: () => createPlansRoutes(),
    });
  },
});
