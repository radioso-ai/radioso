import type { IncomingMessage, ServerResponse } from "node:http";

import type { SessionServerManagerDependencies } from "./sessionServerManager.js";
import type { SessionMcpServerManager } from "./types.js";
import { createExpressMcpMiddleware } from "./expressAdapter.js";
import { createMcpRequestHandler } from "./requestHandler.js";

export interface McpRouteDependencies extends SessionServerManagerDependencies {
  serverManager: SessionMcpServerManager;
}

export const createMcpRouteHandler = ({
  authService,
  config,
  serverManager,
}: McpRouteDependencies) => {
  const handler = createMcpRequestHandler({
    config,
    serverManager,
    verifyBearerToken: (accessToken) => authService.getSession(accessToken),
  });
  const middleware = createExpressMcpMiddleware(handler, {
    fallbackHost: `${config.bindHost}:${config.bindPort}`,
  });

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    await middleware(req, res);
  };
};
