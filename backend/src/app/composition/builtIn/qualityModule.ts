import {
  QualityTurnsService,
  createQualityRoutes,
} from "../../../modules/quality/composition.js";
import type { ApplicationModule } from "../applicationModule.js";

export interface QualityModuleState {
  service: QualityTurnsService | null;
}

export const createQualityApplicationModule = (
  state: QualityModuleState = { service: null },
): ApplicationModule => ({
  id: "radioso-quality",
  name: "Radioso Quality",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/quality",
      createRouter(dependencies) {
        if (!state.service) {
          state.service = new QualityTurnsService(dependencies.connectorDb);
        }
        return createQualityRoutes(dependencies, state.service);
      },
    });
  },
  async shutdown() {
    state.service = null;
  },
});
