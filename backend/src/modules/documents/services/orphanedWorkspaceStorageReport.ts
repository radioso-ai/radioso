import {
  isCanonicalWorkspaceId,
  type DocumentStorageInventoryPort,
  type DocumentStorageOwnersPort,
} from "../contracts/storage.js";
import { RECENT_OBJECT_WINDOW_MS } from "./workspaceStoragePurge.js";

/** Workspaces one listing page returns. */
const REPORT_PAGE_SIZE = 100;
/** Workspaces holding uploaded files that the ownership check looks for in the store. */
const OWNERSHIP_SAMPLE_SIZE = 20;

/** Whether the store holds this database's files, which queueing an orphan sweep requires. */
type DocumentStorageOwnershipCheck = "verified" | "no_uploaded_files" | "store_mismatch";

interface ReportDependencies {
  storage: Pick<DocumentStorageInventoryPort, "listStoredWorkspaces" | "listWorkspaceObjects" | "summarizeWorkspaceObjects">;
  owners: DocumentStorageOwnersPort;
  now?: () => Date;
  pageSize?: number;
}

const checkDocumentStorageOwnership = async (
  deps: Pick<ReportDependencies, "storage" | "owners">,
): Promise<DocumentStorageOwnershipCheck> => {
  const known = await deps.owners.workspacesWithUploadedFiles(OWNERSHIP_SAMPLE_SIZE);
  if (known.length === 0) return "no_uploaded_files";
  for (const workspaceId of known) {
    if ((await deps.storage.listWorkspaceObjects({ workspaceId, limit: 1 })).length > 0) return "verified";
  }
  return "store_mismatch";
};

/**
 * The workspaces document storage holds files for that this database no longer has, and why every
 * other prefix is kept. An operator reads it as a dry run, then queues one orphan-sweep purge per
 * workspace in `orphanedWorkspaceIds` (`src/app/cli/workspaceStorageSweepCommand.ts`).
 *
 * It cannot tell a workspace this database deleted from one another database owns. The ownership
 * check proves only that the store holds some of this database's files, so a store shared with
 * another deployment passes it, and that deployment's workspaces read as orphaned: each deployment
 * needs its own bucket or folder. A prefix written to in the last 24 hours is kept as in use, and a
 * prefix that is not a canonical lowercase workspace id is never counted as an orphan.
 */
export interface OrphanedWorkspaceStorageReport {
  ownership: DocumentStorageOwnershipCheck;
  scannedPrefixCount: number;
  /** In the order the store listed them. Never printed: the operator reviews counts. */
  orphanedWorkspaceIds: string[];
  orphanedObjectCount: number;
  liveWorkspaceCount: number;
  recentObjectCount: number;
  nonCanonicalPrefixCount: number;
}

/** Reads the whole store and deletes nothing; its reads grow with what the store holds. */
export const reportOrphanedWorkspaceStorage = async (deps: ReportDependencies): Promise<OrphanedWorkspaceStorageReport> => {
  const recentSince = (deps.now ?? (() => new Date()))().getTime() - RECENT_OBJECT_WINDOW_MS;
  const report: OrphanedWorkspaceStorageReport = {
    ownership: await checkDocumentStorageOwnership(deps),
    scannedPrefixCount: 0,
    orphanedWorkspaceIds: [],
    orphanedObjectCount: 0,
    liveWorkspaceCount: 0,
    recentObjectCount: 0,
    nonCanonicalPrefixCount: 0,
  };
  let cursor: string | null = null;
  do {
    const listing = await deps.storage.listStoredWorkspaces({ cursor, limit: deps.pageSize ?? REPORT_PAGE_SIZE });
    const canonical = listing.workspaceIds.filter(isCanonicalWorkspaceId);
    const existing = await deps.owners.existingWorkspaceIds(canonical);
    report.scannedPrefixCount += listing.workspaceIds.length;
    report.nonCanonicalPrefixCount += listing.workspaceIds.length - canonical.length;
    report.liveWorkspaceCount += existing.size;
    for (const workspaceId of canonical) {
      if (existing.has(workspaceId)) continue;
      const summary = await deps.storage.summarizeWorkspaceObjects({ workspaceId });
      if (summary.newestObjectAt !== null && summary.newestObjectAt.getTime() > recentSince) {
        report.recentObjectCount += 1;
      } else {
        report.orphanedWorkspaceIds.push(workspaceId);
        report.orphanedObjectCount += summary.objectCount;
      }
    }
    cursor = listing.nextCursor;
  } while (cursor !== null);
  return report;
};
