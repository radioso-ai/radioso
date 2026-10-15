import { randomUUID } from "node:crypto";

import {
  CrossInstanceConversationTurnRegistry,
  LoggingConversationTurnInterruptionObserver,
  PostgresConversationTurnLeaseStore,
  PostgresConversationTurnNotices,
  type ConversationTurnRegistry,
} from "../../modules/chat/composition.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { NotificationHandlers } from "../../shared/infra/postgresNotificationListener.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

interface ConversationTurnCoordination {
  registry: ConversationTurnRegistry;
  /** Stops renewing this process's turn leases and listening for other processes' turns. */
  shutdown(): Promise<void>;
}

/**
 * Default turn coordination: conversation turns ordered and leased in Postgres, with the process's
 * shared `LISTEN` connection as the wake, so supersession holds whichever instance runs each turn.
 * The listener belongs to the caller, which closes it after this shuts down.
 */
export const createConversationTurnCoordination = (input: {
  db: Db;
  listener: { subscribe(channel: string, handlers: NotificationHandlers): () => void };
  logger: AppLogger;
  metricsRegistry?: MetricsRegistry | null;
}): ConversationTurnCoordination => {
  const registry = new CrossInstanceConversationTurnRegistry({
    instanceId: randomUUID(),
    leases: new PostgresConversationTurnLeaseStore(input.db),
    notices: new PostgresConversationTurnNotices(input.listener, input.logger),
    observer: new LoggingConversationTurnInterruptionObserver(input.logger, input.metricsRegistry),
    logger: input.logger,
  });
  return {
    registry,
    async shutdown() {
      registry.close();
    },
  };
};
