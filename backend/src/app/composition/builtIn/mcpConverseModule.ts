import { createMcpConverseRoutes } from "../../http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../server/dependencyBuilders.js";
import type { ApplicationModule } from "../applicationModule.js";

export const createMcpConverseApplicationModule = (): ApplicationModule => ({
  id: "radioso-mcp-converse",
  name: "Radioso MCP Converse",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/mcp/converse",
      // The converse service graph is built in app wiring (buildMcpConverseServices) so the HTTP
      // route never value-imports module internals; it receives ready-built services.
      createRouter(dependencies) {
        return createMcpConverseRoutes(dependencies, buildMcpConverseServices(dependencies));
      },
    });
  },
});
