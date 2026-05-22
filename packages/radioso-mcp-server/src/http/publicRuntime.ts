import {
  createAuditLogger,
  createConsoleAuditSink,
  createJsonlFileAuditSink,
  type AuditLogger,
  type AuditSink,
} from "../audit/auditLogger.js";

import { createAuthService } from "../auth/authService.js";
import type { AccessSessionRecord } from "../auth/sessionStore.js";
import { hashToken } from "../auth/token.js";
import type { RadiosoMcpConfig } from "../config.js";
import {
  DEFAULT_ALLOWED_READ_TOOLS,
  DEFAULT_ALLOWED_WRITE_TOOLS,
  DEFAULT_APPROVAL_REQUIRED_WRITE_TOOLS,
  createCapabilityPolicyRegistry,
} from "../policy/capabilityPolicy.js";
import { createWorkspacePolicyResolver, loadWorkspacePolicyOverrides } from "../policy/workspacePolicy.js";
import { createRuntimeStoreHandle, type RuntimeStoreHandle } from "../state/runtimeStores.js";

import { createExpressMcpMiddleware, type ExpressLikeMcpMiddleware } from "./expressAdapter.js";
import { createMcpRequestHandler, type McpRequestHandler } from "./requestHandler.js";
import { createSessionMcpServerManager } from "./sessionServerManager.js";

export type PublicMcpRuntimeConfig =
  Omit<
    RadiosoMcpConfig,
    "allowedReadTools" | "allowedWriteTools" | "approvalRequiredWriteTools"
  >
  & Partial<Pick<RadiosoMcpConfig, "allowedReadTools" | "allowedWriteTools" | "approvalRequiredWriteTools">>;

export interface VerifiedMcpBearerToken {
  apiVersion?: string;
  clientName?: string;
  mcpContextVersion?: string;
  supportedTools?: string[];
  upstreamApiToken: string;
  workspaceHint?: string;
  workspaceId?: string;
  workspaceName?: string;
}

export interface CreateMcpHttpRuntimeOptions {
  auditLogger?: AuditLogger;
  auditSinks?: AuditSink[];
  config: PublicMcpRuntimeConfig;
  entryPoint?: "merged" | "standalone";
  runtimeStores?: RuntimeStoreHandle;
  verifyBearerToken: (accessToken: string) => Promise<VerifiedMcpBearerToken | null>;
  workspacePolicyOverrides?: Record<
    string,
    {
      allowedReadTools?: string[];
      allowedWriteTools?: string[];
      approvalRequiredWriteTools?: string[];
    }
  >;
}

export interface McpHttpRuntime {
  close(): Promise<void>;
  handler: McpRequestHandler;
  mode: RuntimeStoreHandle["mode"];
}

export interface McpExpressRuntime extends McpHttpRuntime {
  middleware: ExpressLikeMcpMiddleware;
}

const normalizeConfig = (config: PublicMcpRuntimeConfig): RadiosoMcpConfig => ({
  ...config,
  allowedReadTools: config.allowedReadTools ?? DEFAULT_ALLOWED_READ_TOOLS,
  allowedWriteTools: config.allowedWriteTools ?? DEFAULT_ALLOWED_WRITE_TOOLS,
  approvalRequiredWriteTools: config.approvalRequiredWriteTools ?? DEFAULT_APPROVAL_REQUIRED_WRITE_TOOLS,
});

export const createMcpHttpRuntime = async ({
  auditLogger,
  auditSinks,
  config,
  entryPoint = "merged",
  runtimeStores,
  verifyBearerToken,
  workspacePolicyOverrides,
}: CreateMcpHttpRuntimeOptions): Promise<McpHttpRuntime> => {
  const normalizedConfig = normalizeConfig(config);
  const resolvedAuditLogger =
    auditLogger ??
    createAuditLogger(
      auditSinks ?? [
        createConsoleAuditSink(),
        ...(normalizedConfig.auditLogPath ? [createJsonlFileAuditSink(normalizedConfig.auditLogPath)] : []),
      ],
    );
  const basePolicyConfig = {
    allowedReadTools: normalizedConfig.allowedReadTools,
    allowedWriteTools: normalizedConfig.allowedWriteTools,
    approvalRequiredWriteTools: normalizedConfig.approvalRequiredWriteTools,
  };
  const policy = createCapabilityPolicyRegistry(basePolicyConfig);
  const workspacePolicyResolver = createWorkspacePolicyResolver(
    basePolicyConfig,
    workspacePolicyOverrides ?? loadWorkspacePolicyOverrides(normalizedConfig.workspacePoliciesPath),
  );
  const stores = runtimeStores ?? await createRuntimeStoreHandle(normalizedConfig);
  const authService = createAuthService({
    accessTokenTtlSeconds: normalizedConfig.accessTokenTtlSeconds,
    auditLogger: resolvedAuditLogger,
    policy,
    resolvePolicy: (workspaceId) => workspacePolicyResolver.resolve(workspaceId),
    sessionStore: stores.sessionStore,
    signingSecret: normalizedConfig.signingSecret,
    validateWorkspaceToken: async () => ({}),
  });
  const serverManager = createSessionMcpServerManager({
    auditLogger: resolvedAuditLogger,
    config: normalizedConfig,
    entryPoint,
  });
  const toSession = async (accessToken: string): Promise<AccessSessionRecord | null> => {
    const verification = await verifyBearerToken(accessToken);
    if (!verification) {
      return null;
    }

    const policyResolution = workspacePolicyResolver.resolve(verification.workspaceId);
    const resolution = policyResolution.policy.resolveRequestedTools(policyResolution.policy.configuredTools());
    const supportedTools = verification.supportedTools ? [...new Set(verification.supportedTools)] : undefined;
    const grantedTools = supportedTools
      ? resolution.grantedTools.filter((toolName) => supportedTools.includes(toolName))
      : resolution.grantedTools;
    const issuedAt = new Date();

    return stores.sessionStore.save({
      accessToken,
      approvalRequiredTools: resolution.approvalRequiredTools.filter((toolName) => grantedTools.includes(toolName)),
      clientName: verification.clientName,
      expiresAt: new Date(issuedAt.getTime() + normalizedConfig.accessTokenTtlSeconds * 1000),
      grantedTools,
      issuedAt,
      sessionId: `direct_${hashToken(accessToken).slice(0, 32)}`,
      upstreamApiVersion: verification.apiVersion,
      upstreamMcpContextVersion: verification.mcpContextVersion,
      upstreamSupportedTools: supportedTools,
      upstreamApiToken: verification.upstreamApiToken,
      workspaceId: verification.workspaceId,
      workspaceHint: verification.workspaceHint,
      workspaceName: verification.workspaceName,
    });
  };
  const handler = createMcpRequestHandler({
    config: normalizedConfig,
    serverManager,
    verifyBearerToken: toSession,
  });

  return {
    async close() {
      if (!runtimeStores) {
        await stores.close();
      }
    },
    handler,
    mode: stores.mode,
  };
};

export const createMcpExpressRuntime = async (
  options: CreateMcpHttpRuntimeOptions,
): Promise<McpExpressRuntime> => {
  const runtime = await createMcpHttpRuntime(options);
  const config = normalizeConfig(options.config);

  return {
    ...runtime,
    middleware: createExpressMcpMiddleware(runtime.handler, {
      fallbackHost: `${config.bindHost}:${config.bindPort}`,
    }),
  };
};
