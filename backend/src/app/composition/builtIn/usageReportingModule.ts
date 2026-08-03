import {
  UsageDetailsService,
  UsageTrendsService,
  createUsageReportingRoutes,
} from "../../../modules/reporting/composition.js";
import { UsageDetailsReportingRepository } from "../../../db/repositories/usageDetailsReportingRepository.js";
import type { ApplicationModule } from "../applicationModule.js";

export const createUsageReportingApplicationModule = (): ApplicationModule => ({
  id: "radioso-usage-reporting",
  name: "Radioso Usage Reporting",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/account",
      createRouter(dependencies) {
        const trendsService = new UsageTrendsService(dependencies.connectorDb.kysely, dependencies.accountAccessService);
        const detailsService = new UsageDetailsService(
          new UsageDetailsReportingRepository(dependencies.connectorDb.kysely),
          dependencies.accountAccessService,
        );
        return createUsageReportingRoutes(dependencies, trendsService, detailsService);
      },
    });
  },
});
