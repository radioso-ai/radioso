import type { AppLogger } from "../../../shared/observability/logger.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import type { AppAuditOutboxRepositoryPort } from "../repositories/appAuditOutboxRepository.js";

const DELIVERY_BATCH_SIZE = 200;

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
 */
export class AppAuditOutboxDispatcher {
  constructor(private readonly dependencies: AppAuditOutboxDispatcherDependencies) {}

  async drain(): Promise<number> {
    let delivered = 0;
    try {
      const pending = await this.dependencies.outbox.listUndelivered(DELIVERY_BATCH_SIZE);
      const done: string[] = [];
      for (const record of pending) {
        try {
          await this.dependencies.audit.record({
            accountId: record.intent.accountId,
            workspaceId: record.intent.workspaceId,
            eventType: record.intent.eventType,
            eventStatus: record.intent.eventStatus,
            metadata: record.intent.metadata,
          });
          done.push(record.id);
          delivered += 1;
        } catch {
          // The sink is unavailable. The row stays undelivered and the next drain retries
          // it; nothing about the adapter's failure is read for text.
          this.dependencies.logger.warn(
            { outboxId: record.id, eventType: record.intent.eventType },
            "App audit event could not be delivered yet",
          );
          break;
        }
      }
      await this.dependencies.outbox.markDelivered(done, this.dependencies.clock?.() ?? new Date());
    } catch {
      this.dependencies.logger.warn({}, "App audit outbox could not be drained");
    }
    return delivered;
  }
}
