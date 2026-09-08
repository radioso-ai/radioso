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
  /** Outbox entries one drain publishes, so a backlog is worked in passes rather than in one call. */
  auditDrainLimit?: number;
}

const DEFAULT_EXPORT_BATCH_SIZE = 200;
const DEFAULT_AUDIT_DRAIN_LIMIT = 200;

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

  return {
    async revokeAccess(scope: AppStorageInstallationScope): Promise<AppStorageResult<void>> {
      return attempt(async () => {
        const applied = await repository.setAccessRevoked(scope, clock());
        return applied.admitted ? storageSuccess(undefined) : tombstoned();
      });
    },

    async restoreAccess(scope: AppStorageInstallationScope): Promise<AppStorageResult<void>> {
      return attempt(async () => {
        const applied = await repository.setAccessRevoked(scope, null);
        return applied.admitted ? storageSuccess(undefined) : tombstoned();
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
      // The request is recorded before the snapshot is opened rather than after.
      // Admission holds a transaction open for the life of the stream, and an
      // audit write that failed after it was opened would have to abandon one.
      const requested = await attempt(async () => {
        await enqueue(scope, {
          eventType: "app.data.export.requested",
          eventStatus: "success",
          metadata: {},
        });
        return storageSuccess(undefined);
      });
      if (!requested.ok) return { ok: false, error: requested.error };

      const admitted = await attempt(async () => {
        const opened = await repository.openInstallationExport({ scope, batchSize });
        return opened.admitted ? storageSuccess(opened.value) : tombstoned<AppStorageExportSnapshot>();
      });

      if (!admitted.ok) {
        await enqueue(scope, {
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
            for await (const record of snapshot.records) {
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
            await enqueue(scope, closing(failure.error.code));
            yield { kind: "error", error: failure.error };
            return;
          }

          settled = true;
          // The trail entry is written where it can still be reported. A
          // completed export whose event did not land is an export the operator
          // cannot prove happened, so it is said out loud rather than dropped.
          const recorded = await attempt(async () => {
            await enqueue(scope, closing(null));
            return storageSuccess(undefined);
          });
          if (!recorded.ok) yield { kind: "error", error: recorded.error };
        } finally {
          // The consumer walked away mid-stream. There is no line left to hand
          // it, so the cancellation goes to the trail and any failure to record
          // it surfaces at the caller's own `break`.
          if (!settled) await enqueue(scope, closing("consumer_stopped"));
        }
      }

      return { ok: true, stream: stream() };
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
        await enqueue(scope, {
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
     * Removes the installation's data and leaves a tombstone. A repeat answers the
     * same way rather than refusing: deletion is irreversible and its caller may
     * have lost the first response to a crashed process or a retried job, so the
     * counts live on the tombstone and are given back as often as they are asked
     * for. The completion event is written by the transaction that did the work,
     * so only the first of those calls adds one to the trail.
     */
    async deleteInstallationStorage(
      scope: AppStorageInstallationScope,
    ): Promise<AppStorageResult<AppStorageDeletionSummary>> {
      return attempt(async () => {
        await enqueue(scope, {
          eventType: "app.data.deletion.requested",
          eventStatus: "success",
          metadata: {},
        });

        const removed = await repository.deleteInstallationRecords({
          scope,
          audit: (summary) => ({
            eventType: "app.data.deletion.completed",
            eventStatus: "success",
            metadata: {
              recordCount: summary.recordCount,
              collectionCount: summary.collectionCount,
            },
          }),
        });

        return storageSuccess({
          recordCount: removed.recordCount,
          collectionCount: removed.collectionCount,
        });
      });
    },

    async drainAuditOutbox(): Promise<{ publishedCount: number }> {
      const publishedCount = await repository.drainAuditOutbox({
        limit: drainLimit,
        publish: (event) => audit.record(event),
      });
      return { publishedCount };
    },
  };
};
