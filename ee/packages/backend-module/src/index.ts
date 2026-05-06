import type { ApplicationModule } from "./radiosoModuleTypes.js";

import { HostedWebsiteEmbedIntegrationProvider } from "./websiteEmbedIntegration.js";
import { usageLimitMigrator } from "./usageLimits/usageLimitMigrator.js";
import { createUsageLimitRoutes } from "./usageLimits/usageLimitRoutes.js";
import { EnterpriseUsageLimitService } from "./usageLimits/usageLimitService.js";
import { humanContactMigrator } from "./humanContact/humanContactMigrator.js";
import { EnterpriseHumanContactService } from "./humanContact/humanContactService.js";
import { createHumanContactRoutes } from "./humanContact/humanContactRoutes.js";

const STARTER_PROFILE_KEY = "starter_100";
let usageLimitService: EnterpriseUsageLimitService | null = null;
let humanContactService: EnterpriseHumanContactService | null = null;

export const applicationModule: ApplicationModule = {
  id: "radioso-enterprise-backend",
  name: "Radioso Enterprise Backend",
  register(context) {
    context.registerDatabaseMigrator(usageLimitMigrator);
    context.registerDatabaseMigrator(humanContactMigrator);
    context.registerUsageLimitPolicy(({ database }) => {
      usageLimitService = new EnterpriseUsageLimitService(database);
      return usageLimitService;
    });
    context.registerAccountCreatedHandler(async ({ accountId, database }) => {
      const resolvedService = usageLimitService ?? new EnterpriseUsageLimitService(database);
      if (usageLimitService === null) {
        usageLimitService = resolvedService;
      }
      await resolvedService.assignProfile(accountId, STARTER_PROFILE_KEY);
    });
    context.registerChatActionProvider((dependencies) => {
      humanContactService?.stop();
      humanContactService = new EnterpriseHumanContactService(dependencies);
      return humanContactService;
    });
    context.registerContactHistoryProvider(() => {
      if (humanContactService) {
        return humanContactService;
      }
      throw new Error("Enterprise contact service is not initialized");
    });
    context.registerRouteMount({
      path: "/api/v1/ee/usage-limits",
      createRouter(dependencies) {
        return createUsageLimitRoutes(dependencies);
      },
    });
    context.registerRouteMount({
      path: "/api/v1/ee/contact",
      createRouter(dependencies) {
        if (!humanContactService) {
          throw new Error("Enterprise contact service is not initialized");
        }
        return createHumanContactRoutes(dependencies, humanContactService);
      },
    });
    context.registerWebsiteEmbedIntegration(new HostedWebsiteEmbedIntegrationProvider({
      widgetOrigin: process.env.RADIOSO_ENTERPRISE_WIDGET_ORIGIN,
      scriptPath: process.env.RADIOSO_ENTERPRISE_WIDGET_SCRIPT_PATH,
    }));
  },
  async shutdown() {
    humanContactService?.stop();
    humanContactService = null;
  },
};

export default applicationModule;
