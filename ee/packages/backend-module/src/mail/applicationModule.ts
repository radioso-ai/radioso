import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { createEnterpriseAuthRoutes } from "./enterpriseAuthRoutes.js";
import { mailTokenMigrator } from "./mailTokenMigrator.js";

export const createEnterpriseAuthApplicationModule = (): ApplicationModule => ({
  id: "radioso-enterprise-auth",
  name: "Radioso Enterprise Auth",
  register(context) {
    context.registerDatabaseMigrator(mailTokenMigrator);
    context.registerRouteMount({
      path: "/api/v1/ee/auth",
      createRouter(dependencies) {
        return createEnterpriseAuthRoutes(dependencies);
      },
    });
  },
});
