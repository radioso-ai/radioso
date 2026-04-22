import type { IncomingMessage, ServerResponse } from "node:http";

import { toInternalAuthInfo, type SessionServerManagerDependencies } from "./sessionServerManager.js";
import type { SessionMcpServerManager } from "./types.js";
import { toWebRequest, writeJson, writeWebResponse } from "./nodeHttp.js";
import { readBearerToken } from "./authRoutes.js";

export interface McpRouteDependencies extends SessionServerManagerDependencies {
  serverManager: SessionMcpServerManager;
}

export const createMcpRouteHandler = ({
  authService,
  config,
  serverManager,
}: McpRouteDependencies) => {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const accessToken = readBearerToken(req);
    if (!accessToken) {
      writeJson(res, 401, {
        error: {
          code: "invalid_access_token",
          message: "MCP access token is invalid or expired.",
        },
      });
      return;
    }

    const session = await authService.getSession(accessToken);
    if (!session) {
      writeJson(res, 401, {
        error: {
          code: "invalid_access_token",
          message: "MCP access token is invalid or expired.",
        },
      });
      return;
    }

    const handle = await serverManager.getOrCreate(session);
    const acceptHeader = req.headers.accept;
    if (
      typeof acceptHeader !== "string"
      || !acceptHeader.includes("application/json")
      || !acceptHeader.includes("text/event-stream")
    ) {
      req.headers.accept = "application/json, text/event-stream";
    }
    const request = await toWebRequest(req, `${config.bindHost}:${config.bindPort}`);
    const authInfo = toInternalAuthInfo(session, accessToken);
    const response = await handle.transport.handleRequest(request, { authInfo });
    await writeWebResponse(res, response);
  };
};
