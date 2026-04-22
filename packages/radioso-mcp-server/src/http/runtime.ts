import {
  createAuditLogger,
  createConsoleAuditSink,
  createJsonlFileAuditSink,
  type AuditLogger,
  type AuditSink,
} from "../audit/auditLogger.js";
import { createAuthService } from "../auth/authService.js";
import type { RadiosoMcpConfig } from "../config.js";
import { createCapabilityPolicyRegistry } from "../policy/capabilityPolicy.js";
import { createWorkspacePolicyResolver, loadWorkspacePolicyOverrides } from "../policy/workspacePolicy.js";
import { createRuntimeStoreHandle, type RuntimeStoreHandle } from "../state/runtimeStores.js";

import { createHttpServer, type RadiosoRemoteHttpServer } from "./createHttpServer.js";
import { validateWorkspaceTokenWithFallback } from "./validateWorkspaceToken.js";

export interface CreateRemoteHttpRuntimeOptions {
  auditLogger?: AuditLogger;
  auditSinks?: AuditSink[];
  config: RadiosoMcpConfig;
  runtimeStores?: RuntimeStoreHandle;
  workspacePolicyOverrides?: Record<
    string,
    {
      allowedReadTools?: string[];
      allowedWriteTools?: string[];
      approvalRequiredWriteTools?: string[];
    }
  >;
}

export interface RemoteHttpRuntime {
  auditLogger: AuditLogger;
  close(): Promise<void>;
  listen(): Promise<void>;
  mode: RuntimeStoreHandle["mode"];
  server: RadiosoRemoteHttpServer;
}

export const createRemoteHttpRuntime = async ({
  auditLogger,
  auditSinks,
  config,
  runtimeStores,
  workspacePolicyOverrides,
}: CreateRemoteHttpRuntimeOptions): Promise<RemoteHttpRuntime> => {
  const resolvedAuditLogger =
    auditLogger ??
    createAuditLogger(
      auditSinks ?? [
        createConsoleAuditSink(),
        ...(config.auditLogPath ? [createJsonlFileAuditSink(config.auditLogPath)] : []),
      ],
    );

  const basePolicyConfig = {
    allowedReadTools: config.allowedReadTools,
    allowedWriteTools: config.allowedWriteTools,
    approvalRequiredWriteTools: config.approvalRequiredWriteTools,
  };
  const policy = createCapabilityPolicyRegistry(basePolicyConfig);
  const workspacePolicyResolver = createWorkspacePolicyResolver(
    basePolicyConfig,
    workspacePolicyOverrides ?? loadWorkspacePolicyOverrides(config.workspacePoliciesPath),
  );
  const resolvedRuntimeStores = runtimeStores ?? await createRuntimeStoreHandle(config);
  const authService = createAuthService({
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    approvalStore: resolvedRuntimeStores.approvalStore,
    approvalTtlSeconds: config.approvalTtlSeconds,
    auditLogger: resolvedAuditLogger,
    policy,
    resolvePolicy: (workspaceId) => workspacePolicyResolver.resolve(workspaceId),
    sessionStore: resolvedRuntimeStores.sessionStore,
    signingSecret: config.signingSecret,
    validateWorkspaceToken: (radiosoApiToken) => validateWorkspaceTokenWithFallback(config, radiosoApiToken),
  });
  const server = createHttpServer({
    authService,
    auditLogger: resolvedAuditLogger,
    config,
  });

  return {
    auditLogger: resolvedAuditLogger,
    async close() {
      await server.close();
      await resolvedRuntimeStores.close();
    },
    async listen() {
      await server.listen();
    },
    mode: resolvedRuntimeStores.mode,
    server,
  };
};
