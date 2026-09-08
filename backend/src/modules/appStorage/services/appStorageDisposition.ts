import { MAX_RETENTION_DAYS, validateRetentionDeadline } from "../domain/retention.js";
import {
  classifyStorageFailure,
  storageFailure,
  storageSuccess,
  type AppStorageResult,
} from "../domain/results.js";
import type { AppStorageAuditIntent, AppStorageAuditPort } from "../ports/appStorageAudit.js";
import type {
  AppStorageExportSnapshot,
  AppStorageInstallationScope,
  AppStorageRepositoryPort,
  ExportedAppStorageRecord,
} from "../ports/appStorageRepository.js";
import type {
  AppStorageAuditDrainResult,
  AppStorageDeletionSummary,
  AppStorageDisposition,
  AppStorageExportAdmission,
  AppStorageExportEvent,
} from "../ports/appStorageService.js";

interface AppStorageDispositionOptions {
  repository: AppStorageRepositoryPort;
  audit: AppStorageAuditPort;
  now?: () => Date;
  /** Rows read per round trip while an export streams; never the whole installation at once. */
  exportBatchSize?: number;
  /** How long an admitted export may sit unread before its snapshot is aborted. */
  exportIdleTimeoutMs?: number;
  /** Outbox entries one drain publishes, so a backlog is worked in passes rather than in one call. */
  auditDrainLimit?: number;
  /** How long a claimed batch stays this drain's before another pass may retry it. */
  auditLeaseSeconds?: number;
}

const DEFAULT_EXPORT_BATCH_SIZE = 200;
const DEFAULT_AUDIT_DRAIN_LIMIT = 200;

/**
 * How long a claimed batch of audit events stays this drain's. It has to outlast
 * a slow publisher and expire soon enough that a drain that died does not hold
 * the trail back for long.
 */
const DEFAULT_AUDIT_LEASE_SECONDS = 60;

/**
 * One line of the export. The shape is the App's own vocabulary — the collection
 * it declared, the key it chose, the record it wrote — rather than the physical
 * row, because the physical model is Radioso's and replaceable.
 */
const toExportLine = (record: ExportedAppStorageRecord): AppStorageExportEvent => ({
  kind: "line",
  collectionId: record.collectionId,
  line: JSON.stringify({
    collection: record.collectionId,
    key: record.key,
    version: record.version,
    schemaVersion: record.schemaVersion,
    updatedAt: record.updatedAt.toISOString(),
    record: record.value,
  }),
});

const tombstoned = <TValue>(): AppStorageResult<TValue> =>
  storageFailure("denied", "This installation's storage is deleted");

/**
 * The operator's side of managed App data. Disabling or quarantining an App takes
 * away its runtime access without touching a record; removing one requires the
 * operator to say what happens to the data — hand it back, hold it for a bounded
 * period, or delete it.
 *
 * What every method here returns describes what committed, and only that. An
 * irreversible change and the audit intent that describes it are written in one
 * transaction by the repository, so the trail cannot disagree with the data: a
 * deletion that committed always has its event, and an event never describes one
 * that rolled back. Publishing the events is `drainAuditOutbox`'s job afterwards,
 * which is why a publisher that is down costs a retry rather than the record of
 * what happened — and why a disposition never reports a failure for an effect
 * that already landed.
 *
 * Events that describe no state change of their own — an export was asked for,
 * a deadline was outside policy, a consumer stopped mid-stream — go through the
 * same outbox, so the trail is published in the order the operator's actions
 * committed.
 */
