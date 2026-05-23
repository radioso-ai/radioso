import type { ApplicationModule } from "./radiosoModuleTypes.js";

import { createHumanContactApplicationModule } from "./humanContact/applicationModule.js";
import { createEnterpriseObservabilityApplicationModule } from "./observability/applicationModule.js";
import { createUsageLimitsApplicationModule } from "./usageLimits/applicationModule.js";

export {
  collectFrontendRouteContributions,
  validateFeatureManifests,
  type FeatureManifest,
  type FrontendRouteContribution,
} from "./featureManifest.js";
export { createUsageLimitsApplicationModule } from "./usageLimits/applicationModule.js";
export { createHumanContactApplicationModule } from "./humanContact/applicationModule.js";
export { createEnterpriseObservabilityApplicationModule } from "./observability/applicationModule.js";

export const createEnterpriseBackendModule = (): ApplicationModule => {
  const featureModules = [
    createEnterpriseObservabilityApplicationModule(),
    createUsageLimitsApplicationModule(),
    createHumanContactApplicationModule(),
  ];

  return {
    id: "radioso-enterprise-backend",
    name: "Radioso Enterprise Backend",
    register(context) {
      for (const module of featureModules) {
        module.register?.(context);
      }
    },
    async shutdown() {
      for (const module of [...featureModules].reverse()) {
        await module.shutdown?.();
      }
    },
  };
};

export const applicationModule: ApplicationModule = createEnterpriseBackendModule();

export default applicationModule;
