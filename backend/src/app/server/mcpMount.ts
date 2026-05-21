import type { Express, NextFunction, Request, Response } from "express";
import {
  createMcpExpressRuntime,
  type PublicMcpRuntimeConfig,
  type VerifiedMcpBearerToken,
} from "@radioso/mcp-server";

import {
  MCP_CONTEXT_VERSION,
  resolveSupportedMcpToolsForPrincipal,
} from "../http/mcpContextSupport.js";
import type { AppDependencies } from "./types.js";

type McpMountDependencies = Pick<
  AppDependencies,
  "accountAccessService" | "authService" | "env" | "logger" | "workspaceRepository"
>;

const splitToolList = (value: string | undefined): string[] | undefined =>
  value
    ? value.split(",").map((part) => part.trim()).filter((part) => part.length > 0)
    : undefined;

export const getMcpMountStatus = (
  env: Pick<AppDependencies["env"], "RADIOSO_MCP_ENABLED" | "RADIOSO_MCP_MOUNT_PATH" | "RADIOSO_MCP_STANDALONE">,
) => {
  const enabled = env.RADIOSO_MCP_ENABLED && !env.RADIOSO_MCP_STANDALONE;
  return {
    enabled,
    mode: enabled ? "merged" : env.RADIOSO_MCP_STANDALONE ? "standalone" : "disabled",
    path: env.RADIOSO_MCP_MOUNT_PATH,
    standalone: env.RADIOSO_MCP_STANDALONE,
  };
};

const buildMergedMcpConfig = (env: AppDependencies["env"]): PublicMcpRuntimeConfig => {
  const baseUrl = env.RADIOSO_BASE_URL ?? env.APP_BASE_URL;
  if (!baseUrl) {
    throw new Error("RADIOSO_BASE_URL or APP_BASE_URL is required when backend MCP is enabled.");
  }
  if (!env.RADIOSO_MCP_SIGNING_SECRET) {
    throw new Error("RADIOSO_MCP_SIGNING_SECRET is required when backend MCP is enabled.");
  }

  return {
    accessTokenTtlSeconds: env.RADIOSO_MCP_ACCESS_TOKEN_TTL_SECONDS,
    allowedReadTools: splitToolList(env.RADIOSO_MCP_ALLOWED_READ_TOOLS),
    allowedWriteTools: splitToolList(env.RADIOSO_MCP_ALLOWED_WRITE_TOOLS),
    approvalRequiredWriteTools: splitToolList(env.RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS),
    auditLogPath: env.RADIOSO_MCP_AUDIT_LOG_PATH,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    bindHost: env.RADIOSO_MCP_BIND_HOST,
    bindPort: env.RADIOSO_MCP_BIND_PORT,
    redisKeyPrefix: env.RADIOSO_MCP_REDIS_KEY_PREFIX,
    redisUrl: env.RADIOSO_MCP_REDIS_URL,
    requestTimeoutMs: env.RADIOSO_MCP_REQUEST_TIMEOUT_MS,
    serverName: env.RADIOSO_MCP_SERVER_NAME,
    signingSecret: env.RADIOSO_MCP_SIGNING_SECRET,
    workspacePoliciesPath: env.RADIOSO_MCP_WORKSPACE_POLICIES_PATH,
  };
};

const applyMergedMcpCors = (
  req: Request,
  res: Response,
  origins: string,
): boolean => {
  const origin = req.header("origin");
  const allowAny = origins.trim() === "*";
  const allowedOrigins = allowAny
    ? []
    : origins.split(",").map((part) => part.trim()).filter((part) => part.length > 0);

  if (allowAny) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Accept",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "600");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }

  return false;
};

export const mountMergedMcp = (app: Express, dependencies: McpMountDependencies): void => {
  if (!dependencies.env.RADIOSO_MCP_ENABLED || dependencies.env.RADIOSO_MCP_STANDALONE) {
    return;
  }

  const runtime = (async () => {
    const config = buildMergedMcpConfig(dependencies.env);
    const verifyBearerToken = async (token: string): Promise<VerifiedMcpBearerToken | null> => {
      try {
        const auth = await dependencies.authService.authenticateApiToken(token);
        const workspace = await dependencies.workspaceRepository.findById(auth.workspaceId);
        if (!workspace) {
          return null;
        }

        const scopedTools = await resolveSupportedMcpToolsForPrincipal(dependencies.accountAccessService, {
          accountId: auth.accountId,
          principal: auth.principal,
          workspaceId: auth.workspaceId,
        });

        return {
          apiVersion: "0.1.0",
          clientName: "merged-backend",
          upstreamApiToken: token,
          mcpContextVersion: MCP_CONTEXT_VERSION,
          supportedTools: scopedTools,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        };
      } catch (error) {
        dependencies.logger.warn({
          error,
          errorName: error instanceof Error ? error.name : "unknown",
        }, "Merged MCP workspace token verification failed");
        return null;
      }
    };
    return createMcpExpressRuntime({
      config,
      verifyBearerToken,
    });
  })();

  app.options(dependencies.env.RADIOSO_MCP_MOUNT_PATH, (req, res) => {
    applyMergedMcpCors(req, res, dependencies.env.RADIOSO_MCP_MERGED_CORS_ORIGINS);
  });
  app.all(dependencies.env.RADIOSO_MCP_MOUNT_PATH, (req, res, next: NextFunction) => {
    if (applyMergedMcpCors(req, res, dependencies.env.RADIOSO_MCP_MERGED_CORS_ORIGINS)) {
      return;
    }

    void runtime.then((mcpRuntime) => mcpRuntime.middleware(req, res, next)).catch(next);
  });
};
