import {
  createAuditLogger,
  createConsoleAuditSink,
  createJsonlFileAuditSink,
  type AuditLogger,
  type AuditSink,
} from "../audit/auditLogger.js";
import { createAuthService } from "../auth/authService.js";
import type { RadiosoMcpConfig } from "../config.js";
import { createConverseApiAdapter } from "../converseApiAdapter.js";
import { createCapabilityPolicyRegistry } from "../policy/capabilityPolicy.js";
import { createWorkspacePolicyResolver, loadWorkspacePolicyOverrides } from "../policy/workspacePolicy.js";
import {
  createRuntimeStoreHandle,
  type LegacySessionPurgeReadinessObserver,
  type RuntimeStoreHandle,
} from "../state/runtimeStores.js";

import { createHttpServer, type RadiosoRemoteHttpServer } from "./createHttpServer.js";
import { validateWorkspaceToken } from "./validateWorkspaceToken.js";

export interface CreateRemoteHttpRuntimeOptions {
  auditLogger?: AuditLogger;
  auditSinks?: AuditSink[];
  config: RadiosoMcpConfig;
  legacySessionPurgeReadinessObserver?: LegacySessionPurgeReadinessObserver;
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
  legacySessionPurgeReadinessObserver,
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
  const resolvedRuntimeStores = runtimeStores ?? await createRuntimeStoreHandle(config, {
    legacySessionPurgeReadinessObserver,
  });
  resolvedRuntimeStores.readiness.start();
  const authService = createAuthService({
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    auditLogger: resolvedAuditLogger,
    policy,
    resolvePolicy: (workspaceId) => workspacePolicyResolver.resolve(workspaceId),
    sessionStore: resolvedRuntimeStores.sessionStore,
    signingSecret: config.signingSecret,
    converseApi: createConverseApiAdapter({
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    validateWorkspaceToken: (radiosoApiToken) => validateWorkspaceToken(config, radiosoApiToken),
  });
  const server = createHttpServer({
    authService,
    auditLogger: resolvedAuditLogger,
    config,
    readiness: resolvedRuntimeStores.readiness,
  });

  return {
    auditLogger: resolvedAuditLogger,
    async close() {
      await server.close();
      await resolvedRuntimeStores.close();
    },
    async listen() {
      await resolvedRuntimeStores.readiness.waitUntilReady();
      await server.listen();
    },
    mode: resolvedRuntimeStores.mode,
    server,
  };
};
