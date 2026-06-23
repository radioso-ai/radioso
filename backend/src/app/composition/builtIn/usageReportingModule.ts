import {
  UsageTrendsService,
  createUsageTrendsRoutes,
} from "../../../modules/reporting/composition.js";
import type { ApplicationModule } from "../applicationModule.js";

export const createUsageReportingApplicationModule = (): ApplicationModule => ({
  id: "radioso-usage-reporting",
  name: "Radioso Usage Reporting",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/account",
      createRouter(dependencies) {
        const service = new UsageTrendsService(dependencies.connectorDb.kysely, dependencies.accountAccessService);
        return createUsageTrendsRoutes(dependencies, service);
      },
    });
  },
});
