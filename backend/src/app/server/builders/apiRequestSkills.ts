import { ApiConnectionRepository } from "../../../db/repositories/apiConnectionRepository.js";
import type { AgentSkillRepositoryPort } from "../../../modules/agentSkills/public.js";
import {
  API_REQUEST_SKILLS_ADAPTER,
  ApiConnectionService,
  ApiRequestSkillExecutor,
  type ApiRequestSender,
} from "../../../modules/apiRequestSkills/public.js";
import type { AuditPort } from "../../../modules/audit/contracts/index.js";
import type { SkillExecutorRegistry } from "../../../modules/skills/public.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { sendPublicHttpRequest } from "../../../shared/infra/http/publicHttpRequest.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { connectorEncryptionKeys, type Env } from "../../config/env.js";

type ApiRequestEnv = Pick<
  Env,
  "CONNECTOR_ENCRYPTION_KEY" | "CONNECTOR_ENCRYPTION_PREVIOUS_KEYS" | "NODE_ENV" | "WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK"
>;

/**
 * Plain http to this machine follows the webhook destinations' rule: allowed outside production
 * where WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK is set (local development, e2e), never in production.
 */
const allowsHttpLoopback = (env: ApiRequestEnv): boolean =>
  env.NODE_ENV !== "production" && env.WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK === true;

/** Workspace API connections, sending through the public egress policy. */
export const buildApiConnectionService = (input: {
  db: Db;
  env: ApiRequestEnv;
  auditService: Pick<AuditPort, "record">;
  assertPublicUrl: (url: string) => Promise<void>;
}): ApiConnectionService => {
  const allowHttpLoopback = allowsHttpLoopback(input.env);
  const send: ApiRequestSender = (request, limits) => sendPublicHttpRequest(request, limits, { allowHttpLoopback });
  return new ApiConnectionService({
    repository: new ApiConnectionRepository(input.db),
    auditService: input.auditService,
    encryption: { key: connectorEncryptionKeys(input.env) },
    assertPublicUrl: input.assertPublicUrl,
    allowHttpLoopback,
    send,
  });
};

/** Registers the API request skill executor unless an edition registered its own. */
export const registerApiRequestSkillExecutor = (input: {
  registry: SkillExecutorRegistry;
  connections: ApiConnectionService;
  agentSkills: Pick<AgentSkillRepositoryPort, "findByName">;
  env: ApiRequestEnv;
  metricsRegistry?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger: AppLogger;
}): void => {
  if (input.registry.resolve({ kind: "internal", adapter: API_REQUEST_SKILLS_ADAPTER })) return;
  const allowHttpLoopback = allowsHttpLoopback(input.env);
  input.registry.register({
    kind: "internal",
    adapter: API_REQUEST_SKILLS_ADAPTER,
    executor: new ApiRequestSkillExecutor({
      skills: input.agentSkills,
      connections: input.connections,
      send: (request, limits) => sendPublicHttpRequest(request, limits, { allowHttpLoopback }),
      metricsRegistry: input.metricsRegistry ?? null,
      logger: input.logger,
    }),
  });
};
