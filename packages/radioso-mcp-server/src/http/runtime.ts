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
