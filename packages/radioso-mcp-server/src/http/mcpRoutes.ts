import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthService } from "../auth/authService.js";
import type { SessionServerManagerDependencies } from "./sessionServerManager.js";
import type { SessionMcpServerManager } from "./types.js";
import { createExpressMcpMiddleware } from "./expressAdapter.js";
import { createMcpRequestHandler } from "./requestHandler.js";
import type { RuntimeStoreReadiness } from "../state/runtimeStores.js";

export interface McpRouteDependencies extends SessionServerManagerDependencies {
  authService: AuthService;
  readiness?: RuntimeStoreReadiness;
  serverManager: SessionMcpServerManager;
}

export const createMcpRouteHandler = ({
  authService,
  config,
  readiness,
  serverManager,
}: McpRouteDependencies) => {
  const handler = createMcpRequestHandler({
    config,
    readiness,
    serverManager,
    verifyBearerToken: (accessToken) => authService.resolveBearerSession(accessToken),
  });
  const middleware = createExpressMcpMiddleware(handler, {
    fallbackHost: `${config.bindHost}:${config.bindPort}`,
  });

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    await middleware(req, res);
  };
};
