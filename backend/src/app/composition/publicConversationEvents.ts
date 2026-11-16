import { randomUUID } from "node:crypto";

import {
  CrossInstancePublicConversationEventBus,
  PostgresPublicConversationEventRelay,
  type PublicConversationEventBus,
} from "../../modules/chat/composition.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { PostgresNotificationListener } from "../../shared/infra/postgresNotificationListener.js";
import type { AppLogger } from "../../shared/observability/logger.js";

/**
 * Default public conversation event bus: events fan out to this process's subscribers at once and
 * reach the other instances through Postgres `NOTIFY`, heard on the process's shared notification
 * listener. A visitor's event stream therefore hears an operator's reply whichever instance stored
 * it, and a parked converse caller wakes on it.
 */
export const createPublicConversationEventBus = (input: {
  db: Db;
  notifications: Pick<PostgresNotificationListener, "subscribe">;
  logger: Pick<AppLogger, "info" | "warn">;
}): PublicConversationEventBus =>
  new CrossInstancePublicConversationEventBus({
    instanceId: randomUUID(),
    relay: new PostgresPublicConversationEventRelay(input.db, input.notifications, input.logger),
    logger: input.logger,
  });
