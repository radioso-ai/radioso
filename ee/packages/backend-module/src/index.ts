import type { ApplicationModule } from "./radiosoModuleTypes.js";

import { HostedWebsiteEmbedIntegrationProvider } from "./websiteEmbedIntegration.js";
import { createEnterpriseAuthRoutes } from "./mail/enterpriseAuthRoutes.js";
import { mailTokenMigrator } from "./mail/mailTokenMigrator.js";
import { usageLimitMigrator } from "./usageLimits/usageLimitMigrator.js";
import { createUsageLimitRoutes } from "./usageLimits/usageLimitRoutes.js";
import { EnterpriseUsageLimitService } from "./usageLimits/usageLimitService.js";

export {
  EmailService,
  LogEmailDriver,
  NoopEmailDriver,
  ResendEmailDriver,
  createEnterpriseEmailService,
  type EmailDriver,
  type EmailMessage,
  type EmailVerificationInput,
  type EnterpriseEmailEnv,
  type PasswordResetEmailInput,
} from "./mail/emailService.js";

export const applicationModule: ApplicationModule = {
  id: "radioso-enterprise-backend",
  name: "Radioso Enterprise Backend",
  register(context) {
    context.registerDatabaseMigrator(usageLimitMigrator);
    context.registerDatabaseMigrator(mailTokenMigrator);
    context.registerUsageLimitPolicy(({ database }) => new EnterpriseUsageLimitService(database));
    context.registerRouteMount({
      path: "/api/v1/ee/usage-limits",
      createRouter(dependencies) {
        return createUsageLimitRoutes(dependencies.connectorDb);
      },
    });
    context.registerRouteMount({
      path: "/api/v1/ee/auth",
      createRouter(dependencies) {
        return createEnterpriseAuthRoutes(dependencies);
      },
    });
    context.registerWebsiteEmbedIntegration(new HostedWebsiteEmbedIntegrationProvider({
      widgetOrigin: process.env.RADIOSO_ENTERPRISE_WIDGET_ORIGIN,
      scriptPath: process.env.RADIOSO_ENTERPRISE_WIDGET_SCRIPT_PATH,
    }));
  },
};

export default applicationModule;
