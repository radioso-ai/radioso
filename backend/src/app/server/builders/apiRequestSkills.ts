import { ApiConnectionRepository } from "../../../db/repositories/apiConnectionRepository.js";
import {
  API_REQUEST_SKILLS_ADAPTER,
  ApiConnectionService,
  ApiRequestSkillExecutor,
  type ApiRequestSender,
  type ApiRequestSkillSource,
} from "../../../modules/apiRequestSkills/public.js";
import type { AuditPort } from "../../../modules/audit/contracts/index.js";
import type { SkillExecutorRegistry } from "../../../modules/skills/public.js";
import type { SkillTargetUseReader } from "../../../shared/domain/skillTargetUses.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { sendPublicHttpRequest } from "../../../shared/infra/http/publicHttpRequest.js";
import { assertPublicHttpTarget } from "../../../shared/infra/http/publicUrlFetch.js";
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

/**
 * Workspace API connections, sending through the public egress policy. A base URL is checked with
 * the shared public-network guard, whose refusal tells a private host from one that does not resolve.
 */
export const buildApiConnectionService = (input: {
  db: Db;
  env: ApiRequestEnv;
  auditService: Pick<AuditPort, "record">;
  skillTargetUses: SkillTargetUseReader;
}): ApiConnectionService => {
  const allowHttpLoopback = allowsHttpLoopback(input.env);
  const send: ApiRequestSender = (request, limits) => sendPublicHttpRequest(request, limits, { allowHttpLoopback });
  return new ApiConnectionService({
    repository: new ApiConnectionRepository(input.db),
    auditService: input.auditService,
    encryption: { key: connectorEncryptionKeys(input.env) },
    assertPublicUrl: (url) => assertPublicHttpTarget(url),
    allowHttpLoopback,
    send,
    skillTargetUses: input.skillTargetUses,
  });
};

/**
 * Registers the API request skill executor unless an edition registered its own. `skills` reads the
 * skill row for the conversation an invocation runs for (`buildConversationScopedSkillLookups`);
 * the connection it targets is read live from `apiConnections`.
 */
export const registerApiRequestSkillExecutor = (
  registry: SkillExecutorRegistry,
  skills: ApiRequestSkillSource,
  input: {
    apiConnections: ApiConnectionService;
    env: ApiRequestEnv;
    metricsRegistry?: Pick<MetricsRegistry, "incrementCounter"> | null;
    logger: AppLogger;
  },
): void => {
  if (registry.resolve({ kind: "internal", adapter: API_REQUEST_SKILLS_ADAPTER })) return;
  const allowHttpLoopback = allowsHttpLoopback(input.env);
  registry.register({
    kind: "internal",
    adapter: API_REQUEST_SKILLS_ADAPTER,
    executor: new ApiRequestSkillExecutor({
      skills,
      connections: input.apiConnections,
      send: (request, limits) => sendPublicHttpRequest(request, limits, { allowHttpLoopback }),
      metricsRegistry: input.metricsRegistry ?? null,
      logger: input.logger,
    }),
  });
};
