import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { createStaffConsoleRoutes } from "./staffConsoleRoutes.js";
import { staffConsoleMigrator } from "./staffConsoleMigrator.js";

export const createStaffConsoleApplicationModule = (): ApplicationModule => ({
  id: "radioso-enterprise-operator-console",
  name: "Radioso Enterprise Operator Console",
  register(context) {
    context.registerDatabaseMigrator(staffConsoleMigrator);
    context.registerRouteMount({
      path: "/api/v1/ee/operator-console",
      createRouter(dependencies) {
        return createStaffConsoleRoutes(dependencies);
      },
    });
  },
});
