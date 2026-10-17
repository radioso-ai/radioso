import type { AbuseControlRepositoryPort } from "../../modules/security/contracts/abuseControl.js";
import { FallbackAbuseControlRepository } from "../../modules/security/infrastructure/fallbackAbuseControlRepository.js";
import { RedisAbuseControlRepository } from "../../modules/security/infrastructure/redisAbuseControlRepository.js";
import { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

interface ClosableAbuseControlRepository extends AbuseControlRepositoryPort {
  close(): Promise<void>;
}

type RedisRepositoryFactory = (input: {
  redisUrl: string;
  commandTimeoutMs: number;
}) => ClosableAbuseControlRepository;

export const createAbuseControlComposition = (input: {
  env: {
    ABUSE_CONTROL_REDIS_URL?: string;
    ABUSE_CONTROL_REDIS_COMMAND_TIMEOUT_MS?: number;
  };
  logger: {
    warn(fields: Record<string, string>, message: string): void;
  };
  metricsRegistry: Pick<MetricsRegistry, "incrementCounter"> | null;
  postgresRepository: AbuseControlRepositoryPort;
  redisRepositoryFactory?: RedisRepositoryFactory;
}): {
  service: AbuseControlService;
  shutdown(): Promise<void>;
} => {
  if (!input.env.ABUSE_CONTROL_REDIS_URL) {
    return {
      service: new AbuseControlService(input.postgresRepository),
      shutdown: async () => {},
    };
  }

  const redisRepository = (input.redisRepositoryFactory ?? ((options) =>
    new RedisAbuseControlRepository(options)))({
    redisUrl: input.env.ABUSE_CONTROL_REDIS_URL,
    commandTimeoutMs: input.env.ABUSE_CONTROL_REDIS_COMMAND_TIMEOUT_MS ?? 1_000,
  });
  const repository = new FallbackAbuseControlRepository(
    redisRepository,
    input.postgresRepository,
    { logger: input.logger, metrics: input.metricsRegistry },
  );
  return {
    service: new AbuseControlService(repository),
    shutdown: () => redisRepository.close(),
  };
};
