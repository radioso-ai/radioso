import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { RemoteHttpDependencies } from "./types.js";
import { createMcpRouteHandler } from "./mcpRoutes.js";
import { createSessionMcpServerManager } from "./sessionServerManager.js";
import { isRequestBodyTooLargeError, writeJson, writeJsonRpcError } from "./nodeHttp.js";
import { createFixedWindowPreAuthSourceBudget, digestPeerSource } from "./preAuthSourceBudget.js";

export interface RadiosoRemoteHttpServer {
  close(): Promise<void>;
  listen(): Promise<Server>;
  server: Server;
}

export const createHttpServer = ({ authService, auditLogger, config, readiness, preAuthSourceBudget }: RemoteHttpDependencies): RadiosoRemoteHttpServer => {
  const sourceBudget = preAuthSourceBudget ?? createFixedWindowPreAuthSourceBudget({
    maxAttempts: 60,
    windowMs: 60_000,
  });
  const sessionServerManager = createSessionMcpServerManager({
    auditLogger,
    config,
    entryPoint: "standalone",
  });
  const handleMcp = createMcpRouteHandler({
    authService,
    config,
    readiness,
    serverManager: sessionServerManager,
  });

  const writeUnhandledError = (req: IncomingMessage, res: ServerResponse, error: unknown) => {
    if (isRequestBodyTooLargeError(error)) {
      if ((req.url ?? "").startsWith("/mcp")) {
        writeJsonRpcError(res, 413, -32000, "Request body is too large.", {
          code: error.code,
          maxBytes: error.maxBytes,
        });
        return;
      }

      writeJson(res, 413, {
        error: {
          code: error.code,
          message: "Request body is too large.",
          maxBytes: error.maxBytes,
        },
      });
      return;
    }

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
        res.setHeader("Access-Control-Allow-Origin", "*");
        writeJson(res, 200, {
          serverName: config.serverName,
          status: "ok",
        });
        return;
      }

      if (url.pathname === "/mcp") {
        if (!await sourceBudget.consume({ sourceDigest: digestPeerSource(req, config.trustedProxyHops) })) {
          writeJsonRpcError(res, 429, -32003, "Too many requests.", { code: "rate_limit_exceeded" });
          return;
        }
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
      if (!server.listening) {
        return;
      }

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
