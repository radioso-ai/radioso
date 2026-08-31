import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { usageLimitMigrator } from "./usageLimitMigrator.js";
import { createUsageLimitRoutes } from "./usageLimitRoutes.js";
import { EnterpriseUsageLimitService } from "./usageLimitService.js";
import { EnterpriseOrganizationCreationGuard } from "../orgCreation/organizationCreationGuard.js";
import { createUsageLimitCopilotToolContribution } from "./copilotTools.js";

const STARTER_PROFILE_KEY = "starter_100";

export const createUsageLimitsApplicationModule = (): ApplicationModule => ({
  id: "radioso-enterprise-usage-limits",
  name: "Radioso Enterprise Usage Limits",
  register(context) {
    context.registerDatabaseMigrator(usageLimitMigrator);
    context.registerUsageLimitPolicy(({ database }) => {
      return new EnterpriseUsageLimitService(database);
    });
    context.registerOrganizationCreationGuard?.(({ database }) => {
      return new EnterpriseOrganizationCreationGuard(database);
    });
    // The durable usage-event recorder is now an OSS default (registered in
    // backend composition). EE no longer registers its own to avoid a second
    // ledger path; it continues to own usage-LIMIT enforcement above.
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
    // Without this the plan an operator is billed against is invisible to Ray, which then advises
    // on ingestion volume with no idea what the account is allowed to store.
    context.registerCopilotTools?.(({ database }) =>
      createUsageLimitCopilotToolContribution({ usage: new EnterpriseUsageLimitService(database) }));
  },
});