export const createAppStorageDisposition = (
  options: AppStorageDispositionOptions,
): AppStorageDisposition => {
  const { repository, audit } = options;
  const clock = options.now ?? ((): Date => new Date());
  const batchSize = options.exportBatchSize ?? DEFAULT_EXPORT_BATCH_SIZE;
  const drainLimit = options.auditDrainLimit ?? DEFAULT_AUDIT_DRAIN_LIMIT;
  const leaseSeconds = options.auditLeaseSeconds ?? DEFAULT_AUDIT_LEASE_SECONDS;

  const attempt = async <TValue>(
    operation: () => Promise<AppStorageResult<TValue>>,
  ): Promise<AppStorageResult<TValue>> => {
    try {
      return await operation();
    } catch (error) {
      return classifyStorageFailure(error);
    }
  };

  const enqueue = async (
    scope: AppStorageInstallationScope,
    intent: AppStorageAuditIntent,
  ): Promise<void> => {
    await repository.enqueueAuditEvent({ scope, intent });
  };

  /**
   * Records an intent alongside a result the caller has already decided, and
   * classifies its own failure instead of raising it.
   *
   * A secondary audit write must never replace a primary answer. An export that
   * was refused, a retention deadline outside policy, a deletion that failed —
   * each of those is what the caller has to be told, and letting the enqueue
   * rejection propagate would substitute "the outbox is unreachable" for it. The
   * enqueue failure is not lost either: it stays on this side of the boundary as
   * a classified result the caller may inspect.
   */
  const enqueueBeside = async (
    scope: AppStorageInstallationScope,
    intent: AppStorageAuditIntent,
  ): Promise<AppStorageResult<void>> =>
    attempt(async () => {
      await enqueue(scope, intent);
      return storageSuccess(undefined);
    });

  return {
    async revokeAccess(scope: AppStorageInstallationScope): Promise<AppStorageResult<void>> {
      return attempt(async () => {
        const applied = await repository.setAccessRevoked(scope, clock());
        return applied.admitted ? storageSuccess(undefined) : tombstoned();
      });
    },

    /**
     * Hands the App its storage back, unless a retention hold stands. The
     * repository decides that while holding the state row rather than trusting a
     * check made here: an App reading and writing data the retention sweep is
     * going to destroy is precisely the state the hold exists to prevent.
     */
    async restoreAccess(scope: AppStorageInstallationScope): Promise<AppStorageResult<void>> {
      return attempt(async () => {
        const applied = await repository.setAccessRevoked(scope, null);
        if (!applied.admitted) return tombstoned();
        if (applied.value.outcome === "retention_active") {
          return storageFailure(
            "denied",
            "This installation's storage is held for retention; cancel the hold before restoring access",
          );
        }
        return storageSuccess(undefined);
      });
    },

    /**
     * Whether an export may run is answered once, before a record is read, and it
     * is an ordinary result: a tombstoned installation is refused rather than
     * handed an empty file that looks like all of its data.
     *
     * After that comes the data, read inside one snapshot so every line belongs to
     * one database state. A failure part-way through is a line of its own — a
     * stream that simply stopped would be indistinguishable from one that
     * finished, and the difference is whether the operator has all of the
     * customer's data or some of it.
     */
    async export(scope: AppStorageInstallationScope): Promise<AppStorageExportAdmission> {
      // The request is recorded before the snapshot is admitted rather than
      // after, so an export nobody ever reads still leaves the operator's
      // request in the trail.
      const requested = await enqueueBeside(scope, {
        eventType: "app.data.export.requested",
        eventStatus: "success",
        metadata: {},
      });
      if (!requested.ok) return { ok: false, error: requested.error };

      const admitted = await attempt(async () => {
        const opened = await repository.openInstallationExport({
          scope,
          batchSize,
          ...(options.exportIdleTimeoutMs === undefined
            ? {}
            : { idleTimeoutMs: options.exportIdleTimeoutMs }),
        });
        return opened.admitted ? storageSuccess(opened.value) : tombstoned<AppStorageExportSnapshot>();
      });

      if (!admitted.ok) {
        // The cancellation belongs in the trail, but the refusal above is what
        // the caller asked about; an outbox that is unreachable must not answer
        // in its place.
        await enqueueBeside(scope, {
          eventType: "app.data.export.cancelled",
          eventStatus: "failure",
          metadata: { recordCount: 0, collectionCount: 0, reason: admitted.error.code },
        });
        return { ok: false, error: admitted.error };
      }

      const snapshot = admitted.value;

      async function* stream(): AsyncIterable<AppStorageExportEvent> {
        const collections = new Set<string>();
        let recordCount = 0;
        let settled = false;

        const closing = (reason: string | null): AppStorageAuditIntent => ({
          eventType: reason === null ? "app.data.export.completed" : "app.data.export.cancelled",
          eventStatus: reason === null ? "success" : "failure",
          metadata: { recordCount, collectionCount: collections.size, ...(reason ? { reason } : {}) },
        });

        try {
          try {
            // Reading is what opens the database snapshot; admission opened
            // nothing, so an export that is never consumed holds nothing.
            for await (const record of snapshot.read()) {
              collections.add(record.collectionId);
              recordCount += 1;
              yield toExportLine(record);
            }
          } catch (error) {
            // A read that failed part-way is a line of its own. A stream that
            // simply stopped would be indistinguishable from one that finished,
            // and the difference is whether the operator has all of the
            // customer's data or some of it.
            const failure = classifyStorageFailure(error);
            settled = true;
            await enqueueBeside(scope, closing(failure.error.code));
            yield { kind: "error", error: failure.error };
            return;
          }

          settled = true;
          // The trail entry is written where it can still be reported. A
          // completed export whose event did not land is an export the operator
          // cannot prove happened, so it is said out loud rather than dropped.
          const recorded = await enqueueBeside(scope, closing(null));
          if (!recorded.ok) yield { kind: "error", error: recorded.error };
        } finally {
          // The consumer walked away mid-stream. There is no line left to hand
          // it, so the cancellation goes to the trail and the snapshot is closed
          // rather than left to its idle timeout.
          if (!settled) await enqueueBeside(scope, closing("consumer_stopped"));
          await snapshot.close().catch(() => undefined);
        }
      }

      return {
        ok: true,
        snapshot: {
          stream,
          close: async (): Promise<void> => {
            await snapshot.close();
          },
        },
      };
    },

    /**
     * Holds the data for a bounded period. Retained data is data the App may no
     * longer reach, so the repository revokes access in the same transaction when
     * it is not already revoked: a hold whose data stayed live would be deleted
     * out from under a running App when the deadline passed.
     */
    async retain(
      input: AppStorageInstallationScope & { until: Date },
    ): Promise<AppStorageResult<{ retainUntil: Date }>> {
      const { until, ...scope } = input;
      const deadline = validateRetentionDeadline(until, clock());

      if (!deadline.ok) {
        // The refusal is the answer; recording it must not become one.
        await enqueueBeside(scope, {
          eventType: "app.data.retention.changed",
          eventStatus: "failure",
          metadata: { reason: deadline.reason, maxRetentionDays: MAX_RETENTION_DAYS },
        });
        return storageFailure(
          "invalid_input",
          `A retention deadline is a future instant at most ${MAX_RETENTION_DAYS} days away`,
        );
      }

      return attempt(async () => {
        const applied = await repository.setRetention({
          scope,
          retainUntil: deadline.until,
          audit: (state) => ({
            eventType: "app.data.retention.changed",
            eventStatus: "success",
            metadata: {
              retainUntil: state.retainUntil.toISOString(),
              accessRevokedAt: state.accessRevokedAt.toISOString(),
            },
          }),
        });

        if (!applied.admitted) return tombstoned();
        return storageSuccess({ retainUntil: applied.value.retainUntil });
      });
    },

    /**
     * Lifts the hold and says so in the trail. Access stays revoked: ending a
     * scheduled destruction and giving the App its data back are two decisions,
     * and cancelling a hold that silently re-enabled a disabled App would be the
     * operator making the second one without saying so.
     */
    async cancelRetention(
      scope: AppStorageInstallationScope,
    ): Promise<AppStorageResult<{ retainUntil: Date | null }>> {
      return attempt(async () => {
        const cleared = await repository.cancelRetention({
          scope,
          audit: (state) => ({
            eventType: "app.data.retention.changed",
            eventStatus: "success",
            metadata: { cancelled: true, retainUntil: state.retainUntil.toISOString() },
          }),
        });

        if (!cleared.admitted) return tombstoned();
        return storageSuccess({ retainUntil: cleared.value.retainUntil });
      });
    },

    /**
     * Removes the installation's data and leaves a tombstone. A repeat answers the
     * same way rather than refusing: deletion is irreversible and its caller may
     * have lost the first response to a crashed process or a retried job, so the
     * counts live on the tombstone and are given back as often as they are asked
     * for. The completion event is written by the transaction that did the work,
     * so only the first of those calls adds one to the trail.
     *
     * A deletion that did not commit leaves a failure of its own. The trail is
     * how an operator answers what became of the data, and a trail showing a
     * deletion requested and nothing afterwards cannot distinguish a deletion
     * that failed from one whose event was never written.
     */
    async deleteInstallationStorage(
      scope: AppStorageInstallationScope,
    ): Promise<AppStorageResult<AppStorageDeletionSummary>> {
      const requested = await enqueueBeside(scope, {
        eventType: "app.data.deletion.requested",
        eventStatus: "success",
        metadata: {},
      });
      if (!requested.ok) return requested;

      const removed = await attempt(async () =>
        storageSuccess(
          await repository.deleteInstallationRecords({
            scope,
            audit: (summary) => ({
              eventType: "app.data.deletion.completed",
              eventStatus: "success",
              metadata: {
                recordCount: summary.recordCount,
                collectionCount: summary.collectionCount,
              },
            }),
          }),
        ),
      );

      if (!removed.ok) {
        await enqueueBeside(scope, {
          eventType: "app.data.deletion.completed",
          eventStatus: "failure",
          metadata: { reason: removed.error.code },
        });
        return removed;
      }

      return storageSuccess({
        recordCount: removed.value.recordCount,
        collectionCount: removed.value.collectionCount,
      });
    },

    /**
     * Leases a batch, publishes it outside any transaction, then acknowledges
     * what landed.
     *
     * Publishing under the claim's own transaction is the shape this avoids: the
     * audit store is the same database, so the sink needs a second pooled
     * connection while the first is held — a one-connection pool deadlocks
     * immediately and a larger one is exhausted by enough drainers — and the
     * claim's row locks would be held across whatever latency the publisher has.
     *
     * What that costs is exactly-once delivery, which the outbox never had:
     * a publish that succeeded and whose acknowledgement did not commit is
     * published again. Every event carries a stable id for the sink to recognise
     * it by, and at-least-once is the side to be wrong on when the subject is
     * what became of customer data.
     */
    async drainAuditOutbox(): Promise<AppStorageAuditDrainResult> {
      const claim = await repository.claimAuditOutboxBatch({
        limit: drainLimit,
        leaseSeconds: leaseSeconds,
      });
      if (claim.entries.length === 0) return { publishedCount: 0, failureCount: 0 };

      const published: string[] = [];
      let failureCount = 0;

      for (const entry of claim.entries) {
        try {
          await audit.record(entry);
          published.push(entry.eventId);
        } catch {
          // The lease keeps this entry out of other drains until it expires, and
          // the next pass reclaims it. One publisher failure does not abandon the
          // rest of the batch.
          failureCount += 1;
        }
      }

      await repository.acknowledgeAuditOutbox({
        claimToken: claim.claimToken,
        eventIds: published,
      });

      return { publishedCount: published.length, failureCount };
    },
  };
};
