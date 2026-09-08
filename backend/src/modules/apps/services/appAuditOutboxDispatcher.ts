import { randomUUID } from "node:crypto";

import type { AppLogger } from "../../../shared/observability/logger.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import type { AppAuditOutboxRepositoryPort } from "../repositories/appAuditOutboxRepository.js";

const DELIVERY_BATCH_SIZE = 200;

/**
 * How long one dispatcher holds a batch. It has to outlast the sink calls for a full
 * batch and still be short enough that a dispatcher that died is not a delivery outage.
 */
const CLAIM_LEASE_MS = 60_000;

/** A bound on one startup drain, so a pathological backlog cannot delay listening forever. */
const MAX_DRAIN_BATCHES = 100;

interface AppAuditOutboxDispatcherDependencies {
  readonly outbox: AppAuditOutboxRepositoryPort;
  readonly audit: Pick<AuditPort, "record">;
  readonly logger: AppLogger;
  readonly clock?: () => Date;
}

/**
 * Delivers the audit intents the control plane committed alongside its state changes.
 *
 * Audit is a record of what happened, not a step of it: a sink that is down must not roll
 * back a runtime that is already running. But it must not silently lose the record either,
 * which is what a fire-and-forget write after the commit does. The intent is durable, this
 * drains it after each commit and again at start-up, and an intent that still cannot be
 * delivered stays undelivered rather than being dropped.
 *
 * Delivery is claimed, not merely selected. Every Apps mutation drains, so concurrent
 * requests reach this at the same moment routinely; an unclaimed read would hand both the
 * same rows and emit each audit event twice. The outbox row id is the delivery identity
 * and is carried on the event, so a sink that receives a retry can recognise it.
 */
export class AppAuditOutboxDispatcher {
  constructor(private readonly dependencies: AppAuditOutboxDispatcherDependencies) {}

  private now(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }

  /** One bounded batch. This is what a request-path drain runs after its commit. */
  async drain(): Promise<number> {
    const batch = await this.deliverBatch();
    return batch.delivered;
  }

  /**
   * Batches until the backlog is empty or a batch stops making progress. Start-up runs
   * this, because a restart is exactly when a backlog larger than one batch exists and
   * nothing else would come along to drain it.
   */
  async drainAll(): Promise<number> {
    let delivered = 0;
    for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch += 1) {
      const result = await this.deliverBatch();
      delivered += result.delivered;
      if (!result.progressed) return delivered;
    }
    this.dependencies.logger.warn({ delivered }, "App audit outbox still has a backlog after a bounded drain");
    return delivered;
  }

  private async deliverBatch(): Promise<{ delivered: number; progressed: boolean }> {
    const token = randomUUID();
    let delivered = 0;
    try {
      const claimed = await this.dependencies.outbox.claimUndelivered({
        limit: DELIVERY_BATCH_SIZE,
        token,
        expiresAt: new Date(this.now().getTime() + CLAIM_LEASE_MS),
        now: this.now(),
      });
      if (claimed.length === 0) return { delivered: 0, progressed: false };

      const done: string[] = [];
      const undone: string[] = [];
      for (const record of claimed) {
        if (undone.length > 0) {
          undone.push(record.id);
          continue;
        }
        try {
          await this.dependencies.audit.record({
            accountId: record.intent.accountId,
            workspaceId: record.intent.workspaceId,
            eventType: record.intent.eventType,
            eventStatus: record.intent.eventStatus,
            // The outbox row id, so a redelivery after a crash between the sink call and
            // the acknowledgement is recognisable as the same event rather than a second one.
            metadata: { ...record.intent.metadata, appAuditDeliveryId: record.id },
          });
          done.push(record.id);
          delivered += 1;
        } catch {
          // The sink is unavailable. The rest of the batch stays undelivered, its claim is
          // handed straight back so the next drain retries it, and nothing about the
          // adapter's failure is read for text.
          this.dependencies.logger.warn(
            { outboxId: record.id, eventType: record.intent.eventType },
            "App audit event could not be delivered yet",
          );
          undone.push(record.id);
        }
      }
      await this.dependencies.outbox.acknowledge(done, token, this.now());
      await this.dependencies.outbox.releaseClaim(undone, token);
      return { delivered, progressed: undone.length === 0 && claimed.length > 0 };
    } catch {
      this.dependencies.logger.warn({}, "App audit outbox could not be drained");
      return { delivered, progressed: false };
    }
  }
}
