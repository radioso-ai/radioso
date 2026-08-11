import { createAudiencePulseRoutes } from "../../../modules/audiencePulse/composition.js";
import type { ApplicationModule } from "../applicationModule.js";

/** Default assembly owns the route mount; the service is composed once with the app dependencies. */
export const createAudiencePulseApplicationModule = (): ApplicationModule => ({
  id: "radioso-audience-pulse",
  name: "Audience Pulse",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/quality/audience-pulse",
      createRouter: (dependencies) => createAudiencePulseRoutes(dependencies, dependencies.audiencePulseService),
    });
  },
});
