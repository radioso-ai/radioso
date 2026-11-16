import { randomUUID } from "node:crypto";

import {
  CrossInstanceConversationTurnRegistry,
  LoggingConversationTurnInterruptionObserver,
  PostgresConversationTurnLeaseStore,
  PostgresConversationTurnNotices,
  type ConversationTurnRegistry,
} from "../../modules/chat/composition.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { PostgresNotificationListener } from "../../shared/infra/postgresNotificationListener.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

interface ConversationTurnCoordination {
  registry: ConversationTurnRegistry;
  /** Stops renewing this process's turn leases and stops listening for other processes' turns. */
  shutdown(): Promise<void>;
}

/**
 * Default turn coordination: conversation turns ordered and leased in Postgres, woken through the
 * process's shared notification listener, so supersession holds whichever instance runs each turn.
 * The listener belongs to the process (`buildInfrastructure`) and closes with it.
 */
export const createConversationTurnCoordination = (input: {
  db: Db;
  notifications: Pick<PostgresNotificationListener, "subscribe">;
  logger: AppLogger;
  metricsRegistry?: MetricsRegistry | null;
}): ConversationTurnCoordination => {
  const registry = new CrossInstanceConversationTurnRegistry({
    instanceId: randomUUID(),
    leases: new PostgresConversationTurnLeaseStore(input.db),
    notices: new PostgresConversationTurnNotices(input.notifications, input.logger),
    observer: new LoggingConversationTurnInterruptionObserver(input.logger, input.metricsRegistry),
    logger: input.logger,
  });
  return {
    registry,
    shutdown() {
      registry.close();
      return Promise.resolve();
    },
  };
};
