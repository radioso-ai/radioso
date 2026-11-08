import { z } from "zod";

import { CursorPaginationError, decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";
import {
  knownAgentId,
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

/**
 * How long a notice's action waits for its alerts. The action has a fixed budget, and one that runs
 * out is retried: a stalled mail provider must not make notices that already went out go out again.
 */
const ALERT_BUDGET_MS = 10_000;

class AlertTimeout extends Error {
  constructor() {
    super("The undelivered recipient alert did not finish in time");
    this.name = "AlertTimeout";
  }
}

/**
 * Resolves when the work does, or rejects with {@link AlertTimeout} once the budget is spent, and
 * tells the work to stop recording: it is left to finish alone, so its late result must not count
 * as a second outcome for the same alert.
 */
const withinBudget = <T>(start: (signal: AbortSignal) => Promise<T>, budgetMs: number): Promise<T> => {
  const abandoned = new AbortController();
  const work = start(abandoned.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abandoned.abort();
      reject(new AlertTimeout());
    }, budgetMs);
  });
  // A late failure of the abandoned work is the alert's own business; here it must not go unhandled.
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Keeps the per-address record of every notice and warns the account's administrators when an
 * address is being skipped, unless the notice itself reached them in its place: their copy already
 * names the address and why. Both are bookkeeping around a delivery that has already been decided,
 * so neither can fail it: a failure is logged without any address and counted.
 */
export class NotificationDeliveryLog implements NotificationDeliveryRecorderPort {
  constructor(private readonly options: {
    store: Pick<NotificationDeliveryStore, "upsert">;
    alerts?: UndeliveredRecipientAlertPort;
    logger?: { warn(payload: Record<string, unknown>, message: string): void };
    metrics?: LogMetrics | null;
    /** How long to wait for each alert; defaults to ten seconds. */
    alertBudgetMs?: number;
  }) {}

  async record(subject: NotificationDeliverySubject, deliveries: readonly RecipientDelivery[]): Promise<void> {
    const { conversationId } = subject;
    if (!conversationId || deliveries.length === 0) return;
    const agentId = knownAgentId(subject.agentId);
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
    const administratorsSent = this.reportAdministratorFallback(subject, deliveries);
    if (administratorsSent > 0) return;
    await this.warnAdministrators(subject, agentId, deliveries);
  }

  /** Counts and logs a notice sent to administrators in place of its configured addresses; says how many it reached. */
  private reportAdministratorFallback(subject: NotificationDeliverySubject, deliveries: readonly RecipientDelivery[]): number {
    const administrators = deliveries.filter((delivery) => delivery.via === "administrator_fallback");
    if (administrators.length === 0) return 0;
    const sentCount = administrators.filter((delivery) => delivery.outcome === "sent").length;
    if (sentCount > 0) {
      this.options.metrics?.incrementCounter("notification_administrator_fallbacks_total", {
        help: "Notices sent to workspace administrators because recipient policy left out every configured address.",
        labels: { kind: subject.kind },
      });
    }
    this.options.logger?.warn({
      event: "notification_administrator_fallback",
      workspaceId: subject.workspaceId,
      requestId: subject.requestId,
      kind: subject.kind,
      skippedCount: deliveries.length - administrators.length,
      administratorCount: administrators.length,
      sentCount,
    }, "Notice sent to workspace administrators in place of its configured addresses");
    return sentCount;
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
        await withinBudget(
          (signal) => alerts.notify({ workspaceId: subject.workspaceId, agentId, email, reason }, { signal }),
          this.options.alertBudgetMs ?? ALERT_BUDGET_MS,
        );
      } catch (error) {
        this.options.metrics?.incrementCounter("notification_undelivered_alerts_total", {
          help: "Alerts to workspace administrators about an address that notices skip.",
          labels: { outcome: "failed", reason },
        });
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
