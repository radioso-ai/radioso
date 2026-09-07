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

/**
 * The operator's side of managed App data. Disabling or quarantining an App takes
 * away its runtime access without touching a record; removing one requires the
 * operator to say what happens to the data — hand it back, hold it for a bounded
 * period, or delete it.
 *
 * Every step leaves an audit event carrying identities and counts. A disposition
 * is the moment customer data moves or disappears, so the trail has to show that
 * it happened without becoming a second copy of what was in it.
 */
export const createAppStorageDisposition = (
  options: AppStorageDispositionOptions,
): AppStorageDisposition => {
  const { repository, audit } = options;
  const clock = options.now ?? ((): Date => new Date());
  const batchSize = options.exportBatchSize ?? DEFAULT_EXPORT_BATCH_SIZE;

  return {
    async revokeAccess(scope: AppStorageInstallationScope): Promise<void> {
      await repository.setAccessRevoked(scope, clock());
    },

    async restoreAccess(scope: AppStorageInstallationScope): Promise<void> {
      await repository.setAccessRevoked(scope, null);
    },

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

      for await (const record of repository.streamInstallationRecords({ scope, batchSize })) {
        collections.add(record.collectionId);
        recordCount += 1;
        yield toExportLine(record);
      }

      await audit.record({
        workspaceId: scope.workspaceId,
        installationId: scope.installationId,
        eventType: "app.data.export.completed",
        eventStatus: "success",
        metadata: { recordCount, collectionCount: collections.size },
      });
    },

    async retain(input: AppStorageInstallationScope & { until: Date }): Promise<void> {
      const { until, ...scope } = input;
      await repository.setRetention(scope, until);
      await audit.record({
        workspaceId: scope.workspaceId,
        installationId: scope.installationId,
        eventType: "app.data.retention.changed",
        eventStatus: "success",
        metadata: { retainUntil: until.toISOString() },
      });
    },

    async deleteInstallationStorage(
      scope: AppStorageInstallationScope,
    ): Promise<AppStorageDeletionSummary> {
      await audit.record({
        workspaceId: scope.workspaceId,
        installationId: scope.installationId,
        eventType: "app.data.deletion.requested",
        eventStatus: "success",
        metadata: {},
      });

      const summary = await repository.deleteInstallationRecords(scope);

      await audit.record({
        workspaceId: scope.workspaceId,
        installationId: scope.installationId,
        eventType: "app.data.deletion.completed",
        eventStatus: "success",
        metadata: { recordCount: summary.recordCount, collectionCount: summary.collectionCount },
      });

      return summary;
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
    },
  };
};
