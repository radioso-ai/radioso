import { MAX_RETENTION_DAYS, validateRetentionDeadline } from "../domain/retention.js";
import {
  classifyStorageFailure,
  storageFailure,
  storageSuccess,
  type AppStorageResult,
} from "../domain/results.js";
import type { AppStorageAuditPort } from "../ports/appStorageAudit.js";
import type {
  AppStorageInstallationScope,
  AppStorageRepositoryPort,
  ExportedAppStorageRecord,
} from "../ports/appStorageRepository.js";
import type {
  AppStorageDeletionSummary,
  AppStorageDisposition,
  AppStorageExportLine,
} from "../ports/appStorageService.js";

interface AppStorageDispositionOptions {
  repository: AppStorageRepositoryPort;
  audit: AppStorageAuditPort;
  now?: () => Date;
  /** Rows read per round trip while an export streams; never the whole installation at once. */
  exportBatchSize?: number;
}

const DEFAULT_EXPORT_BATCH_SIZE = 200;

/**
 * One line of the export. The shape is the App's own vocabulary — the collection
 * it declared, the key it chose, the record it wrote — rather than the physical
 * row, because the physical model is Radioso's and replaceable.
 */
const toExportLine = (record: ExportedAppStorageRecord): AppStorageExportLine => ({
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
 * Every step leaves an audit event carrying identities and counts, and the events
 * record what did not happen as well as what did. A disposition is the moment
 * customer data moves or disappears, so a trail that shows only the successful
 * half cannot answer where the data went.
 */
export const createAppStorageDisposition = (
  options: AppStorageDispositionOptions,
): AppStorageDisposition => {
  const { repository, audit } = options;
  const clock = options.now ?? ((): Date => new Date());
  const batchSize = options.exportBatchSize ?? DEFAULT_EXPORT_BATCH_SIZE;

  const attempt = async <TValue>(
    operation: () => Promise<AppStorageResult<TValue>>,
  ): Promise<AppStorageResult<TValue>> => {
    try {
      return await operation();
    } catch (error) {
      return classifyStorageFailure(error);
    }
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
     * An export is only complete when its consumer has taken every line. A caller
     * that stops early, and a failure part-way through, leave a `cancelled` event
     * carrying what had been handed over — an operator asking whether the data
     * left the system needs the difference between "all of it" and "some of it".
     */
    async *exportRecords(scope: AppStorageInstallationScope): AsyncIterable<AppStorageExportLine> {
      await audit.record({
        workspaceId: scope.workspaceId,
        installationId: scope.installationId,
        eventType: "app.data.export.requested",
        eventStatus: "success",
        metadata: {},
      });

      const collections = new Set<string>();
      let recordCount = 0;
      let drained = false;

      try {
        for await (const record of repository.streamInstallationRecords({ scope, batchSize })) {
          collections.add(record.collectionId);
          recordCount += 1;
          yield toExportLine(record);
        }
        drained = true;
      } finally {
        await audit.record({
          workspaceId: scope.workspaceId,
          installationId: scope.installationId,
          eventType: drained ? "app.data.export.completed" : "app.data.export.cancelled",
          eventStatus: drained ? "success" : "failure",
          metadata: { recordCount, collectionCount: collections.size },
        });
      }
    },

    async retain(
      input: AppStorageInstallationScope & { until: Date },
    ): Promise<AppStorageResult<{ retainUntil: Date }>> {
      const { until, ...scope } = input;
      const deadline = validateRetentionDeadline(until, clock());

      if (!deadline.ok) {
        await audit.record({
          workspaceId: scope.workspaceId,
          installationId: scope.installationId,
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
        const applied = await repository.setRetention(scope, deadline.until);
        if (!applied.admitted) return tombstoned();

        await audit.record({
          workspaceId: scope.workspaceId,
          installationId: scope.installationId,
          eventType: "app.data.retention.changed",
          eventStatus: "success",
          metadata: { retainUntil: deadline.until.toISOString() },
        });

        return storageSuccess({ retainUntil: deadline.until });
      });
    },

    async deleteInstallationStorage(
      scope: AppStorageInstallationScope,
    ): Promise<AppStorageResult<AppStorageDeletionSummary>> {
      await audit.record({
        workspaceId: scope.workspaceId,
        installationId: scope.installationId,
        eventType: "app.data.deletion.requested",
        eventStatus: "success",
        metadata: {},
      });

      const result = await attempt(async () => {
        const removed = await repository.deleteInstallationRecords(scope);
        return removed.admitted ? storageSuccess(removed.value) : tombstoned<AppStorageDeletionSummary>();
      });

      await audit.record({
        workspaceId: scope.workspaceId,
        installationId: scope.installationId,
        eventType: "app.data.deletion.completed",
        eventStatus: result.ok ? "success" : "failure",
        metadata: result.ok
          ? { recordCount: result.value.recordCount, collectionCount: result.value.collectionCount }
          : { reason: result.error.code },
      });

      return result;
    },

    async deleteWorkspaceStorage(input: {
      workspaceId: string;
    }): Promise<{ recordCount: number; installationCount: number }> {
      await audit.record({
        workspaceId: input.workspaceId,
        installationId: null,
        eventType: "app.data.deletion.requested",
        eventStatus: "success",
        metadata: { scope: "workspace" },
      });

      try {
        const summary = await repository.deleteWorkspaceRecords(input.workspaceId);

        await audit.record({
          workspaceId: input.workspaceId,
          installationId: null,
          eventType: "app.data.deletion.completed",
          eventStatus: "success",
          metadata: {
            scope: "workspace",
            recordCount: summary.recordCount,
            installationCount: summary.installationCount,
          },
        });

        return summary;
      } catch (error) {
        await audit.record({
          workspaceId: input.workspaceId,
          installationId: null,
          eventType: "app.data.deletion.completed",
          eventStatus: "failure",
          metadata: { scope: "workspace" },
        });
        throw error;
      }
    },
  };
};
