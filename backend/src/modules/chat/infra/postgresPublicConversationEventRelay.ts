import { sql } from "kysely";
import { z } from "zod";

import type { NotificationHandlers } from "../../../shared/infra/postgresNotificationListener.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type {
  PublicConversationEventRelay,
  RelayedPublicConversationEvent,
} from "../services/crossInstancePublicConversationEventBus.js";

/**
 * The channel every process listens on while it has subscribers. A payload carries the event's
 * ids and timestamp and the publishing process's id: a few hundred bytes, well inside NOTIFY's
 * 8000-byte limit, and never message content.
 */
const PUBLIC_CONVERSATION_EVENT_CHANNEL = "radioso_public_conversation_events";

const id = z.string().min(1).max(128);

const payloadSchema = z.object({
  origin: id,
  type: z.literal("message.created"),
  conversationId: id,
  workspaceId: id,
  messageId: id,
  createdAt: z.string().min(1).max(64),
});

const parsePayload = (payload: string): RelayedPublicConversationEvent | null => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) {
    return null;
  }
  const { origin, ...event } = parsed.data;
  return { origin, event };
};

/**
 * Relays public conversation events through Postgres: `pg_notify` on the pool to send, and the
 * process's shared LISTEN session to hear.
 */
export class PostgresPublicConversationEventRelay implements PublicConversationEventRelay {
  constructor(
    private readonly db: Db,
    private readonly listener: { subscribe(channel: string, handlers: NotificationHandlers): () => void },
    private readonly logger?: Pick<AppLogger, "warn">,
  ) {}

  async send({ origin, event }: RelayedPublicConversationEvent): Promise<void> {
    const payload = JSON.stringify({
      origin,
      type: event.type,
      conversationId: event.conversationId,
      workspaceId: event.workspaceId,
      messageId: event.messageId,
      createdAt: event.createdAt,
    });
    await sql`SELECT pg_notify(${PUBLIC_CONVERSATION_EVENT_CHANNEL}, ${payload})`.execute(this.db);
  }

  subscribe(handlers: Parameters<PublicConversationEventRelay["subscribe"]>[0]): () => void {
    return this.listener.subscribe(PUBLIC_CONVERSATION_EVENT_CHANNEL, {
      notification: (payload) => {
        const relayed = parsePayload(payload);
        if (relayed) {
          handlers.event(relayed);
        } else {
          this.logger?.warn(
            { event: "public_conversation_event_unreadable" },
            "Public conversation event notification could not be read",
          );
        }
      },
      listening: () => handlers.listening(),
      interrupted: () => handlers.interrupted(),
    });
  }
}
