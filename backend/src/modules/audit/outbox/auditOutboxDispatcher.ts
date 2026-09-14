import type { AuditPort } from "../contracts/index.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type {
  AuditOutboxDispatcher,
  AuditOutboxDrainResult,
  AuditOutboxRepositoryPort,
  ClaimedAuditOutboxEntry,
} from "./ports.js";

const DEFAULT_BATCH_SIZE = 200;

/**
 * How long a claimed batch stays this dispatcher's. It has to outlast a slow
 * publisher and expire soon enough that a dispatcher that died does not hold the
 * trail back for long.
 */
const DEFAULT_LEASE_SECONDS = 60;

interface AuditOutboxDispatcherOptions {
  repository: AuditOutboxRepositoryPort;
  /** Where a claimed intent is actually published — the audit spine itself. */
  auditPort: AuditPort;
  /** A publish failure is said out loud here, in identifiers only. */
  logger: Pick<AppLogger, "warn">;
  leaseSeconds?: number;
}

const toAuditEvent = (entry: ClaimedAuditOutboxEntry) => ({
  eventId: entry.eventId,
  accountId: entry.accountId,
  workspaceId: entry.workspaceId,
  eventType: entry.eventType,
  eventStatus: entry.eventStatus,
  // The event id travels in metadata too: it is what an operator reading the
  // trail recognises one event by, next to whatever the caller's own metadata
  // says. A deleted workspace arrives as a null `workspaceId` and its former
  // identifier here — `audit_events.workspace_id` is nullable and is set to
  // null when a workspace goes, so this is the only shape in which an entry the
  // outbox deliberately kept past its workspace's deletion can be published at
  // all.
  metadata: {
    ...entry.metadata,
    eventId: entry.eventId,
    ...(entry.deletedWorkspaceId === null ? {} : { deletedWorkspaceId: entry.deletedWorkspaceId }),
  },
});

/**
 * Claims a batch, publishes it outside any transaction, then acknowledges what
 * landed.
 *
 * Publishing under the claim's own transaction is the shape this avoids: the
 * audit store is the same database, so the publisher needs a second pooled
 * connection while the claim holds the first — a one-connection pool deadlocks
 * immediately and a larger one is exhausted by enough dispatchers — and the
 * claim's row locks would be held across whatever latency the publisher has.
 *
 * What that costs is exactly-once delivery, which the outbox never had: a
 * publish that succeeded and whose acknowledgement did not commit is published
 * again. Every event carries a stable id for the sink to recognise it by, and
 * at-least-once is the side to be wrong on when the subject is what became of
 * an operator's own record of events.
 */
export const createAuditOutboxDispatcher = (
  options: AuditOutboxDispatcherOptions,
): AuditOutboxDispatcher => {
  const { repository, auditPort, logger } = options;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;

  return {
    async drain(input): Promise<AuditOutboxDrainResult> {
      const batchSize = input?.batchSize ?? DEFAULT_BATCH_SIZE;
      const claim = await repository.claim({ limit: batchSize, leaseSeconds });
      if (claim.entries.length === 0) return { published: 0, failed: 0, remaining: false };

      const published: string[] = [];
      let failed = 0;

      for (const entry of claim.entries) {
        try {
          await auditPort.record(toAuditEvent(entry));
          published.push(entry.eventId);
        } catch {
          // The lease keeps this entry out of other claims until it expires, and
          // the next pass reclaims it. One publisher failure does not abandon
          // the rest of the batch.
          failed += 1;
          logger.warn(
            {
              eventId: entry.eventId,
              eventType: entry.eventType,
              workspaceId: entry.workspaceId,
              attempt: entry.attemptCount,
            },
            "audit outbox entry failed to publish",
          );
        }
      }

      await repository.acknowledge({ claimToken: claim.claimToken, eventIds: published });

      return {
        published: published.length,
        failed,
        remaining: claim.entries.length === batchSize,
      };
    },
  };
};
