#!/usr/bin/env node

import { createAuditLogger, createConsoleAuditSink, createJsonlFileAuditSink } from "../audit/auditLogger.js";
import { createAuthService } from "../auth/authService.js";
import { loadRemoteConfig } from "../config.js";
import { createCapabilityPolicyRegistry } from "../policy/capabilityPolicy.js";
import { createWorkspacePolicyResolver, loadWorkspacePolicyOverrides } from "../policy/workspacePolicy.js";
import { createHttpServer } from "../http/createHttpServer.js";
import { validateWorkspaceTokenWithFallback } from "../http/validateWorkspaceToken.js";
import { createRuntimeStoreHandle } from "../state/runtimeStores.js";

const main = async () => {
  const config = loadRemoteConfig(process.env);
  const auditLogger = createAuditLogger(
    [
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
    loadWorkspacePolicyOverrides(config.workspacePoliciesPath),
  );
  const runtimeStores = await createRuntimeStoreHandle(config);
  const authService = createAuthService({
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    approvalStore: runtimeStores.approvalStore,
    approvalTtlSeconds: config.approvalTtlSeconds,
    auditLogger,
    policy,
    resolvePolicy: (workspaceId) => workspacePolicyResolver.resolve(workspaceId),
    sessionStore: runtimeStores.sessionStore,
    signingSecret: config.signingSecret,
    validateWorkspaceToken: (radiosoApiToken) => validateWorkspaceTokenWithFallback(config, radiosoApiToken),
  });
  const server = createHttpServer({
    authService,
    auditLogger,
    config,
  });

  await server.listen();
  console.info(
    `Radioso MCP HTTP server listening on http://${config.bindHost}:${config.bindPort} (${runtimeStores.mode} runtime store)`,
  );

  const closeStores = async () => {
    await runtimeStores.close();
  };
  process.once("SIGINT", () => {
    void closeStores().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void closeStores().finally(() => process.exit(0));
  });
};

main().catch((error) => {
  console.error("Failed to start Radioso MCP HTTP server.");
  console.error(error);
  process.exit(1);
});
