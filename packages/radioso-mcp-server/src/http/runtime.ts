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
import {
  createRuntimeStoreHandle,
  type LegacySessionPurgeReadinessObserver,
  type RuntimeStoreHandle,
} from "../state/runtimeStores.js";

import { createHttpServer, type RadiosoRemoteHttpServer } from "./createHttpServer.js";
import { createFixedWindowPreAuthSourceBudget } from "./preAuthSourceBudget.js";
import { createOperatorBackendAdapter } from "../operator/backendAdapter.js";
import { createOperatorMcpReadiness } from "../operator/runtimeReadiness.js";
import { createOperatorMcpFloodLimiter, createOperatorMcpMetrics } from "../operator/observability.js";

export interface CreateRemoteHttpRuntimeOptions {
  auditLogger?: AuditLogger;
  auditSinks?: AuditSink[];
  config: RadiosoMcpConfig;
  legacySessionPurgeReadinessObserver?: LegacySessionPurgeReadinessObserver;
  runtimeStores?: RuntimeStoreHandle;
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
}: CreateRemoteHttpRuntimeOptions): Promise<RemoteHttpRuntime> => {
  const resolvedAuditLogger =
    auditLogger ??
    createAuditLogger(
      auditSinks ?? [
        createConsoleAuditSink(),
        ...(config.auditLogPath ? [createJsonlFileAuditSink(config.auditLogPath)] : []),
      ],
    );

  const resolvedRuntimeStores = runtimeStores ?? await createRuntimeStoreHandle(config, {
    legacySessionPurgeReadinessObserver,
  });
  resolvedRuntimeStores.readiness.start();
  const authService = createAuthService({
    sessionStore: resolvedRuntimeStores.sessionStore,
    converseApi: createConverseApiAdapter({
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      signingSecret: config.signingSecret,
    }),
  });
  const operatorFloodLimiter = config.operatorMcp?.enabled ? createOperatorMcpFloodLimiter() : undefined;
  const server = createHttpServer({
    authService,
    auditLogger: resolvedAuditLogger,
    config,
    operatorMcp: config.operatorMcp?.enabled ? {
      adapter: createOperatorBackendAdapter({
        baseUrl: config.baseUrl,
        internalSecret: config.operatorMcp.internalSecret,
        requestTimeoutMs: config.requestTimeoutMs,
      }),
      auditLogger: resolvedAuditLogger,
      metrics: createOperatorMcpMetrics(),
      principalRateLimit: operatorFloodLimiter?.principal,
      rateLimit: operatorFloodLimiter?.source ?? createFixedWindowPreAuthSourceBudget({ maxAttempts: 120, windowMs: 60_000 }),
      readiness: createOperatorMcpReadiness(true),
      resource: {
        authorizationServerUrl: config.operatorMcp.issuerUrl,
        metadataUrl: `${new URL(config.operatorMcp.resourceUrl).origin}/.well-known/oauth-protected-resource/operator/mcp`,
        resource: config.operatorMcp.resourceUrl,
      },
    } : undefined,
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
