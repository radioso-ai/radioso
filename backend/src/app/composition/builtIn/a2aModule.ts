import { A2A_ENDPOINT_MOUNT_PATH } from "../../../modules/agentDiscovery/public.js";
import { createA2aErrorHandler, createA2aRouter } from "../a2a.js";
import type { ApplicationModule } from "../applicationModule.js";

/**
 * The A2A JSON-RPC endpoint, at the path the agent card names (`A2A_ENDPOINT_MOUNT_PATH`, shared
 * with the URL the card builds so the two cannot drift).
 */
export const createA2aApplicationModule = (): ApplicationModule => ({
  id: "radioso-a2a",
  name: "Radioso A2A",
  register(context) {
    context.registerRouteMount({
      path: A2A_ENDPOINT_MOUNT_PATH,
      createRouter: (dependencies) => createA2aRouter(dependencies),
      createErrorHandler: (dependencies) => createA2aErrorHandler(dependencies),
    });
  },
});
