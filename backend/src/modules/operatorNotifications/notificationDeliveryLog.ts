import { z } from "zod";

import { CursorPaginationError, decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";
import {
  RECIPIENT_DELIVERY_OUTCOMES,
  type NotificationDeliveryRecorderPort,
  type NotificationDeliverySubject,
  type NotificationKind,
  type RecipientDelivery,
  type RecipientDeliveryOutcome,
} from "./notificationDelivery.js";
import type { UndeliveredRecipientAlertPort, UndeliveredRecipientReason } from "./undeliveredRecipientAlert.js";

export interface NotificationDeliveryRecord {
  id: string;
  agentId: string | null;
  conversationId: string;
  kind: NotificationKind;
  /** The normalized address the notice was meant for. */
  recipientEmail: string;
  outcome: RecipientDeliveryOutcome;
  /** When the notice was first handled. */
  createdAt: Date;
  /** When its latest attempt settled: later than `createdAt` once a retry succeeded. */
  updatedAt: Date;
}

export interface NotificationDeliveryPosition {
  createdAt: Date;
  id: string;
}

export interface NotificationDeliveryStore {
  /**
   * One row per request and address. A later attempt replaces an earlier outcome, except that a
   * `sent` row stays sent: a retry that finds the address lapsed does not unsay a mail that went.
   */
  upsert(
    subject: NotificationDeliverySubject & { conversationId: string },
    deliveries: readonly RecipientDelivery[],
  ): Promise<void>;
  list(workspaceId: string, query: {
    agentId?: string;
    outcome?: RecipientDeliveryOutcome;
    after: NotificationDeliveryPosition | null;
    limit: number;
  }): Promise<NotificationDeliveryRecord[]>;
}

interface LogMetrics {
  incrementCounter(name: string, options: { help: string; labels?: Record<string, string>; value?: number }): void;
}

// The outcomes an operator can act on: an address that is unconfirmed, stopped, or bounced.
const ALERTING_OUTCOMES: Partial<Record<RecipientDeliveryOutcome, UndeliveredRecipientReason>> = {
  skipped_unconfirmed: "unconfirmed",
  skipped_revoked: "revoked",
  skipped_suppressed: "suppressed",
};

const agentIdSchema = z.string().uuid();

/**
 * Keeps the per-address record of every notice and warns the account's administrators when an
 * address is being skipped. Both are bookkeeping around a delivery that has already been decided,
 * so neither can fail it: a failure is logged without any address and counted.
 */
export class NotificationDeliveryLog implements NotificationDeliveryRecorderPort {
  constructor(private readonly options: {
    store: Pick<NotificationDeliveryStore, "upsert">;
    alerts?: UndeliveredRecipientAlertPort;
    logger?: { warn(payload: Record<string, unknown>, message: string): void };
    metrics?: LogMetrics | null;
  }) {}

  async record(subject: NotificationDeliverySubject, deliveries: readonly RecipientDelivery[]): Promise<void> {
    const { conversationId } = subject;
    if (!conversationId || deliveries.length === 0) return;
    // Some notices name their agent "unknown" when the conversation has none; that is no agent.
    const agentId = subject.agentId !== null && agentIdSchema.safeParse(subject.agentId).success ? subject.agentId : null;
    try {
      await this.options.store.upsert({ ...subject, agentId, conversationId }, deliveries);
      this.countOutcomes(deliveries);
    } catch (error) {
      this.options.metrics?.incrementCounter("notification_delivery_record_failures_total", {
        help: "Notification delivery records that could not be written.",
      });
      this.options.logger?.warn({
        event: "notification_delivery_record_failed",
        workspaceId: subject.workspaceId,
        requestId: subject.requestId,
        errorName: error instanceof Error ? error.name : "unknown",
      }, "Notification delivery could not be recorded");
    }
    await this.warnAdministrators(subject, agentId, deliveries);
  }

  private countOutcomes(deliveries: readonly RecipientDelivery[]): void {
    const counts = new Map<RecipientDeliveryOutcome, number>();
    for (const { outcome } of deliveries) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    for (const [outcome, value] of counts) {
      this.options.metrics?.incrementCounter("notification_deliveries_recorded_total", {
        help: "Notification deliveries recorded per recipient, by outcome.",
        labels: { outcome },
        value,
      });
    }
  }

  private async warnAdministrators(
    subject: NotificationDeliverySubject,
    agentId: string | null,
    deliveries: readonly RecipientDelivery[],
  ): Promise<void> {
    const { alerts } = this.options;
    if (!alerts) return;
    // Each address is throttled on its own, so they alert side by side rather than one after another.
    await Promise.all(deliveries.map(async ({ email, outcome }) => {
      const reason = ALERTING_OUTCOMES[outcome];
      if (!reason) return;
      try {
        await alerts.notify({ workspaceId: subject.workspaceId, agentId, email, reason });
      } catch (error) {
        this.options.logger?.warn({
          event: "notification_undelivered_alert_failed",
          workspaceId: subject.workspaceId,
          reason,
          errorName: error instanceof Error ? error.name : "unknown",
        }, "Undelivered recipient alert failed");
      }
    }));
  }
}

export const notificationDeliveryOutcomeSchema = z.enum(RECIPIENT_DELIVERY_OUTCOMES);

const CURSOR_KEYS = ["createdAt", "id"] as const;

const encodePosition = (record: NotificationDeliveryRecord): string =>
  encodeCursor({ createdAt: record.createdAt.toISOString(), id: record.id });

const decodePosition = (cursor: string): NotificationDeliveryPosition => {
  const { keys } = decodeCursorWithKeys(cursor, CURSOR_KEYS);
  const createdAt = new Date(keys.createdAt);
  if (Number.isNaN(createdAt.getTime()) || !z.string().uuid().safeParse(keys.id).success) {
    throw new CursorPaginationError("Invalid cursor");
  }
  return { createdAt, id: keys.id };
};

export interface NotificationDeliveryPage {
  items: NotificationDeliveryRecord[];
  nextCursor: string | null;
}

export interface NotificationDeliveryReaderPort {
  list(workspaceId: string, query: {
    agentId?: string;
    outcome?: RecipientDeliveryOutcome;
    cursor?: string;
    limit: number;
  }): Promise<NotificationDeliveryPage>;
}

/** A workspace's notification deliveries newest first, a page at a time. */
export class NotificationDeliveryReader implements NotificationDeliveryReaderPort {
  constructor(private readonly store: Pick<NotificationDeliveryStore, "list">) {}

  async list(workspaceId: string, query: {
    agentId?: string;
    outcome?: RecipientDeliveryOutcome;
    cursor?: string;
    limit: number;
  }): Promise<NotificationDeliveryPage> {
    const after = query.cursor === undefined ? null : decodePosition(query.cursor);
    // One past the page tells whether another follows.
    const rows = await this.store.list(workspaceId, {
      agentId: query.agentId,
      outcome: query.outcome,
      after,
      limit: query.limit + 1,
    });
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > query.limit && last ? encodePosition(last) : null };
  }
}
