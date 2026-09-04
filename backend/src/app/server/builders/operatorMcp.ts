import { createHash } from "node:crypto";

import { OperatorMcpAuthorizationRepository } from "../../../db/repositories/operatorMcpAuthorizationRepository.js";
import type { AccountAccessService } from "../../../modules/account/services/accountAccessService.js";
import {
  OperatorMcpAuthorizationService,
  OperatorMcpCredentialValidationService,
  OperatorMcpGrantService,
  createOperatorMcpClientMetadataService,
} from "../../../modules/operatorMcpAuthorization/public.js";
import type { Database } from "../../../shared/infra/database.js";
import type { Env } from "../../config/env.js";
import { OperatorMcpInvocationRepository } from "../../../db/repositories/operatorMcpInvocationRepository.js";
import { OperatorMcpApplicationService, OperatorMcpCatalogService, type CopilotToolDescriptor } from "../../../modules/operatorCopilot/public.js";
import type { AuditPort } from "../../../modules/audit/contracts/index.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

export const buildOperatorMcpServices = (input: {
  env: Env;
  database: Database;
  accountAccessService: AccountAccessService;
  auditService: AuditPort;
  logger: AppLogger;
  metricsRegistry: MetricsRegistry | null;
  copilotToolCatalog: readonly CopilotToolDescriptor[];
}) => {
  const repository = new OperatorMcpAuthorizationRepository(input.database.kysely);
  const metadata = createOperatorMcpClientMetadataService();
  const operatorMcpClientResolver = {
    resolve: async (clientId: string, redirectUri: string) => repository.persistClientSnapshot(
      await metadata.resolve({ clientId, redirectUri }),
    ),
  };
  const resource = input.env.OPERATOR_MCP_RESOURCE_URL;
  const issuer = input.env.OPERATOR_MCP_ISSUER_URL;
  const secret = input.env.OPERATOR_MCP_INTERNAL_SECRET;
  const credentialEpoch = input.env.OPERATOR_MCP_CREDENTIAL_EPOCH;
  if (!input.env.OPERATOR_MCP_ENABLED || !resource || !issuer || !secret || !credentialEpoch) {
    return {
      operatorMcpAuthorizationService: undefined,
      operatorMcpCredentialValidationService: undefined,
      operatorMcpGrantService: new OperatorMcpGrantService(repository, input.accountAccessService),
      operatorMcpReadiness: Promise.resolve(false),
      operatorMcpClientResolver,
      operatorMcpApplicationService: undefined,
    };
  }
  const operatorMcpReadiness = repository.ensureDeploymentCredentialState({
    resource,
    credentialEpoch,
    keyFingerprint: createHash("sha256").update(secret).digest("hex"),
    now: new Date(),
  }).then(() => true).catch((error: unknown) => {
    input.logger.error({ error }, "operator_mcp_credential_state_not_ready");
    return false;
  });
  const credentialValidation = new OperatorMcpCredentialValidationService(repository, { resource, credentialEpoch });
  const operatorMcpApplicationService = new OperatorMcpApplicationService({
    credentialValidation,
    invocations: new OperatorMcpInvocationRepository(input.database.kysely),
    catalog: new OperatorMcpCatalogService(input.copilotToolCatalog),
    currentAuthorization: {
      hasAllPermissions: ({ workspaceId, accountId, operatorUserId, requiredPermissions }) =>
        input.accountAccessService.hasAllWorkspacePermissions({
          workspaceId, accountId, userId: operatorUserId, principal: { type: "session_user", userId: operatorUserId },
          permissions: requiredPermissions,
        }),
    },
    audit: input.auditService,
    secret,
  });
  return {
    operatorMcpAuthorizationService: new OperatorMcpAuthorizationService(repository, {
      resource,
      issuer,
      credentialEpoch,
      authorizationCodeTtlSeconds: input.env.OPERATOR_MCP_AUTHORIZATION_CODE_TTL_SECONDS ?? 300,
      accessTokenTtlSeconds: input.env.OPERATOR_MCP_ACCESS_TOKEN_TTL_SECONDS ?? 900,
      refreshIdleTtlDays: input.env.OPERATOR_MCP_REFRESH_IDLE_TTL_DAYS ?? 30,
      refreshAbsoluteTtlDays: input.env.OPERATOR_MCP_REFRESH_ABSOLUTE_TTL_DAYS ?? 90,
    }, input.auditService, input.metricsRegistry ?? undefined),
    operatorMcpCredentialValidationService: credentialValidation,
    operatorMcpGrantService: new OperatorMcpGrantService(repository, input.accountAccessService),
    operatorMcpReadiness,
    operatorMcpClientResolver,
    operatorMcpApplicationService,
  };
};
