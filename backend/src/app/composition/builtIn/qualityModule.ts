import { createQualityRoutes } from "../../../modules/quality/composition.js";
import type { ApplicationModule } from "../applicationModule.js";

export const createQualityApplicationModule = (): ApplicationModule => ({
  id: "radioso-quality",
  name: "Radioso Quality",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/quality",
      createRouter(dependencies) {
        return createQualityRoutes(dependencies, dependencies.qualitySignalsService);
      },
    });
  },
});
