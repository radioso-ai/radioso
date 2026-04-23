import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { RemoteHttpDependencies } from "./types.js";
import { createApprovalHandler, createAuthExchangeHandler } from "./authRoutes.js";
import { createMcpRouteHandler } from "./mcpRoutes.js";
import { createSessionMcpServerManager } from "./sessionServerManager.js";
import { writeJson, writeJsonRpcError } from "./nodeHttp.js";

export interface RadiosoRemoteHttpServer {
  close(): Promise<void>;
  listen(): Promise<Server>;
  server: Server;
}

export const createHttpServer = ({ authService, auditLogger, config }: RemoteHttpDependencies): RadiosoRemoteHttpServer => {
  const sessionServerManager = createSessionMcpServerManager({
    authService,
    auditLogger,
    config,
  });
  const handleExchange = createAuthExchangeHandler({ auditLogger, authService });
  const handleApproval = createApprovalHandler({ auditLogger, authService });
  const handleMcp = createMcpRouteHandler({
    authService,
    config,
    serverManager: sessionServerManager,
  });

  const writeUnhandledError = (req: IncomingMessage, res: ServerResponse, _error: unknown) => {
    if ((req.url ?? "").startsWith("/mcp")) {
      writeJsonRpcError(res, 500, -32603, "Internal error", {
        code: "internal_error",
      });
      return;
    }

    writeJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Unexpected remote MCP server error.",
      },
    });
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${config.bindHost}:${config.bindPort}`}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        writeJson(res, 200, {
          serverName: config.serverName,
          status: "ok",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/exchange") {
        await handleExchange(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/approvals") {
        await handleApproval(req, res);
        return;
      }

      if (url.pathname === "/mcp") {
        await handleMcp(req, res);
        return;
      }

      writeJson(res, 404, {
        error: {
          code: "not_found",
          message: "Route not found.",
        },
      });
    } catch (error) {
      writeUnhandledError(req, res, error);
    }
  });

  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.bindPort, config.bindHost, () => {
          server.off("error", reject);
          resolve();
        });
      });

      return server;
    },
    server,
  };
};
