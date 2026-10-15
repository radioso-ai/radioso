import { randomUUID } from "node:crypto";

import type { Env } from "../config/env.js";
import {
  CrossInstanceConversationTurnRegistry,
  LoggingConversationTurnInterruptionObserver,
  PostgresConversationTurnLeaseStore,
  PostgresConversationTurnNotices,
  type ConversationTurnRegistry,
} from "../../modules/chat/composition.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { PostgresNotificationListener } from "../../shared/infra/postgresNotificationListener.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

interface ConversationTurnCoordination {
  registry: ConversationTurnRegistry;
  /** Stops renewing this process's turn leases and closes its notification connection. */
  shutdown(): Promise<void>;
}

/**
 * Default turn coordination: conversation turns ordered and leased in Postgres, with one dedicated
 * LISTEN connection per process as the wake, so supersession holds whichever instance runs each
 * turn. The connection opens with the process's first turn and closes after it has been idle for
 * the pool's idle timeout.
 */
export const createConversationTurnCoordination = (input: {
  env: Pick<Env, "DATABASE_URL" | "NODE_ENV" | "DB_POOL_CONNECTION_TIMEOUT_MS" | "DB_POOL_IDLE_TIMEOUT_MS">;
  db: Db;
  logger: AppLogger;
  metricsRegistry?: MetricsRegistry | null;
}): ConversationTurnCoordination => {
  const listener = new PostgresNotificationListener({
    connectionString: input.env.DATABASE_URL,
    applicationName: `radioso-${input.env.NODE_ENV}-turn-listener`,
    connectionTimeoutMs: input.env.DB_POOL_CONNECTION_TIMEOUT_MS,
    idleCloseMs: input.env.DB_POOL_IDLE_TIMEOUT_MS,
    logger: input.logger,
  });
  const registry = new CrossInstanceConversationTurnRegistry({
    instanceId: randomUUID(),
    leases: new PostgresConversationTurnLeaseStore(input.db),
    notices: new PostgresConversationTurnNotices(listener, input.logger),
    observer: new LoggingConversationTurnInterruptionObserver(input.logger, input.metricsRegistry),
    logger: input.logger,
  });
  return {
    registry,
    async shutdown() {
      registry.close();
      await listener.close();
    },
  };
};
