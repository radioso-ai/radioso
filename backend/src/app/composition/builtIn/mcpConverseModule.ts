import { createMcpConverseRoutes } from "../../http/routes/mcpConverseRoutes.js";
import type { ApplicationModule } from "../applicationModule.js";

export const createMcpConverseApplicationModule = (): ApplicationModule => ({
  id: "radioso-mcp-converse",
  name: "Radioso MCP Converse",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/mcp/converse",
      createRouter() {
        return createMcpConverseRoutes();
      },
    });
  },
});
