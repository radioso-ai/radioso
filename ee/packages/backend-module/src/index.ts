import type { ApplicationModule } from "./radiosoModuleTypes.js";

import { createEnterpriseObservabilityApplicationModule } from "./observability/applicationModule.js";
import { createUsageLimitsApplicationModule } from "./usageLimits/applicationModule.js";
import { createGoogleLoginApplicationModule } from "./googleLogin/applicationModule.js";
import { createStaffConsoleApplicationModule } from "./staffConsole/applicationModule.js";

export {
  collectFrontendRouteContributions,
  validateFeatureManifests,
  type FeatureManifest,
  type FrontendRouteContribution,
} from "./featureManifest.js";
export { createUsageLimitsApplicationModule } from "./usageLimits/applicationModule.js";
export { createEnterpriseObservabilityApplicationModule } from "./observability/applicationModule.js";
export { createGoogleLoginApplicationModule } from "./googleLogin/applicationModule.js";
export { createStaffConsoleApplicationModule } from "./staffConsole/applicationModule.js";

export const createEnterpriseBackendModule = (): ApplicationModule => {
  const featureModules = [
    createEnterpriseObservabilityApplicationModule(),
    createUsageLimitsApplicationModule(),
    createStaffConsoleApplicationModule(),
    createGoogleLoginApplicationModule(),
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
