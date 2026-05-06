import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { usageLimitMigrator } from "./usageLimitMigrator.js";
import { createUsageLimitRoutes } from "./usageLimitRoutes.js";
import { EnterpriseUsageLimitService } from "./usageLimitService.js";

const STARTER_PROFILE_KEY = "starter_100";

export const createUsageLimitsApplicationModule = (): ApplicationModule => ({
  id: "radioso-enterprise-usage-limits",
  name: "Radioso Enterprise Usage Limits",
  register(context) {
    context.registerDatabaseMigrator(usageLimitMigrator);
    context.registerUsageLimitPolicy(({ database }) => {
      return new EnterpriseUsageLimitService(database);
    });
    context.registerAccountCreatedHandler(async ({ accountId, database }) => {
      const resolvedService = new EnterpriseUsageLimitService(database);
      await resolvedService.assignProfile(accountId, STARTER_PROFILE_KEY);
    });
    context.registerRouteMount({
      path: "/api/v1/ee/usage-limits",
      createRouter(dependencies) {
        return createUsageLimitRoutes(dependencies);
      },
    });
  },
});
